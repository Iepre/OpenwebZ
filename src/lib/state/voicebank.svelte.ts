import { downloadBlob } from '#lib/io/download';
import type { Track } from '#lib/core/types';
import { AliasIndex } from '#lib/voicebank/alias-index';
import {
	getRememberedActiveId,
	setRememberedActiveId,
	voicebankLibrary,
	type SavedVoicebankMeta
} from '#lib/voicebank/library';
import { loadFromEntry, loadFromFileList, loadVoicebankFromUrl } from '#lib/voicebank/loader';
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
	/** Increments whenever the in-memory cache of per-track voicebanks updates. */
	cacheRevision = $state(0);
	warmingUp = $state(false);
	/** Called after a voicebank was loaded (other modules react without this one knowing them). */
	readonly loadedListeners: (() => void)[] = [];

	private initialized = false;
	private bankCache = new Map<string, Voicebank>();
	private pendingLoads = new Map<string, Promise<Voicebank | null>>();
	private aliasIndexes = new WeakMap<Voicebank, AliasIndex>();

	constructor() {
		onEngineStats((s) => (this.stats = s));
	}

	aliases = $derived(this.current?.aliases ?? []);

	/** Builds or retrieves a cached AliasIndex for any loaded voicebank. */
	indexFor(vb: Voicebank | null): AliasIndex | null {
		if (!vb || !vb.aliases.length) return null;
		let cached = this.aliasIndexes.get(vb);
		if (!cached) {
			cached = new AliasIndex(
				vb.aliases,
				vb.prefixMap ? new TextDecoder().decode(vb.prefixMap) : null
			);
			this.aliasIndexes.set(vb, cached);
		}
		return cached;
	}

	/** What the loaded voicebank can sing, for matching lyrics (null while none is loaded). */
	index = $derived.by(() => this.indexFor(this.current));

	private matchBank(ref: string, vb: Voicebank): boolean {
		const q = ref.trim().toLowerCase();
		return Boolean(q) && (vb.id.toLowerCase() === q || vb.name.trim().toLowerCase() === q);
	}

	/** Finds metadata in the remembered library matching an id or voicebank name. */
	findMeta(singerRef?: string): SavedVoicebankMeta | null {
		const ref = singerRef?.trim();
		if (!ref) return null;
		const q = ref.toLowerCase();
		return (
			this.library.find((b) => b.id === ref) ??
			this.library.find((b) => b.name.trim().toLowerCase() === q) ??
			null
		);
	}

	/** Human-readable label for a track's assigned singer (or active voicebank fallback). */
	singerLabel(singerRef?: string): string {
		const ref = singerRef?.trim();
		if (!ref) return this.current?.name ?? 'Active voicebank';
		if (this.current && this.matchBank(ref, this.current)) return this.current.name;
		for (const cached of this.bankCache.values()) {
			if (this.matchBank(ref, cached)) return cached.name;
		}
		return this.findMeta(ref)?.name ?? ref;
	}

	/** Synchronous lookup for the voicebank assigned to a track (preloading if stored in library). */
	effectiveBankForTrack(track?: Pick<Track, 'singer'> | null): Voicebank | null {
		void this.cacheRevision;
		const ref = track?.singer?.trim();
		if (!ref) return this.current;
		if (this.current && this.matchBank(ref, this.current)) return this.current;
		for (const cached of this.bankCache.values()) {
			if (this.matchBank(ref, cached)) return cached;
		}
		const meta = this.findMeta(ref);
		if (meta) void this.resolveBank(meta.id);
		return this.current;
	}

	/** Resolves and loads a singer (by voicebank id or name) into the in-memory cache. */
	async resolveBank(singerRef?: string): Promise<Voicebank | null> {
		const ref = singerRef?.trim();
		if (!ref) return this.current;
		if (this.current && this.matchBank(ref, this.current)) return this.current;
		for (const cached of this.bankCache.values()) {
			if (this.matchBank(ref, cached)) return cached;
		}
		const meta = this.findMeta(ref);
		if (!meta) return null;
		const inCache = this.bankCache.get(meta.id);
		if (inCache) return inCache;

		let pending = this.pendingLoads.get(meta.id);
		if (!pending) {
			pending = voicebankLibrary
				.load(meta.id)
				.then((vb) => {
					if (vb) {
						this.bankCache.set(vb.id, vb);
						this.cacheRevision++;
					}
					return vb;
				})
				.finally(() => this.pendingLoads.delete(meta.id));
			this.pendingLoads.set(meta.id, pending);
		}
		return pending;
	}

	/** Preloads any remembered voicebanks referenced by project tracks. */
	async preloadTrackBanks(tracks: readonly Pick<Track, 'singer'>[]): Promise<void> {
		const refs = [...new Set(tracks.map((t) => t.singer?.trim()).filter(Boolean))] as string[];
		await Promise.all(refs.map((r) => this.resolveBank(r)));
	}

	/** Changes the singer assigned to a track and loads/switches to it when needed. */
	async setTrackSinger(trackId: string, singerRef: string) {
		const ref = singerRef.trim();
		const target = this.findMeta(ref)?.id ?? ref;
		project.updateTrack(trackId, { singer: target || undefined });
		if (!target) return;

		const vb = await this.resolveBank(target);
		if (vb && trackId === project.activeTrack && this.current?.id !== vb.id && !this.loading) {
			this.loading = true;
			try {
				await this.activate(vb, { save: false, silent: true });
			} finally {
				this.loading = false;
			}
		}
	}

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
		void this.preloadTrackBanks(project.tracks);
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
		this.bankCache.set(vb.id, vb);
		this.cacheRevision++;
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
		this.bankCache.delete(id);
		this.cacheRevision++;
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
