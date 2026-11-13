import type { TempoMap } from '#lib/core/tempo';
import type { Note, Track } from '#lib/core/types';
import {
	computeWaveformPeaks,
	otoSampleRange,
	parseOtoTiming,
	parseWavSamples,
	type DecodedWav,
	type OtoTiming
} from '#lib/core/waveform';
import { decodeText } from '#lib/io/text';
import type { Voicebank } from '#lib/voicebank/types';
import { lyrics } from './lyrics.svelte';
import { playback } from './playback.svelte';
import { settings } from './settings.svelte';
import { voicebank } from './voicebank.svelte';

const SAMPLE_RATE = 44100;
const PEAK_BUCKETS = 192;
const MAX_DECODED_WAVS = 240;
const MAX_SAMPLE_PEAKS = 400;

class WaveformCache {
	/** Increments whenever an async WAV decode finishes so the piano roll repaints. */
	sampleRevision = $state(0);

	private decodedWavs = new Map<string, DecodedWav | null>();
	private pendingReads = new Set<string>();
	private otoMaps = new WeakMap<Voicebank, Map<string, OtoTiming>>();
	private samplePeaks = new Map<string, Float32Array | null>();

	private renderCacheRev = -1;
	private renderCachePcm: Float32Array | null = null;
	private renderCacheTempo: TempoMap | null = null;
	private renderPeaks = new Map<string, Float32Array | null>();

	private rememberDecoded(key: string, wav: DecodedWav | null) {
		if (this.decodedWavs.size >= MAX_DECODED_WAVS) {
			const oldest = this.decodedWavs.keys().next().value;
			if (oldest !== undefined) this.decodedWavs.delete(oldest);
		}
		this.decodedWavs.set(key, wav);
	}

	private rememberSamplePeaks(key: string, peaks: Float32Array | null) {
		if (this.samplePeaks.size >= MAX_SAMPLE_PEAKS) {
			const oldest = this.samplePeaks.keys().next().value;
			if (oldest !== undefined) this.samplePeaks.delete(oldest);
		}
		this.samplePeaks.set(key, peaks);
	}

	private otoFor(vb: Voicebank): Map<string, OtoTiming> {
		let map = this.otoMaps.get(vb);
		if (!map) {
			map = parseOtoTiming(decodeText(vb.oto));
			this.otoMaps.set(vb, map);
		}
		return map;
	}

	private samplePeaksForNote(vb: Voicebank, alias: string, lyric: string): Float32Array | null {
		const oto = this.otoFor(vb);
		const trimmedLyric = lyric.trim();
		const timing = oto.get(alias) ?? oto.get(trimmedLyric);
		const directSampleKey =
			vb.aliasFile.get(alias) ??
			vb.aliasFile.get(trimmedLyric) ??
			timing?.sampleKey ??
			(vb.samples.has(`${alias.toLowerCase()}.wav`)
				? `${alias.toLowerCase()}.wav`
				: vb.samples.has(`${trimmedLyric.toLowerCase()}.wav`)
					? `${trimmedLyric.toLowerCase()}.wav`
					: undefined);

		if (!directSampleKey) return null;
		const sample = vb.samples.get(directSampleKey);
		if (!sample) return null;

		const peakKey = `${vb.id}|${directSampleKey}|${timing?.offsetMs ?? 0}|${timing?.cutoffMs ?? 0}`;
		if (this.samplePeaks.has(peakKey)) return this.samplePeaks.get(peakKey) ?? null;

		const wavKey = `${vb.id}|${directSampleKey}`;
		const decoded = this.decodedWavs.get(wavKey);
		if (decoded === undefined) {
			if (!this.pendingReads.has(wavKey)) {
				this.pendingReads.add(wavKey);
				void sample
					.read()
					.then((bytes) => {
						this.rememberDecoded(wavKey, parseWavSamples(bytes));
					})
					.catch(() => {
						this.rememberDecoded(wavKey, null);
					})
					.finally(() => {
						this.pendingReads.delete(wavKey);
						this.sampleRevision++;
					});
			}
			return null;
		}
		if (!decoded) {
			this.rememberSamplePeaks(peakKey, null);
			return null;
		}

		const [start, end] = otoSampleRange(decoded.samples.length, decoded.sampleRate, timing);
		const peaks = computeWaveformPeaks(decoded.samples, start, end, PEAK_BUCKETS);
		this.rememberSamplePeaks(peakKey, peaks);
		return peaks;
	}

	/**
	 * Builds a map of noteId -> normalized peak amplitudes ([0, 1]) for all non-rest notes.
	 * Uses the rendered 44.1 kHz PCM slice whenever ready, falling back cleanly to the
	 * voicebank's resolved WAV sample envelope so notes show waveforms immediately.
	 */
	forNotes(
		notes: readonly Note[],
		tracks: readonly Track[],
		tempoMap: TempoMap
	): ReadonlyMap<string, Float32Array> | undefined {
		if (!settings.data.showNoteWaveforms || !notes.length) return undefined;

		// Touch reactive dependencies cleanly.
		void this.sampleRevision;
		void voicebank.revision;
		void voicebank.cacheRevision;
		void lyrics.resolutions;
		const wfRev = playback.waveformRevision;
		const pcm = playback.renderPcm;

		if (
			this.renderCacheRev !== wfRev ||
			this.renderCachePcm !== pcm ||
			this.renderCacheTempo !== tempoMap
		) {
			this.renderCacheRev = wfRev;
			this.renderCachePcm = pcm;
			this.renderCacheTempo = tempoMap;
			this.renderPeaks.clear();
		}

		const byTrack = new Map(tracks.map((t) => [t.id, t]));
		const out = new Map<string, Float32Array>();

		for (const n of notes) {
			const trimmed = n.lyric.trim();
			if (!trimmed || trimmed.toLowerCase() === 'r') continue;

			if (pcm && pcm.length > 0) {
				const startMs = tempoMap.tickToMs(n.tick);
				const endMs = tempoMap.tickToMs(n.tick + n.length);
				if (playback.hasRenderedRange(startMs, endMs)) {
					const rKey = `${n.id}|${n.tick}|${n.length}`;
					let peaks = this.renderPeaks.get(rKey);
					if (peaks === undefined) {
						const s0 = Math.max(0, Math.floor((startMs / 1000) * SAMPLE_RATE));
						const s1 = Math.min(pcm.length, Math.ceil((endMs / 1000) * SAMPLE_RATE));
						peaks = computeWaveformPeaks(pcm, s0, s1, PEAK_BUCKETS);
						this.renderPeaks.set(rKey, peaks);
					}
					if (peaks) {
						out.set(n.id, peaks);
						continue;
					}
				}
			}

			const vb = voicebank.effectiveBankForTrack(byTrack.get(n.track));
			if (!vb) continue;
			const resolved = lyrics.resolutionOf(n.id);
			if (resolved?.status === 'rest' || resolved?.status === 'missing') continue;
			const alias = resolved && resolved.alias ? resolved.alias : trimmed;
			const samplePeaks = this.samplePeaksForNote(vb, alias, trimmed);
			if (samplePeaks) out.set(n.id, samplePeaks);
		}

		return out;
	}
}

export const noteWaveforms = new WaveformCache();
