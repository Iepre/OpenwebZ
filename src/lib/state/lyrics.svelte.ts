import { isSpecialLyric } from '#lib/core/lyric-syntax';
import type { Note } from '#lib/core/types';
import type { Candidate, Resolution } from '#lib/plugins/api';
import { resolveLyric } from '#lib/plugins/registry';
import type { Voicebank } from '#lib/voicebank/types';
import { plugins } from './plugins.svelte';
import { project } from './project.svelte';
import { settings } from './settings.svelte';
import { ui } from './ui.svelte';
import { voicebank } from './voicebank.svelte';

/** One lyric that the voicebank does not have, with every note that uses it. */
export interface MissingLyric {
	lyric: string;
	noteIds: string[];
	suggestions: Candidate[];
}

class LyricState {
	/** How each note's lyric resolves against its track's singer (empty without any loaded bank). */
	resolutions = $derived.by(() => {
		void plugins.version;
		void voicebank.cacheRevision;
		const byTrack = new Map(project.tracks.map((t) => [t.id, t]));
		const groups = new Map<Voicebank, Note[]>();
		for (const note of project.notes) {
			const vb = voicebank.effectiveBankForTrack(byTrack.get(note.track));
			if (!vb) continue;
			const list = groups.get(vb);
			if (list) list.push(note);
			else groups.set(vb, [note]);
		}
		const merged = new Map<string, Resolution>();
		for (const [vb, notes] of groups) {
			const index = voicebank.indexFor(vb);
			if (!index) continue;
			for (const [id, r] of plugins.resolver.resolveAll(notes, index)) {
				merged.set(id, r);
			}
		}
		return merged;
	});

	/** Notes that cannot be sung: their lyric is not in the track's voicebank and nothing maps to it. */
	missing = $derived.by(() => {
		const out = new Set<string>();
		for (const [id, r] of this.resolutions) if (r.status === 'missing') out.add(id);
		return out as ReadonlySet<string>;
	});

	/** The alias to hand to the engine for a note: what its lyric resolves to, else the lyric itself. */
	alias = (note: Note): string => {
		const r = this.resolutions.get(note.id);
		return r && r.status !== 'rest' && r.status !== 'missing' && r.alias ? r.alias : note.lyric;
	};

	resolutionOf = (id: string): Resolution | undefined => this.resolutions.get(id);

	/** Missing lyrics grouped by spelling, most used first. */
	groups = $derived.by(() => {
		const byLyric = new Map<string, MissingLyric>();
		if (!this.resolutions.size) return [] as MissingLyric[];
		for (const n of project.notes) {
			const r = this.resolutions.get(n.id);
			if (r?.status !== 'missing' || isSpecialLyric(n.lyric)) continue;
			let g = byLyric.get(n.lyric);
			if (!g) {
				g = { lyric: n.lyric, noteIds: [], suggestions: [] };
				byLyric.set(n.lyric, g);
				g.suggestions = r.suggestions;
			}
			g.noteIds.push(n.id);
		}
		return [...byLyric.values()].sort((a, b) => b.noteIds.length - a.noteIds.length);
	});

	private activeTrackIndex() {
		const track = project.tracks.find((t) => t.id === project.activeTrack);
		const vb = voicebank.effectiveBankForTrack(track) ?? voicebank.current;
		return voicebank.indexFor(vb);
	}

	/** Suggestions for one lyric as it would be sung on a given note (for the lyric box). */
	suggestFor(query: string, pitch: number, limit = 60) {
		const index = this.activeTrackIndex();
		if (!index) return [];
		return plugins.registry.suggest(query, { index, pitch, limit });
	}

	/** Resolution of an arbitrary text on a pitch (no neighbouring note). */
	preview(text: string, pitch: number): Resolution | null {
		const index = this.activeTrackIndex();
		return index ? resolveLyric(text, { index, pitch, prev: null }, plugins.registry) : null;
	}

	/** Opens the doctor when an import left lyrics the voicebank cannot sing. */
	offerFix() {
		if (!settings.data.lyricDoctor || !voicebank.index) return;
		const count = this.groups.length;
		if (count) {
			ui.toast(`${count} lyric(s) are not in the voicebank: choose replacements.`, 'info');
			ui.openDialog('lyric-doctor');
		}
	}

	/** After a voicebank is loaded: point at the lyrics it cannot sing, without interrupting. */
	notifyAfterVoicebank() {
		const n = this.groups.reduce((sum, g) => sum + g.noteIds.length, 0);
		if (n) ui.toast(`${n} note(s) use lyrics this voicebank does not have (Edit ▸ Lyrics ▸ Fix).`);
	}
}

export const lyrics = new LyricState();
voicebank.loadedListeners.push(() => lyrics.notifyAfterVoicebank());
