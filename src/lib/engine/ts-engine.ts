import { decodeText } from '#lib/io/text';
import type { AnalysisMode, EngineNote, PlanEntry, RenderReport } from './bridge';

export const SAMPLE_RATE = 44100;
const FRAME_PERIOD_MS = 5.0;
const F0_FLOOR = 65.0;
const F0_CEIL = 1100.0;
const DEFAULT_FADE_IN_MS = 5.0;
const DEFAULT_FADE_OUT_MS = 35.0;
const FEATURE_MAGIC = 0x41465457; // "WTFA" in little-endian
const FEATURE_FORMAT_VERSION = 1;
export const TS_ANALYSIS_VERSION = 101;

// ---- utilities --------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function midiToHz(midi: number): number {
	return 440 * Math.pow(2, (midi - 69) / 12);
}

export function normalizeFilename(name: string): string {
	const parts = name.split(/[/\\]/);
	return (parts[parts.length - 1] ?? name).toLowerCase();
}

function foldAlias(alias: string): string {
	return alias.trim().toLowerCase();
}

function parsePitchName(raw: string): number | null {
	const s = raw.trim();
	if (/^-?\d+$/.test(s)) return Number(s);
	const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(s);
	if (!m) return null;
	const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
	const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
	return (Number(m[3]) + 1) * 12 + base + acc;
}

function consonantScale(velocity: number): number {
	const v = Number.isFinite(velocity) ? velocity : 100;
	return clamp(Math.pow(2, 1 - v / 100), 0.25, 4.0);
}

function isRest(note: EngineNote): boolean {
	const a = note.alias.trim().toLowerCase();
	return a === '' || a === 'r';
}

// ---- oto.ini & prefix.map ---------------------------------------------------

export interface OtoEntry {
	filename: string;
	alias: string;
	offset: number;
	consonant: number;
	cutoff: number;
	preutterance: number;
	overlap: number;
}

export function parseOtoIni(data: Uint8Array): Map<string, OtoEntry> {
	const text = decodeText(data);
	const out = new Map<string, OtoEntry>();

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/^\uFEFF/, '').trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;

		const filename = line.slice(0, eq).trim();
		const rest = line.slice(eq + 1).split(',');
		const aliasRaw = (rest[0] ?? '').trim();
		const alias = aliasRaw
			? aliasRaw
			: filename.toLowerCase().endsWith('.wav')
				? filename.slice(0, -4)
				: filename;

		if (rest.length < 6) continue;
		const num = (idx: number) => {
			const v = Number((rest[idx] ?? '').trim());
			return Number.isFinite(v) ? v : 0;
		};

		out.set(alias, {
			filename,
			alias,
			offset: num(1),
			consonant: num(2),
			cutoff: num(3),
			preutterance: num(4),
			overlap: num(5)
		});
	}
	return out;
}

export class OtoBank {
	private readonly lowercaseIndex = new Map<string, string>();

	constructor(private readonly entries: Map<string, OtoEntry> = new Map()) {
		for (const key of entries.keys()) {
			this.lowercaseIndex.set(foldAlias(key), key);
		}
	}

	find(alias: string): OtoEntry | undefined {
		const exact = this.entries.get(alias);
		if (exact) return exact;
		const mapped = this.lowercaseIndex.get(foldAlias(alias));
		return mapped ? this.entries.get(mapped) : undefined;
	}

	entriesList(): [string, string][] {
		const list: [string, string][] = [];
		for (const entry of this.entries.values()) {
			list.push([entry.alias, entry.filename]);
		}
		return list;
	}
}

export type PrefixMap = Map<number, { prefix: string; suffix: string }>;

export function parsePrefixMap(data: Uint8Array): PrefixMap {
	const text = decodeText(data);
	const map: PrefixMap = new Map();
	for (const line of text.split(/\r?\n/)) {
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const pitch = parsePitchName(line.slice(0, eq));
		if (pitch === null) continue;
		const value = line.slice(eq + 1).replace(/[\r\n]+$/, '');
		const tab = value.indexOf('\t');
		if (tab >= 0) {
			map.set(pitch, { prefix: value.slice(0, tab), suffix: value.slice(tab + 1) });
		} else {
			map.set(pitch, { prefix: '', suffix: value });
		}
	}
	return map;
}

// ---- flags parser -----------------------------------------------------------

export interface ParsedFlags {
	gender: number;
	breathiness: number;
	peakCompression: number;
	tremolo: number;
	pitchOffset: number;
	aperiodicMix: number;
	growl: number;
	fryEnable: number;
	fryTransition: number;
	fryVolume: number;
	fryPitch: number;
}

export function parseFlags(raw: string): ParsedFlags {
	const flags: ParsedFlags = {
		gender: 0,
		breathiness: 50,
		peakCompression: 86,
		tremolo: 0,
		pitchOffset: 0,
		aperiodicMix: 0,
		growl: 0,
		fryEnable: 0,
		fryTransition: 75,
		fryVolume: 10,
		fryPitch: F0_FLOOR
	};

	const s = raw.replace(/\//g, '');
	const tokens: ({ kind: 'flag'; id: string } | { kind: 'num'; val: number })[] = [];
	let i = 0;

	while (i < s.length) {
		const two = s.slice(i, i + 2);
		if (
			two === 'fe' ||
			two === 'fo' ||
			two === 'fl' ||
			two === 'fv' ||
			two === 'fp' ||
			two === 've' ||
			two === 'vo' ||
			two === 'vl' ||
			two === 'gw'
		) {
			tokens.push({ kind: 'flag', id: two });
			i += 2;
			continue;
		}
		const ch = s[i];
		if ('gBPpAtSG'.includes(ch)) {
			tokens.push({ kind: 'flag', id: ch });
			i += 1;
			continue;
		}
		if (ch === '+' || ch === '-' || (ch >= '0' && ch <= '9')) {
			const start = i;
			i++;
			while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
			const num = Number(s.slice(start, i));
			if (Number.isFinite(num) && !(s.slice(start, i) === '+' || s.slice(start, i) === '-')) {
				tokens.push({ kind: 'num', val: num });
			}
			continue;
		}
		i++;
	}

	for (let k = 0; k < tokens.length; k++) {
		const cur = tokens[k];
		if (cur.kind !== 'flag') continue;
		const next = tokens[k + 1];
		if (next?.kind !== 'num') continue;
		const v = next.val;
		switch (cur.id) {
			case 'g':
				flags.gender = v;
				break;
			case 'B':
				flags.breathiness = clamp(v, 0, 100);
				break;
			case 'P':
				flags.peakCompression = clamp(v, 0, 100);
				break;
			case 'A':
				flags.tremolo = v;
				break;
			case 't':
				flags.pitchOffset = v;
				break;
			case 'S':
				flags.aperiodicMix = clamp(v, 0, 100);
				break;
			case 'gw':
				flags.growl = clamp(v, 0, 100);
				break;
			case 'fe':
				flags.fryEnable = v;
				break;
			case 'fl':
				flags.fryTransition = Math.max(1, v);
				break;
			case 'fv':
				flags.fryVolume = clamp(v, 0, 100);
				break;
			case 'fp':
				flags.fryPitch = Math.max(0, v);
				break;
		}
		k++;
	}

	return flags;
}

// ---- neighbor timing (port of crates/w-synth/src/timing.rs) -----------------

export interface TimingInput {
	start: number;
	duration: number;
	preutter: number;
	overlap: number;
}

export interface NoteTiming {
	preutter: number;
	overlap: number;
	fadeIn: number;
	tailAdjust: number;
	fadeOut: number;
}

function endMs(t: NoteTiming, duration: number): number {
	return Math.max(5.0, duration + t.tailAdjust);
}

export function computeTiming(inputs: TimingInput[]): NoteTiming[] {
	const out: NoteTiming[] = inputs.map((i) => ({
		preutter: Number.isFinite(i.preutter) ? Math.max(0, i.preutter) : 0,
		overlap: Number.isFinite(i.overlap) ? i.overlap : 0,
		fadeIn: DEFAULT_FADE_IN_MS,
		tailAdjust: 0,
		fadeOut: DEFAULT_FADE_OUT_MS
	}));

	for (let idx = 1; idx < inputs.length; idx++) {
		const cur = inputs[idx];
		const prev = inputs[idx - 1];
		const prevPre = out[idx - 1].preutter;
		const gap = cur.start - (prev.start + prev.duration);
		const adjacent = gap <= 0;

		let pre = Number.isFinite(cur.preutter) ? Math.max(0, cur.preutter) : 0;
		let overlap = Number.isFinite(cur.overlap) ? cur.overlap : 0;
		let maxPre = pre;

		if (adjacent) {
			if (overlap > 0 && pre - overlap > prev.duration * 0.5) {
				maxPre = (prev.duration * 0.5 * pre) / (pre - overlap);
			}
			maxPre = Math.min(maxPre, prev.duration);
			if (prevPre < 5.0) {
				maxPre = Math.min(maxPre, prev.duration + prevPre - 5.0);
			}
		} else if (gap < pre) {
			maxPre = gap;
		}

		maxPre = Math.max(0, maxPre);
		if (pre > maxPre) {
			const ratio = pre > 0 ? maxPre / pre : 0;
			pre = maxPre;
			overlap *= ratio;
		}
		if (overlap < 0) {
			overlap = Math.max(overlap, Math.min(0, 35.0 - prev.duration + pre));
		}
		if (prev.duration - pre < 5.0) {
			overlap = Math.max(overlap, 5.0 - (prev.duration - pre));
		}

		const overlapped = adjacent && overlap > 0;
		out[idx].preutter = pre;
		out[idx].overlap = overlap;
		out[idx].fadeIn = overlapped ? overlap : DEFAULT_FADE_IN_MS;

		const tailIntrude = adjacent ? Math.max(pre, pre - overlap) : 0;
		const tailOverlap = adjacent ? Math.max(0, overlap) : 0;
		const cut = adjacent ? gap : 0;
		out[idx - 1].tailAdjust = cut - tailIntrude + tailOverlap;
		out[idx - 1].fadeOut = overlapped ? tailOverlap : DEFAULT_FADE_OUT_MS;
	}
	return out;
}

// ---- WAV decoder & linear/Hermite resampler ---------------------------------

export function decodeWav(bytes: Uint8Array): { sampleRate: number; pcm: Float32Array } | null {
	if (bytes.byteLength < 44) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (off: number) =>
		String.fromCharCode(
			bytes[off] ?? 0,
			bytes[off + 1] ?? 0,
			bytes[off + 2] ?? 0,
			bytes[off + 3] ?? 0
		);
	if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

	let audioFormat = 0;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let dataOffset = -1;
	let dataSize = 0;

	let pos = 12;
	while (pos + 8 <= bytes.byteLength) {
		const id = tag(pos);
		const size = view.getUint32(pos + 4, true);
		const body = pos + 8;
		if (body > bytes.byteLength) break;

		if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
			audioFormat = view.getUint16(body, true);
			channels = view.getUint16(body + 2, true);
			sampleRate = view.getUint32(body + 4, true);
			bitsPerSample = view.getUint16(body + 14, true);
			if (audioFormat === 0xfffe && size >= 40 && body + 40 <= bytes.byteLength) {
				audioFormat = view.getUint16(body + 24, true);
			}
		} else if (id === 'data') {
			dataOffset = body;
			dataSize = Math.min(size, bytes.byteLength - body);
			break;
		}
		pos = body + size + (size & 1);
	}

	if (dataOffset < 0 || !channels || !sampleRate || !bitsPerSample) return null;
	if (audioFormat !== 1 && audioFormat !== 3) return null;

	const bytesPerSample = bitsPerSample >> 3;
	if (!bytesPerSample) return null;
	const frameBytes = bytesPerSample * channels;
	const frameCount = Math.floor(dataSize / frameBytes);
	if (frameCount <= 0) return null;

	const mono = new Float32Array(frameCount);
	const invCh = 1 / channels;

	for (let i = 0; i < frameCount; i++) {
		let sum = 0;
		const frameBase = dataOffset + i * frameBytes;
		for (let c = 0; c < channels; c++) {
			const o = frameBase + c * bytesPerSample;
			let sample = 0;
			if (audioFormat === 3 && bitsPerSample === 32) {
				sample = view.getFloat32(o, true);
			} else if (audioFormat === 3 && bitsPerSample === 64) {
				sample = view.getFloat64(o, true);
			} else if (bitsPerSample === 8) {
				sample = (bytes[o] - 128) / 128;
			} else if (bitsPerSample === 16) {
				sample = view.getInt16(o, true) / 32768;
			} else if (bitsPerSample === 24) {
				let v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
				if (v & 0x800000) v |= ~0xffffff;
				sample = v / 8388608;
			} else if (bitsPerSample === 32) {
				sample = view.getInt32(o, true) / 2147483648;
			}
			sum += Number.isFinite(sample) ? sample : 0;
		}
		mono[i] = sum * invCh;
	}

	if (sampleRate === SAMPLE_RATE) return { sampleRate, pcm: mono };
	return { sampleRate: SAMPLE_RATE, pcm: resampleLinear(mono, sampleRate, SAMPLE_RATE) };
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
	const out = new Float32Array(outLen);
	const ratio = fromRate / toRate;
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const a = input[idx] ?? 0;
		const b = input[Math.min(input.length - 1, idx + 1)] ?? a;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

// ---- analysis & feature serialization ---------------------------------------

export interface SampleFeatures {
	sampleRate: number;
	baseF0: number;
	f0: Float32Array;
	rms: Float32Array;
	pcm: Float32Array;
}

function estimateFrameF0(
	pcm: Float32Array,
	center: number,
	minLag: number,
	maxLag: number,
	accurate: boolean
): { f0: number; rms: number } {
	const win = accurate ? 1024 : 768;
	const start = Math.max(0, center - (win >> 1));
	const end = Math.min(pcm.length, start + win);
	const len = end - start;
	if (len < maxLag + 8) return { f0: 0, rms: 0 };

	let energy = 0;
	for (let i = start; i < end; i++) energy += pcm[i] * pcm[i];
	const rms = Math.sqrt(energy / len);
	if (rms < 0.004) return { f0: 0, rms };

	// Difference function (YIN-inspired CMND for reliable vocal F0 without octave errors).
	const step = accurate ? 1 : 2;
	const cmnd = new Float32Array(maxLag + 1);
	cmnd[0] = 1;
	let runningSum = 0;
	const cmpLen = Math.min(win >> 1, len - maxLag);
	if (cmpLen < 64) return { f0: 0, rms };

	for (let lag = 1; lag <= maxLag; lag += step) {
		let diff = 0;
		for (let j = 0; j < cmpLen; j += step) {
			const d = pcm[start + j] - pcm[start + j + lag];
			diff += d * d;
		}
		runningSum += diff * step;
		const val = runningSum > 0 ? (diff * lag) / runningSum : 1;
		cmnd[lag] = val;
		if (step === 2 && lag + 1 <= maxLag) cmnd[lag + 1] = val;
	}

	let bestLag = -1;
	let bestVal = 1;
	const threshold = 0.22;
	for (let lag = minLag; lag <= maxLag; lag++) {
		if (cmnd[lag] < threshold) {
			while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
			bestLag = lag;
			bestVal = cmnd[lag];
			break;
		}
		if (cmnd[lag] < bestVal) {
			bestVal = cmnd[lag];
			bestLag = lag;
		}
	}

	if (bestLag < minLag || bestVal > 0.45) return { f0: 0, rms };

	// Parabolic refinement around bestLag.
	let refinedLag = bestLag;
	if (bestLag > minLag && bestLag < maxLag) {
		const y0 = cmnd[bestLag - 1];
		const y1 = cmnd[bestLag];
		const y2 = cmnd[bestLag + 1];
		const denom = 2 * (y0 - 2 * y1 + y2);
		if (Math.abs(denom) > 1e-9) {
			refinedLag += clamp((y0 - y2) / denom, -0.5, 0.5);
		}
	}

	const f0 = SAMPLE_RATE / refinedLag;
	return f0 >= F0_FLOOR && f0 <= F0_CEIL ? { f0, rms } : { f0: 0, rms };
}

export function analyzeWavBytes(wav: Uint8Array, mode: AnalysisMode): Uint8Array | null {
	const decoded = decodeWav(wav);
	if (!decoded || decoded.pcm.length < 512) return null;
	const { pcm } = decoded;
	const hop = Math.round((FRAME_PERIOD_MS / 1000) * SAMPLE_RATE); // 220 or 221 samples
	const frames = Math.max(1, Math.floor(pcm.length / hop));
	const f0 = new Float32Array(frames);
	const rms = new Float32Array(frames);

	const minLag = Math.floor(SAMPLE_RATE / F0_CEIL);
	const maxLag = Math.ceil(SAMPLE_RATE / F0_FLOOR);
	const accurate = mode === 0;

	let weightedF0 = 0;
	let totalWeight = 0;
	for (let k = 0; k < frames; k++) {
		const res = estimateFrameF0(pcm, k * hop, minLag, maxLag, accurate);
		f0[k] = res.f0;
		rms[k] = res.rms;
		if (res.f0 >= F0_FLOOR && res.f0 <= F0_CEIL) {
			const w = res.rms * res.rms;
			weightedF0 += res.f0 * w;
			totalWeight += w;
		}
	}

	let baseF0 = totalWeight > 0 ? weightedF0 / totalWeight : 220;
	if (!Number.isFinite(baseF0) || baseF0 < F0_FLOOR || baseF0 > F0_CEIL) baseF0 = 220;

	// Pack into compact binary buffer.
	const headerBytes = 24;
	const f0Bytes = frames * 4;
	const rmsBytes = frames * 4;
	const pcmBytes = pcm.length * 4;
	const totalBytes = headerBytes + f0Bytes + rmsBytes + pcmBytes;
	const out = new ArrayBuffer(totalBytes);
	const view = new DataView(out);
	view.setUint32(0, FEATURE_MAGIC, true);
	view.setUint32(4, FEATURE_FORMAT_VERSION, true);
	view.setUint32(8, SAMPLE_RATE, true);
	view.setFloat32(12, baseF0, true);
	view.setUint32(16, frames, true);
	view.setUint32(20, pcm.length, true);

	new Float32Array(out, headerBytes, frames).set(f0);
	new Float32Array(out, headerBytes + f0Bytes, frames).set(rms);
	new Float32Array(out, headerBytes + f0Bytes + rmsBytes, pcm.length).set(pcm);
	return new Uint8Array(out);
}

export function decodeFeatures(data: Uint8Array): SampleFeatures | null {
	if (data.byteLength < 24) return null;
	const copy = data.slice();
	const view = new DataView(copy.buffer);
	if (view.getUint32(0, true) !== FEATURE_MAGIC) return null;
	if (view.getUint32(4, true) !== FEATURE_FORMAT_VERSION) return null;
	const sampleRate = view.getUint32(8, true) || SAMPLE_RATE;
	const baseF0 = view.getFloat32(12, true);
	const frames = view.getUint32(16, true);
	const pcmLen = view.getUint32(20, true);
	const expected = 24 + frames * 8 + pcmLen * 4;
	if (copy.byteLength !== expected || frames === 0 || pcmLen === 0) return null;

	return {
		sampleRate,
		baseF0: Number.isFinite(baseF0) && baseF0 > 20 ? baseF0 : 220,
		f0: new Float32Array(copy.buffer, 24, frames),
		rms: new Float32Array(copy.buffer, 24 + frames * 4, frames),
		pcm: new Float32Array(copy.buffer, 24 + frames * 8, pcmLen)
	};
}

// ---- TD-PSOLA note synthesizer ---------------------------------------------

function findSteadyVowelMs(features: SampleFeatures, srcAttackEndMs: number): number {
	const totalFrames = features.f0.length;
	if (totalFrames === 0) return srcAttackEndMs + 100;
	const totalMs = totalFrames * FRAME_PERIOD_MS;
	const startFrame = Math.min(
		Math.floor(srcAttackEndMs / FRAME_PERIOD_MS),
		Math.max(0, totalFrames - 1)
	);
	let bestFrame = startFrame;
	let bestScore = -Infinity;
	for (let k = startFrame; k < totalFrames; k++) {
		const voiced = features.f0[k] > F0_FLOOR;
		const energyDb = 20 * Math.log10(Math.max(1e-6, features.rms[k]));
		const score = voiced ? energyDb + 12 : energyDb;
		if (score > bestScore) {
			bestScore = score;
			bestFrame = k;
		}
	}
	return clamp(bestFrame * FRAME_PERIOD_MS, srcAttackEndMs, Math.max(srcAttackEndMs, totalMs - 10));
}

function evalPitchDevCents(
	points: { offset: number; value: number }[],
	noteDurMs: number,
	leadMs: number,
	totalFrames: number
): Float64Array {
	const sorted = [...points]
		.filter((p) => Number.isFinite(p.offset) && Number.isFinite(p.value))
		.sort((a, b) => a.offset - b.offset);
	if (sorted.length === 0 || sorted[0].offset > 0) sorted.unshift({ offset: 0, value: 0 });
	if (sorted[sorted.length - 1].offset < noteDurMs) {
		sorted.push({ offset: noteDurMs, value: 0 });
	}

	const dev = new Float64Array(totalFrames);
	let ptr = 0;
	for (let i = 0; i < totalFrames; i++) {
		const t = i * FRAME_PERIOD_MS - leadMs;
		while (ptr + 1 < sorted.length && sorted[ptr + 1].offset <= t) ptr++;
		if (t <= sorted[0].offset) {
			dev[i] = sorted[0].value / 100;
		} else if (ptr >= sorted.length - 1) {
			dev[i] = sorted[sorted.length - 1].value / 100;
		} else {
			const a = sorted[ptr];
			const b = sorted[ptr + 1];
			const span = b.offset - a.offset;
			const r = span > 1e-9 ? (t - a.offset) / span : 0;
			dev[i] = lerp(a.value, b.value, r) / 100;
		}
	}
	return dev;
}

export interface RenderedNote {
	pcm: Float32Array;
	leadMs: number;
}

export function renderNoteTs(
	note: EngineNote,
	oto: OtoEntry,
	features: SampleFeatures,
	timing: NoteTiming
): RenderedNote {
	const flags = parseFlags(note.flags || '');
	const volume = Number.isFinite(note.volume) ? Math.max(0, note.volume / 100) : 1;
	const noteDurMs = Number.isFinite(note.duration) ? Math.max(1.0, note.duration) : 1.0;

	const wavTotalMs = (features.pcm.length / SAMPLE_RATE) * 1000;
	const scale = consonantScale(note.velocity);

	const srcOffsetMs = Math.max(0, oto.offset);
	const srcConsonantMs = Math.max(0, oto.consonant);
	const srcPreutterMs = Math.max(0, oto.preutterance);
	const srcCutoffMs = oto.cutoff;

	const srcAttackEndMs =
		srcConsonantMs > 0
			? Math.min(srcOffsetMs + srcConsonantMs, wavTotalMs)
			: Math.min(srcOffsetMs + srcPreutterMs + 40, wavTotalMs);
	const srcPreutterPointMs = Math.min(srcOffsetMs + srcPreutterMs, srcAttackEndMs);
	const srcFixedConsonantMs = Math.max(0, srcAttackEndMs - srcPreutterPointMs);

	let srcVowelSteadyMs: number;
	if (srcCutoffMs > 0) {
		srcVowelSteadyMs = Math.max(srcAttackEndMs, wavTotalMs - srcCutoffMs);
	} else if (srcCutoffMs < 0) {
		srcVowelSteadyMs = Math.max(srcAttackEndMs, Math.min(wavTotalMs, srcOffsetMs - srcCutoffMs));
	} else {
		srcVowelSteadyMs = findSteadyVowelMs(features, srcAttackEndMs);
	}
	srcVowelSteadyMs = clamp(
		srcVowelSteadyMs,
		srcAttackEndMs,
		Math.max(srcAttackEndMs + 20, wavTotalMs - 5)
	);

	const renderPreutterMs = timing.preutter;
	const fullPreutterMs = srcPreutterMs * scale;
	const skipSrcMs = Math.max(0, fullPreutterMs - renderPreutterMs) / scale;
	const outFixedConsonantMs = Math.min(srcFixedConsonantMs * scale, noteDurMs);
	const soundEndMs = endMs(timing, noteDurMs);
	const totalRenderMs = Math.max(1.0, renderPreutterMs + soundEndMs);
	const outSamples = Math.max(1, Math.round((totalRenderMs / 1000) * SAMPLE_RATE));
	const totalFrames = Math.max(1, Math.ceil(totalRenderMs / FRAME_PERIOD_MS) + 1);

	const pitchDev = evalPitchDevCents(
		note.pitchbend ?? [],
		noteDurMs,
		renderPreutterMs,
		totalFrames
	);
	const baseMidi =
		(Number.isFinite(note.pitch) ? clamp(note.pitch, 0, 127) : 60) + flags.pitchOffset / 100;

	const f0Contour = new Float64Array(totalFrames);
	const frameGain = new Float64Array(totalFrames);
	const aAmt = clamp(flags.tremolo, -100, 100) / 100;

	for (let k = 0; k < totalFrames; k++) {
		let f0 = midiToHz(baseMidi + pitchDev[k]);
		let gain = Math.pow(2, clamp((aAmt * pitchDev[k]) / 2, -3.3, 2));

		if (flags.fryEnable > 0) {
			const fryStart = Math.max(0, noteDurMs - flags.fryEnable);
			const tNote = k * FRAME_PERIOD_MS - renderPreutterMs;
			const w = clamp((tNote - fryStart) / Math.max(1, flags.fryTransition), 0, 1);
			if (w > 0) {
				const sw = w * w * (3 - 2 * w);
				const h = (Math.imul(k + 1, 2654435761) >>> 16) / 65535;
				const wobble = 1 + 0.12 * (h - 0.5);
				f0 = lerp(f0, Math.max(20, flags.fryPitch) * wobble, sw);
				gain *= lerp(1, Math.pow(10, -flags.fryVolume / 20), sw);
			}
		}

		if (flags.growl > 0) {
			const gr = flags.growl / 100;
			const tSec = (k * FRAME_PERIOD_MS) / 1000;
			gain *= 1 - 0.35 * gr * (0.5 + 0.5 * Math.sin(2 * Math.PI * 34 * tSec));
		}

		f0Contour[k] = clamp(f0, 35, 1600);
		frameGain[k] = gain;
	}

	// Source time lookup in ms for any output sample time (handles consonant speed + steady-vowel ping-pong loop).
	const vowelSpanMs = Math.max(25, srcVowelSteadyMs - srcAttackEndMs);
	const srcMsAt = (outMs: number): number => {
		if (outMs < renderPreutterMs) {
			return clamp(srcOffsetMs + skipSrcMs + outMs / scale, 0, wavTotalMs - 1);
		}
		if (outMs < renderPreutterMs + outFixedConsonantMs) {
			return clamp(srcPreutterPointMs + (outMs - renderPreutterMs) / scale, 0, wavTotalMs - 1);
		}
		const tInVowel = outMs - (renderPreutterMs + outFixedConsonantMs);
		if (tInVowel <= vowelSpanMs) {
			return clamp(srcAttackEndMs + tInVowel, 0, wavTotalMs - 1);
		}
		// Smooth ping-pong sustain across the steady vowel section so long notes never end abruptly or buzz.
		const loopSpan = Math.max(20, vowelSpanMs * 0.55);
		const loopStart = Math.max(srcAttackEndMs, srcVowelSteadyMs - loopSpan);
		const excess = (tInVowel - vowelSpanMs) % (2 * loopSpan);
		const pos = excess <= loopSpan ? srcVowelSteadyMs - excess : loopStart + (excess - loopSpan);
		return clamp(pos, 0, wavTotalMs - 1);
	};

	// TD-PSOLA synthesis into `pcm` + window-sum `norm` for unity gain.
	const pcm = new Float32Array(outSamples);
	const norm = new Float32Array(outSamples);
	const srcPcm = features.pcm;
	const srcLen = srcPcm.length;
	const basePeriodSamples = SAMPLE_RATE / clamp(features.baseF0, F0_FLOOR, F0_CEIL);

	let outCursor = 0;
	let noiseState = 0x12345678;
	const breathAmp =
		clamp((flags.breathiness - 50) / 100, 0, 0.5) + (flags.aperiodicMix / 100) * 0.25;

	while (outCursor < outSamples) {
		const outMs = (outCursor / SAMPLE_RATE) * 1000;
		const frameIdx = clamp(Math.floor(outMs / FRAME_PERIOD_MS), 0, totalFrames - 1);
		const targetF0 = f0Contour[frameIdx];
		const targetPeriod = SAMPLE_RATE / targetF0;

		const sMs = srcMsAt(outMs);
		const sFrame = clamp(Math.floor(sMs / FRAME_PERIOD_MS), 0, features.f0.length - 1);
		const srcF0 = features.f0[sFrame] > F0_FLOOR ? features.f0[sFrame] : features.baseF0;
		const localPeriod = SAMPLE_RATE / clamp(srcF0, F0_FLOOR, F0_CEIL);

		// During consonant attack, lean toward 1:1 period preservation so plosives/fricatives stay crisp.
		const inConsonant = outMs < renderPreutterMs + outFixedConsonantMs;
		const hop = inConsonant
			? Math.round(lerp(localPeriod, targetPeriod, 0.35))
			: Math.round(targetPeriod);
		const halfWin = Math.max(
			48,
			Math.round(inConsonant ? localPeriod : Math.max(basePeriodSamples, targetPeriod))
		);
		const winLen = halfWin * 2;
		const srcCenter = Math.round((sMs / 1000) * SAMPLE_RATE);

		for (let j = -halfWin; j < halfWin; j++) {
			const oi = Math.round(outCursor) + j;
			if (oi < 0 || oi >= outSamples) continue;
			const si = clamp(srcCenter + j, 0, srcLen - 1);
			const w = 0.5 * (1 - Math.cos((2 * Math.PI * (j + halfWin)) / winLen));
			let s = srcPcm[si];
			if (breathAmp > 0) {
				noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
				const n = (noiseState / 0xffffffff - 0.5) * 0.15 * features.rms[sFrame];
				s = s * (1 - breathAmp * 0.4) + n * breathAmp;
			}
			pcm[oi] += s * w;
			norm[oi] += w;
		}

		outCursor += Math.max(32, hop * 0.5);
	}

	// Normalize overlap-add and apply frame gain, gender tilt, volume & crossfade envelopes.
	const genderAmt = clamp(flags.gender, -100, 100) / 100;
	let prevRaw = 0;
	let lpState = 0;
	for (let i = 0; i < outSamples; i++) {
		let s = norm[i] > 1e-4 ? pcm[i] / norm[i] : 0;

		if (genderAmt !== 0) {
			if (genderAmt > 0) {
				// Positive g: brighter / higher formant tilt.
				const hp = s - prevRaw;
				prevRaw = s;
				s = s + genderAmt * 0.35 * hp;
			} else {
				// Negative g: warmer / deeper formant tilt.
				lpState = lerp(lpState, s, 0.35);
				s = lerp(s, lpState, -genderAmt * 0.65);
			}
		}

		const fPos = ((i / SAMPLE_RATE) * 1000) / FRAME_PERIOD_MS;
		const fLo = clamp(Math.floor(fPos), 0, totalFrames - 1);
		const fHi = clamp(fLo + 1, 0, totalFrames - 1);
		const g = lerp(frameGain[fLo], frameGain[fHi], fPos - fLo);
		pcm[i] = Number.isFinite(s) ? s * g * volume : 0;
	}

	// Crossfade envelopes (equal-power quarter-sine, matching resample.rs).
	const fadeInMs = Math.min(timing.fadeIn, totalRenderMs);
	const fadeOutMs = Math.min(timing.fadeOut, soundEndMs);
	if (fadeInMs > 0) {
		const len = Math.min(outSamples, Math.round((fadeInMs / 1000) * SAMPLE_RATE));
		const denom = Math.max(1, len - 1);
		for (let i = 0; i < len; i++) {
			pcm[i] *= Math.sin((Math.PI / 2) * (i / denom));
		}
	}
	if (fadeOutMs > 0) {
		const len = Math.min(outSamples, Math.round((fadeOutMs / 1000) * SAMPLE_RATE));
		const start = outSamples - len;
		const denom = Math.max(1, len - 1);
		for (let i = 0; i < len; i++) {
			pcm[start + i] *= Math.sin((Math.PI / 2) * (1 - i / denom));
		}
	}

	return { pcm, leadMs: renderPreutterMs };
}

// ---- pure-TS Engine instance (mirrors crates/w-synth/src/engine.rs) --------

interface PlannedNote {
	sourceIndex: number;
	otoAlias: string;
	timing: NoteTiming;
}

interface Session {
	notes: EngineNote[];
	tempo: number;
	plan: PlannedNote[];
	cursor: number;
	rendered: boolean[];
	master: Float32Array;
	newCache: Map<string, RenderedNote>;
	report: RenderReport;
}

function noteCacheKey(
	note: EngineNote,
	otoAlias: string,
	timing: NoteTiming,
	epoch: number
): string {
	const bends = (note.pitchbend ?? [])
		.map((p) => `${p.offset.toFixed(3)}:${p.value.toFixed(3)}`)
		.join(';');
	return [
		otoAlias,
		epoch,
		note.pitch,
		note.duration.toFixed(3),
		note.flags,
		note.velocity,
		note.volume,
		timing.preutter.toFixed(3),
		timing.overlap.toFixed(3),
		timing.fadeIn.toFixed(3),
		timing.tailAdjust.toFixed(3),
		timing.fadeOut.toFixed(3),
		bends
	].join('|');
}

export class TsEngineInstance {
	private oto = new OtoBank();
	private prefixMap: PrefixMap = new Map();
	private features = new Map<string, { data: SampleFeatures; epoch: number }>();
	private nextEpoch = 1;
	private renderCache = new Map<string, RenderedNote>();
	private session: Session | null = null;
	private lastReport: RenderReport = this.emptyReport();

	private emptyReport(): RenderReport {
		return {
			total: 0,
			rendered: 0,
			cached: 0,
			skipped_rests: 0,
			missing_alias: [],
			missing_features: [],
			errors: [],
			spans: []
		};
	}

	reset() {
		this.oto = new OtoBank();
		this.prefixMap = new Map();
		this.features.clear();
		this.nextEpoch = 1;
		this.renderCache.clear();
		this.session = null;
		this.lastReport = this.emptyReport();
	}

	loadOto(data: Uint8Array): boolean {
		const map = parseOtoIni(data);
		if (map.size === 0) return false;
		this.oto = new OtoBank(map);
		this.renderCache.clear();
		return true;
	}

	loadPrefixMap(data: Uint8Array): boolean {
		this.prefixMap = parsePrefixMap(data);
		this.renderCache.clear();
		return true;
	}

	otoEntries(): [string, string][] {
		return this.oto.entriesList();
	}

	private resolveAlias(alias: string, pitch: number): string {
		let bestPitch = -Infinity;
		let bestAffix: { prefix: string; suffix: string } | null = null;
		for (const [p, affix] of this.prefixMap) {
			if (p <= pitch && p > bestPitch) {
				bestPitch = p;
				bestAffix = affix;
			}
		}
		if (bestAffix) {
			const candidate = `${bestAffix.prefix}${alias}${bestAffix.suffix}`;
			if (this.oto.find(candidate)) return candidate;
		}
		return alias;
	}

	requiredFiles(notes: EngineNote[]): { files: string[]; missing: number[] } {
		const files: string[] = [];
		const seen = new Set<string>();
		const missing: number[] = [];
		notes.forEach((note, idx) => {
			if (isRest(note)) return;
			const entry = this.oto.find(this.resolveAlias(note.alias, note.pitch));
			if (entry) {
				if (!seen.has(entry.filename)) {
					seen.add(entry.filename);
					files.push(entry.filename);
				}
			} else {
				missing.push(idx);
			}
		});
		return { files, missing };
	}

	hasFeatures(name: string): boolean {
		return this.features.has(normalizeFilename(name));
	}

	cacheFeatures(name: string, data: Uint8Array): boolean {
		const parsed = decodeFeatures(data);
		if (!parsed) return false;
		this.features.set(normalizeFilename(name), { data: parsed, epoch: this.nextEpoch++ });
		return true;
	}

	beginSession(notes: EngineNote[], tempo: number): number {
		const order = notes.map((_, i) => i).sort((a, b) => notes[a].start_time - notes[b].start_time);
		const report = this.emptyReport();
		report.total = notes.length;

		const plan: PlannedNote[] = [];
		for (const idx of order) {
			const note = notes[idx];
			if (isRest(note)) {
				report.skipped_rests++;
				continue;
			}
			const otoAlias = this.resolveAlias(note.alias, note.pitch);
			if (!this.oto.find(otoAlias)) {
				report.missing_alias.push(idx);
				continue;
			}
			plan.push({
				sourceIndex: idx,
				otoAlias,
				timing: {
					preutter: 0,
					overlap: 0,
					fadeIn: DEFAULT_FADE_IN_MS,
					tailAdjust: 0,
					fadeOut: DEFAULT_FADE_OUT_MS
				}
			});
		}

		// Compute timing per track.
		const byTrack = new Map<number, number[]>();
		plan.forEach((p, idx) => {
			const track = notes[p.sourceIndex].track ?? 0;
			const arr = byTrack.get(track);
			if (arr) arr.push(idx);
			else byTrack.set(track, [idx]);
		});

		for (const indices of byTrack.values()) {
			const inputs: TimingInput[] = indices.map((i) => {
				const note = notes[plan[i].sourceIndex];
				const scale = consonantScale(note.velocity);
				const entry = this.oto.find(plan[i].otoAlias);
				const pre = entry ? Math.max(0, entry.preutterance) : 0;
				const ov = entry ? entry.overlap : 0;
				return {
					start: note.start_time,
					duration: Math.max(1.0, note.duration),
					preutter: pre * scale,
					overlap: ov * scale
				};
			});
			const computed = computeTiming(inputs);
			indices.forEach((planIdx, j) => {
				plan[planIdx].timing = computed[j];
			});
		}

		const endMsTotal = notes.reduce((m, n) => Math.max(m, n.start_time + n.duration), 0) + 2000;
		const totalSamples = Math.max(1, Math.ceil((endMsTotal / 1000) * SAMPLE_RATE));

		this.session = {
			notes,
			tempo,
			plan,
			cursor: 0,
			rendered: new Array(plan.length).fill(false),
			master: new Float32Array(totalSamples),
			newCache: new Map(),
			report
		};
		return plan.length;
	}

	step(count: number): number {
		if (!this.session) return -1;
		const limit = Math.max(1, count);
		const picked: number[] = [];
		while (picked.length < limit && this.session.cursor < this.session.plan.length) {
			if (!this.session.rendered[this.session.cursor]) {
				picked.push(this.session.cursor);
			}
			this.session.cursor++;
		}
		return this.renderPlanned(picked);
	}

	renderPlanned(indices: number[]): number {
		if (!this.session) return -1;
		for (const i of indices) {
			if (i >= 0 && i < this.session.plan.length && !this.session.rendered[i]) {
				this.session.rendered[i] = true;
				this.renderOne(this.session, i);
			}
		}
		let remaining = 0;
		for (const r of this.session.rendered) if (!r) remaining++;
		return remaining;
	}

	private renderOne(session: Session, i: number) {
		const planned = session.plan[i];
		const note = session.notes[planned.sourceIndex];
		const oto = this.oto.find(planned.otoAlias);
		if (!oto) return;
		const stored = this.features.get(normalizeFilename(oto.filename));
		if (!stored) {
			session.report.missing_features.push(planned.sourceIndex);
			return;
		}

		const key = noteCacheKey(note, planned.otoAlias, planned.timing, stored.epoch);
		let rendered = this.renderCache.get(key) ?? session.newCache.get(key);
		if (rendered) {
			session.report.cached++;
		} else {
			try {
				rendered = renderNoteTs(note, oto, stored.data, planned.timing);
				session.report.rendered++;
			} catch (error) {
				session.report.errors.push(
					`note ${planned.sourceIndex}: ${error instanceof Error ? error.message : String(error)}`
				);
				return;
			}
		}

		const startMs = note.start_time - rendered.leadMs;
		const samplesMs = (rendered.pcm.length / SAMPLE_RATE) * 1000;
		session.report.spans ??= [];
		session.report.spans.push({
			index: planned.sourceIndex,
			start: startMs,
			end: startMs + samplesMs,
			fade_in: planned.timing.fadeIn,
			fade_out: planned.timing.fadeOut
		});

		const startSample = Math.round((startMs / 1000) * SAMPLE_RATE);
		const master = session.master;
		for (let j = 0; j < rendered.pcm.length; j++) {
			const idx = startSample + j;
			if (idx >= 0 && idx < master.length) master[idx] += rendered.pcm[j];
		}

		session.newCache.set(key, rendered);
	}

	plan(): PlanEntry[] {
		if (!this.session) return [];
		return this.session.plan.map((p, idx) => {
			const note = this.session!.notes[p.sourceIndex];
			const entry = this.oto.find(p.otoAlias);
			return {
				index: idx,
				source_index: p.sourceIndex,
				start: note.start_time,
				span_start: note.start_time - p.timing.preutter,
				span_end: note.start_time + endMs(p.timing, Math.max(1.0, note.duration)),
				file: entry?.filename ?? ''
			};
		});
	}

	read(start: number, len: number): Float32Array | null {
		if (!this.session) return null;
		const from = Math.min(Math.max(0, start), this.session.master.length);
		const to = Math.min(this.session.master.length, from + Math.max(0, len));
		return this.session.master.slice(from, to);
	}

	endStream(complete: boolean): boolean {
		if (!this.session) return false;
		if (complete) {
			this.renderCache = this.session.newCache;
		} else {
			for (const [k, v] of this.session.newCache) this.renderCache.set(k, v);
		}
		this.lastReport = this.session.report;
		this.session = null;
		return true;
	}

	finish(): Float32Array | null {
		if (!this.session) return null;
		const master = this.session.master;
		this.renderCache = this.session.newCache;
		this.lastReport = this.session.report;
		this.session = null;

		let peak = 0;
		for (let i = 0; i < master.length; i++) peak = Math.max(peak, Math.abs(master[i]));
		if (peak > 0.001 && (peak < 0.8 || peak > 1.0)) {
			const gain = 0.95 / peak;
			for (let i = 0; i < master.length; i++) master[i] *= gain;
		}
		return master;
	}

	renderOneshot(
		notes: EngineNote[],
		tempo: number
	): { report: RenderReport; pcm: Float32Array } | null {
		const parkedSession = this.session;
		const parkedReport = this.lastReport;
		try {
			const count = this.beginSession(notes, tempo);
			const all = Array.from({ length: count }, (_, i) => i);
			this.renderPlanned(all);
			const pcm = this.read(0, Number.MAX_SAFE_INTEGER) ?? new Float32Array(0);
			this.endStream(false);
			return { report: this.lastReport, pcm };
		} finally {
			this.session = parkedSession;
			this.lastReport = parkedReport;
		}
	}

	report(): RenderReport {
		return this.lastReport;
	}
}
