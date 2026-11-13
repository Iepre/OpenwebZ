import { downloadBlob } from '#lib/io/download';
import { AliasIndex } from '#lib/voicebank/alias-index';
import {
	getRememberedActiveId,
	setRememberedActiveId,
	voicebankLibrary,
	type SavedVoicebankMeta
} from '#lib/voicebank/library';
import { loadFromEntry, loadFromFileList } from '#lib/voicebank/loader';
import {
	buildStarterVoicebank,
	loadVoicebankFromUrl,
	type StarterPresetId
} from '#lib/voicebank/starter';
import type { Voicebank } from '#lib/voicebank/types';
import type { AnalysisStats } from '#lib/engine/analysis';
import { getEngine, onEngineStats } from './engine';
import { project } from './project.svelte';
import { renderers } from './renderers';
import { settings } from './settings.svelte';
import { ui } from './ui.svelte';

const EMPTY_STATS: AnalysisStats = { total: 0, ready: 0, fromCache: 0, failed: 0, running: 0 };

class VoicebankState {
	current = $state.raw<Voicebank | null>(null);
	library = $state.raw<SavedVoicebankMeta[]>([]);
	loading = $state(false);
	stats = $state<AnalysisStats>(EMPTY_STATS);
	/** Changes whenever a different voicebank is loaded: invalidates rendered audio. */
	revision = $state(0);
	warmingUp = $state(false);
	/** Called after a voicebank was loaded (other modules react without this one knowing them). */
	readonly loadedListeners: (() => void)[] = [];

	private initialized = false;

	constructor() {
		onEngineStats((s) => (this.stats = s));
	}

	aliases = $derived(this.current?.aliases ?? []);
	/** What the loaded voicebank can sing, for matching lyrics (null while none is loaded). */
	index = $derived.by(() => {
		const vb = this.current;
		if (!vb || !vb.aliases.length) return null;
		return new AliasIndex(vb.aliases, vb.prefixMap ? new TextDecoder().decode(vb.prefixMap) : null);
	});

	async refreshLibrary() {
		this.library = await voicebankLibrary.list();
	}

	/** Loads the remembered voicebank list and optionally restores the last active voicebank. */
	async init(options: { autoRestore?: boolean } = {}) {
		if (this.initialized) return;
		this.initialized = true;
		await this.refreshLibrary();
		if (options.autoRestore === false || this.current || !this.library.length) return;

		const remembered = getRememberedActiveId();
		const target =
			(remembered ? this.library.find((b) => b.id === remembered) : null) ?? this.library[0];
		if (target) {
			await this.switchTo(target.id, { silent: true });
		}
	}

	private async activate(
		vb: Voicebank,
		options: { save?: boolean; sourceUrl?: string; silent?: boolean } = {}
	) {
		ui.setStatus('Parsing voicebank…');
		if (this.current?.image && this.current.id !== vb.id) {
			URL.revokeObjectURL(this.current.image);
		}
		const usable = renderers.all().filter((r) => r.supports(vb));
		if (!usable.length) throw new Error('No renderer can use this kind of voicebank.');
		for (const renderer of usable) await renderer.load(vb);

		this.current = vb;
		this.revision++;
		project.voicebankName = vb.name;
		setRememberedActiveId(vb.id);

		if (options.save !== false) {
			await voicebankLibrary.save(vb, options.sourceUrl).catch((err) => {
				console.warn('[voicebank] failed to persist voicebank in IndexedDB', err);
			});
		}
		await this.refreshLibrary();

		if (!options.silent) {
			ui.toast(
				`Voicebank “${vb.name}” loaded: ${vb.aliases.length} aliases` +
					(vb.generatedOto ? ' (oto.ini generated)' : ''),
				'success'
			);
		} else {
			ui.setStatus(`Restored voicebank “${vb.name}”.`);
		}

		for (const listener of this.loadedListeners) listener();

		if (settings.data.backgroundAnalysis) {
			this.warmingUp = true;
			(await getEngine()).warmUp(() => {
				this.warmingUp = false;
				ui.setStatus(`All samples of “${vb.name}” are analyzed.`);
			});
		}
	}

	async load(source: File[] | FileSystemEntry) {
		if (this.loading) return;
		this.loading = true;
		try {
			const status = (m: string) => ui.setStatus(m);
			if (
				Array.isArray(source) &&
				source.length > 1 &&
				source.every((f) => /\.zip$/i.test(f.name))
			) {
				let loaded = 0;
				for (const zipFile of source) {
					const vb = await loadFromFileList([zipFile], status);
					await this.activate(vb, { silent: true });
					loaded++;
				}
				ui.toast(
					`Loaded and remembered ${loaded} voicebanks. Active: “${this.current?.name}”.`,
					'success'
				);
				return;
			}
			const vb = Array.isArray(source)
				? await loadFromFileList(source, status)
				: await loadFromEntry(source, status);
			await this.activate(vb);
		} catch (error) {
			ui.error(error instanceof Error ? error.message : 'Failed to load the voicebank.');
		} finally {
			this.loading = false;
		}
	}

	async loadFromUrl(url: string) {
		if (this.loading) return;
		this.loading = true;
		try {
			const vb = await loadVoicebankFromUrl(url, (m) => ui.setStatus(m));
			await this.activate(vb, { sourceUrl: url.trim() });
		} catch (error) {
			ui.error(error instanceof Error ? error.message : 'Failed to download the voicebank.');
		} finally {
			this.loading = false;
		}
	}

	async installStarter(preset: StarterPresetId) {
		if (this.loading) return;
		this.loading = true;
		try {
			const vb = await buildStarterVoicebank(preset, (m) => ui.setStatus(m));
			await this.activate(vb);
		} catch (error) {
			ui.error(error instanceof Error ? error.message : 'Failed to create starter voicebank.');
		} finally {
			this.loading = false;
		}
	}

	async switchTo(id: string, options: { silent?: boolean } = {}) {
		if (this.loading) return;
		if (this.current?.id === id) return;
		this.loading = true;
		try {
			const vb = await voicebankLibrary.load(id);
			if (!vb) {
				await this.refreshLibrary();
				if (!options.silent) ui.error('Saved voicebank was not found in browser storage.');
				return;
			}
			await this.activate(vb, { save: false, silent: options.silent });
		} catch (error) {
			if (!options.silent) {
				ui.error(error instanceof Error ? error.message : 'Failed to switch voicebank.');
			}
		} finally {
			this.loading = false;
		}
	}

	async removeSaved(id: string) {
		const meta = this.library.find((b) => b.id === id);
		await voicebankLibrary.remove(id);
		try {
			const engine = await getEngine();
			await engine.cache?.deleteBank(id);
		} catch {
			/* ignore cache cleanup failures */
		}
		await this.refreshLibrary();

		if (this.current?.id === id) {
			if (this.current.image) URL.revokeObjectURL(this.current.image);
			this.current = null;
			this.revision++;
			if (this.library.length) {
				await this.switchTo(this.library[0].id, { silent: true });
			}
		}
		if (meta) ui.toast(`Removed “${meta.name}” from remembered voicebanks.`);
	}

	async exportSavedZip(id: string) {
		try {
			ui.setStatus('Packaging voicebank ZIP…');
			const out = await voicebankLibrary.exportZip(id);
			if (!out) {
				ui.error('Voicebank not found in library storage.');
				return;
			}
			downloadBlob(out.bytes, out.filename, 'application/zip');
			ui.toast(`Exported “${out.filename}”.`, 'success');
		} catch (error) {
			ui.error(error instanceof Error ? error.message : 'Failed to export voicebank.');
		}
	}

	async analyzeAll() {
		const engine = await getEngine();
		this.warmingUp = true;
		engine.warmUp(() => (this.warmingUp = false));
	}

	async stopAnalysis() {
		(await getEngine()).stopWarmUp();
		this.warmingUp = false;
	}
}

export const voicebank = new VoicebankState();
