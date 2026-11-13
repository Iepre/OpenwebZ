import { decodeText } from '#lib/io/text';
import type { AnalysisMode, EngineNote, PlanEntry, RenderReport } from './bridge';

export const SAMPLE_RATE = 44100;
const FRAME_PERIOD_MS = 5.0;
const F0_FLOOR = 65.0;
const F0_CEIL = 1100.0;
const DEFAULT_FADE_IN_MS = 5.0;
const DEFAULT_FADE_OUT_MS = 35.0;
const FEATURE_MAGIC = 0x41465457; // "WTFA" in little-endian
const FEATURE_FORMAT_VERSION = 3;
export const TS_ANALYSIS_VERSION = 103;

const FFT_SIZE = 2048;
const FFT_HALF = FFT_SIZE >> 1; // 1024
const SP_BINS = 160; // 96 bins in 0..6201.6 Hz (64.6 Hz step) + 64 bins in 6201.6..22050 Hz (250 Hz step)
const AP_BANDS = 4; // D4C-style bands: 0-1.5k, 1.5-4k, 4-8k, 8-22kHz
const AP_BAND_CENTERS_HZ = [750, 2750, 6000, 14000] as const;

// ---- precomputed FFT tables (N = 2048) --------------------------------------

const REV_FFT = new Uint16Array(FFT_SIZE);
const TW_COS = new Float64Array(FFT_HALF);
const TW_SIN = new Float64Array(FFT_HALF);
const HANN_FFT = new Float64Array(FFT_SIZE);
const HANN_440 = new Float64Array(440);

(() => {
	const bits = 11; // log2(2048)
	for (let i = 0; i < FFT_SIZE; i++) {
		let r = 0;
		for (let b = 0; b < bits; b++) {
			if ((i >> b) & 1) r |= 1 << (bits - 1 - b);
		}
		REV_FFT[i] = r;
		HANN_FFT[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT_SIZE));
	}
	for (let i = 0; i < FFT_HALF; i++) {
		const ang = (-2 * Math.PI * i) / FFT_SIZE;
		TW_COS[i] = Math.cos(ang);
		TW_SIN[i] = Math.sin(ang);
	}
	for (let i = 0; i < HANN_440.length; i++) {
		HANN_440[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (HANN_440.length - 1)));
	}
})();

function fft2048(re: Float64Array, im: Float64Array, invert: boolean) {
	for (let i = 0; i < FFT_SIZE; i++) {
		const j = REV_FFT[i];
		if (i < j) {
			const tr = re[i];
			re[i] = re[j];
			re[j] = tr;
			const ti = im[i];
			im[i] = im[j];
			im[j] = ti;
		}
	}

	const sign = invert ? -1 : 1;
	for (let len = 2; len <= FFT_SIZE; len <<= 1) {
		const half = len >> 1;
		const step = FFT_SIZE / len;
		for (let i = 0; i < FFT_SIZE; i += len) {
			for (let j = 0; j < half; j++) {
				const twIdx = j * step;
				const wr = TW_COS[twIdx];
				const wi = sign * TW_SIN[twIdx];
				const k = i + j;
				const l = k + half;
				const xr = re[l] * wr - im[l] * wi;
				const xi = re[l] * wi + im[l] * wr;
				re[l] = re[k] - xr;
				im[l] = im[k] - xi;
				re[k] += xr;
				im[k] += xi;
			}
		}
	}

	if (invert) {
		const invN = 1 / FFT_SIZE;
		for (let i = 0; i < FFT_SIZE; i++) {
			re[i] *= invN;
			im[i] *= invN;
		}
	}
}

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

function gridBinToFftIndex(b: number): number {
	// Bins 0..96 cover 0..288 (0..6201.6 Hz at 3-bin = 64.6 Hz step); 96..159 cover up to 1024.
	if (b <= 96) return b * 3;
	return 288 + Math.round(((b - 96) * (FFT_HALF - 288)) / 63);
}

function fftIndexToGridPos(k: number): number {
	if (k <= 288) return k / 3;
	return 96 + ((k - 288) * 63) / (FFT_HALF - 288);
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

// ---- WAV decoder & linear resampler -----------------------------------------

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

// ---- analysis & feature serialization (WORLD-style F0 + SP + AP) ------------

export interface SampleFeatures {
	sampleRate: number;
	baseF0: number;
	f0: Float32Array;
	rms: Float32Array;
	ap: Float32Array; // frames * AP_BANDS (0-1.5k, 1.5-4k, 4-8k, 8-22kHz)
	sp: Float32Array; // frames * SP_BINS log-magnitude spectral envelope
	pcm: Float32Array;
}

function estimateFrameF0(
	pcm: Float32Array,
	center: number,
	minLag: number,
	maxLag: number,
	accurate: boolean
): { f0: number; rms: number; cmndMin: number } {
	const win = accurate ? 1024 : 896;
	const start = Math.max(0, center - (win >> 1));
	const end = Math.min(pcm.length, start + win);
	const len = end - start;
	if (len < maxLag + 8) return { f0: 0, rms: 0, cmndMin: 1 };

	let mean = 0;
	for (let i = start; i < end; i++) mean += pcm[i];
	mean /= len;

	let energy = 0;
	for (let i = start; i < end; i++) {
		const d = pcm[i] - mean;
		energy += d * d;
	}
	const rms = Math.sqrt(energy / len);
	if (rms < 0.004) return { f0: 0, rms, cmndMin: 1 };

	const innerStep = accurate ? 1 : 2;
	const cmnd = new Float32Array(maxLag + 1);
	cmnd[0] = 1;
	let runningSum = 0;
	const cmpLen = Math.min(win >> 1, len - maxLag);
	if (cmpLen < 64) return { f0: 0, rms, cmndMin: 1 };

	// Evaluate every integer lag even in fast mode to prevent high-note pitch quantization jitter.
	for (let lag = 1; lag <= maxLag; lag++) {
		let diff = 0;
		for (let j = 0; j < cmpLen; j += innerStep) {
			const d = pcm[start + j] - pcm[start + j + lag];
			diff += d * d;
		}
		runningSum += diff;
		cmnd[lag] = runningSum > 0 ? (diff * lag) / runningSum : 1;
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

	if (bestLag < minLag || bestVal > 0.45) return { f0: 0, rms, cmndMin: bestVal };

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
	return f0 >= F0_FLOOR && f0 <= F0_CEIL
		? { f0, rms, cmndMin: bestVal }
		: { f0: 0, rms, cmndMin: 1 };
}

function smoothF0Median(f0: Float32Array) {
	const copy = f0.slice();
	const n = copy.length;
	const vals: number[] = [];
	for (let i = 0; i < n; i++) {
		vals.length = 0;
		for (let d = -2; d <= 2; d++) {
			const idx = i + d;
			if (idx >= 0 && idx < n && copy[idx] >= F0_FLOOR) vals.push(copy[idx]);
		}
		if (copy[i] >= F0_FLOOR && vals.length >= 3) {
			vals.sort((a, b) => a - b);
			f0[i] = vals[vals.length >> 1];
		} else if (copy[i] < F0_FLOOR && vals.length >= 3) {
			// Bridge isolated 1-2 frame F0 dropouts inside sustained vowels.
			const hasLeft =
				(i - 1 >= 0 && copy[i - 1] >= F0_FLOOR) || (i - 2 >= 0 && copy[i - 2] >= F0_FLOOR);
			const hasRight =
				(i + 1 < n && copy[i + 1] >= F0_FLOOR) || (i + 2 < n && copy[i + 2] >= F0_FLOOR);
			if (hasLeft && hasRight) {
				vals.sort((a, b) => a - b);
				f0[i] = vals[vals.length >> 1];
			}
		}
	}
}

export function analyzeWavBytes(wav: Uint8Array, mode: AnalysisMode): Uint8Array | null {
	const decoded = decodeWav(wav);
	if (!decoded || decoded.pcm.length < 512) return null;
	const { pcm } = decoded;
	const hop = Math.round((FRAME_PERIOD_MS / 1000) * SAMPLE_RATE); // 220 samples
	const frames = Math.max(1, Math.floor(pcm.length / hop));
	const f0 = new Float32Array(frames);
	const rms = new Float32Array(frames);
	const ap = new Float32Array(frames * AP_BANDS);
	const sp = new Float32Array(frames * SP_BINS);
	const cmndMins = new Float32Array(frames);

	const minLag = Math.floor(SAMPLE_RATE / F0_CEIL);
	const maxLag = Math.ceil(SAMPLE_RATE / F0_FLOOR);
	const accurate = mode === 0;

	for (let k = 0; k < frames; k++) {
		const res = estimateFrameF0(pcm, k * hop, minLag, maxLag, accurate);
		f0[k] = res.f0;
		rms[k] = res.rms;
		cmndMins[k] = res.cmndMin;
	}
	smoothF0Median(f0);

	let weightedF0 = 0;
	let totalWeight = 0;
	for (let k = 0; k < frames; k++) {
		if (f0[k] >= F0_FLOOR && f0[k] <= F0_CEIL) {
			const w = rms[k] * rms[k];
			weightedF0 += f0[k] * w;
			totalWeight += w;
		}
	}
	let baseF0 = totalWeight > 0 ? weightedF0 / totalWeight : 220;
	if (!Number.isFinite(baseF0) || baseF0 < F0_FLOOR || baseF0 > F0_CEIL) baseF0 = 220;

	const re = new Float64Array(FFT_SIZE);
	const im = new Float64Array(FFT_SIZE);
	const binPwr = new Float64Array(FFT_HALF + 1);
	const binHz = SAMPLE_RATE / FFT_SIZE; // 21.533 Hz
	const bandEdges = [
		0,
		Math.floor(1500 / binHz),
		Math.floor(4000 / binHz),
		Math.floor(8000 / binHz),
		FFT_HALF + 1
	];

	for (let k = 0; k < frames; k++) {
		const center = k * hop;
		const winStart = center - FFT_HALF;
		im.fill(0);
		for (let i = 0; i < FFT_SIZE; i++) {
			const idx = winStart + i;
			const s = idx >= 0 && idx < pcm.length ? pcm[idx] : 0;
			re[i] = s * HANN_FFT[i];
		}
		fft2048(re, im, false);

		for (let b = 0; b <= FFT_HALF; b++) {
			binPwr[b] = re[b] * re[b] + im[b] * im[b];
		}

		// CheapTrick-style Hann-weighted linear power smoothing around F0 for crisp vowel formants.
		const localF0 = f0[k] >= F0_FLOOR ? f0[k] : baseF0;
		const halfW = clamp(Math.round((localF0 * 0.62) / binHz), 2, 36);
		const rowOffset = k * SP_BINS;
		for (let gb = 0; gb < SP_BINS; gb++) {
			const fk = gridBinToFftIndex(gb);
			const lo = Math.max(0, fk - halfW);
			const hi = Math.min(FFT_HALF, fk + halfW);
			let wSum = 0;
			let wTot = 0;
			for (let b = lo; b <= hi; b++) {
				const w = 1 - Math.abs(b - fk) / (halfW + 1);
				wSum += binPwr[b] * w;
				wTot += w;
			}
			sp[rowOffset + gb] = 0.5 * Math.log(wSum / Math.max(wTot, 1e-12) + 1e-12);
		}

		// D4C-style 4-band frequency-dependent aperiodicity via spectral harmonicity vs flatness.
		const apOffset = k * AP_BANDS;
		if (f0[k] < F0_FLOOR) {
			for (let band = 0; band < AP_BANDS; band++) ap[apOffset + band] = 1.0;
		} else {
			const basePeriodicity = clamp(cmndMins[k] * 1.15, 0.015, 0.72);
			const bandBaseTilt = [0.02, 0.06, 0.22, 0.52];
			for (let band = 0; band < AP_BANDS; band++) {
				const bLo = bandEdges[band];
				const bHi = bandEdges[band + 1];
				let logSum = 0;
				let linSum = 0;
				const count = Math.max(1, bHi - bLo);
				for (let b = bLo; b < bHi; b++) {
					const p = binPwr[b] + 1e-14;
					linSum += p;
					logSum += Math.log(p);
				}
				const geomMean = Math.exp(logSum / count);
				const arithMean = linSum / count;
				const flatness = clamp(geomMean / Math.max(arithMean, 1e-14), 0, 1);
				// Pure harmonic regions have sharp peaks (low flatness); aspiration air is flatter.
				const bandAp = clamp(
					Math.max(bandBaseTilt[band], basePeriodicity * (0.65 + band * 0.35)) + flatness * 0.42,
					0.02,
					0.92
				);
				ap[apOffset + band] = bandAp;
			}
		}
	}

	const headerBytes = 32;
	const f0Bytes = frames * 4;
	const rmsBytes = frames * 4;
	const apBytes = frames * AP_BANDS * 4;
	const spBytes = frames * SP_BINS * 4;
	const pcmBytes = pcm.length * 4;
	const totalBytes = headerBytes + f0Bytes + rmsBytes + apBytes + spBytes + pcmBytes;

	const out = new ArrayBuffer(totalBytes);
	const view = new DataView(out);
	view.setUint32(0, FEATURE_MAGIC, true);
	view.setUint32(4, FEATURE_FORMAT_VERSION, true);
	view.setUint32(8, SAMPLE_RATE, true);
	view.setFloat32(12, baseF0, true);
	view.setUint32(16, frames, true);
	view.setUint32(20, pcm.length, true);
	view.setUint32(24, SP_BINS, true);
	view.setUint32(28, AP_BANDS, true);

	let cursor = headerBytes;
	new Float32Array(out, cursor, frames).set(f0);
	cursor += f0Bytes;
	new Float32Array(out, cursor, frames).set(rms);
	cursor += rmsBytes;
	new Float32Array(out, cursor, frames * AP_BANDS).set(ap);
	cursor += apBytes;
	new Float32Array(out, cursor, frames * SP_BINS).set(sp);
	cursor += spBytes;
	new Float32Array(out, cursor, pcm.length).set(pcm);
	return new Uint8Array(out);
}

export function decodeFeatures(data: Uint8Array): SampleFeatures | null {
	if (data.byteLength < 32) return null;
	const copy = data.slice();
	const view = new DataView(copy.buffer);
	if (view.getUint32(0, true) !== FEATURE_MAGIC) return null;
	if (view.getUint32(4, true) !== FEATURE_FORMAT_VERSION) return null;
	const sampleRate = view.getUint32(8, true) || SAMPLE_RATE;
	const baseF0 = view.getFloat32(12, true);
	const frames = view.getUint32(16, true);
	const pcmLen = view.getUint32(20, true);
	const spBins = view.getUint32(24, true);
	const apBands = view.getUint32(28, true);
	if (spBins !== SP_BINS || apBands !== AP_BANDS || frames === 0 || pcmLen === 0) return null;
	const expected = 32 + frames * (8 + apBands * 4 + spBins * 4) + pcmLen * 4;
	if (copy.byteLength !== expected) return null;

	let cursor = 32;
	const f0 = new Float32Array(copy.buffer, cursor, frames);
	cursor += frames * 4;
	const rms = new Float32Array(copy.buffer, cursor, frames);
	cursor += frames * 4;
	const ap = new Float32Array(copy.buffer, cursor, frames * apBands);
	cursor += frames * apBands * 4;
	const sp = new Float32Array(copy.buffer, cursor, frames * spBins);
	cursor += frames * spBins * 4;
	const pcm = new Float32Array(copy.buffer, cursor, pcmLen);

	return {
		sampleRate,
		baseF0: Number.isFinite(baseF0) && baseF0 > 20 ? baseF0 : 220,
		f0,
		rms,
		ap,
		sp,
		pcm
	};
}

// ---- WORLD-style Minimum-Phase Spectral Singing Synthesizer -----------------

function findSteadyVowelEndMs(features: SampleFeatures, srcAttackEndMs: number): number {
	const totalFrames = features.f0.length;
	if (totalFrames === 0) return srcAttackEndMs + 100;
	const totalMs = totalFrames * FRAME_PERIOD_MS;
	const startFrame = Math.min(
		Math.floor(srcAttackEndMs / FRAME_PERIOD_MS),
		Math.max(0, totalFrames - 1)
	);
	let maxVoicedRms = 0;
	for (let k = startFrame; k < totalFrames; k++) {
		if (features.f0[k] > F0_FLOOR && features.rms[k] > maxVoicedRms) {
			maxVoicedRms = features.rms[k];
		}
	}
	if (maxVoicedRms <= 0) {
		return clamp(totalMs - 20, srcAttackEndMs, Math.max(srcAttackEndMs, totalMs - 10));
	}
	const threshold = maxVoicedRms * 0.35;
	let endFrame = startFrame;
	for (let k = startFrame; k < totalFrames; k++) {
		if (features.f0[k] > F0_FLOOR && features.rms[k] >= threshold) {
			endFrame = k;
		}
	}
	return clamp(
		Math.max(endFrame * FRAME_PERIOD_MS, srcAttackEndMs + 80),
		srcAttackEndMs,
		Math.max(srcAttackEndMs, totalMs - 10)
	);
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
		srcVowelSteadyMs = findSteadyVowelEndMs(features, srcAttackEndMs);
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

	// Source time lookup in ms (cosine-eased sustain loop strictly inside steady vowel plateau).
	const vowelSpanMs = Math.max(25, srcVowelSteadyMs - srcAttackEndMs);
	const sustainGuardMs = Math.min(30, vowelSpanMs * 0.25);
	const loopSpan = clamp((vowelSpanMs - sustainGuardMs) * 0.6, 20, 220);
	const loopStart = Math.max(srcAttackEndMs + sustainGuardMs, srcVowelSteadyMs - loopSpan);
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
		const phase = ((tInVowel - vowelSpanMs) / loopSpan) * Math.PI;
		const blend = 0.5 - 0.5 * Math.cos(phase);
		return clamp(lerp(srcVowelSteadyMs, loopStart, blend), 0, wavTotalMs - 1);
	};

	const totalSrcFrames = features.f0.length;
	const formantShift = Math.pow(2, clamp(flags.gender, -100, 100) / 120);
	const breathAdjust = (flags.breathiness - 50) / 50;
	const aperiodicExtra = flags.aperiodicMix / 100;

	const sampleFeaturesAt = (sMs: number, outSp: Float64Array, outApBands: Float64Array) => {
		const fPos = clamp(sMs / FRAME_PERIOD_MS, 0, Math.max(0, totalSrcFrames - 1));
		const f0Idx = Math.floor(fPos);
		const f1Idx = Math.min(totalSrcFrames - 1, f0Idx + 1);
		const frac = fPos - f0Idx;
		const row0 = f0Idx * SP_BINS;
		const row1 = f1Idx * SP_BINS;
		for (let b = 0; b < SP_BINS; b++) {
			outSp[b] = lerp(features.sp[row0 + b], features.sp[row1 + b], frac);
		}
		const ap0 = f0Idx * AP_BANDS;
		const ap1 = f1Idx * AP_BANDS;
		for (let band = 0; band < AP_BANDS; band++) {
			outApBands[band] = lerp(features.ap[ap0 + band], features.ap[ap1 + band], frac);
		}
		const rms = lerp(features.rms[f0Idx], features.rms[f1Idx], frac);
		const v0 = features.f0[f0Idx] > F0_FLOOR ? 1 : 0;
		const v1 = features.f0[f1Idx] > F0_FLOOR ? 1 : 0;
		const voiced = lerp(v0, v1, frac);
		return { rms, voiced };
	};

	const evalLogSpectrum = (spGrid: Float64Array, outSpec: Float64Array) => {
		for (let k = 0; k <= FFT_HALF; k++) {
			const srcK = clamp(k / formantShift, 0, FFT_HALF);
			const gPos = clamp(fftIndexToGridPos(srcK), 0, SP_BINS - 1);
			const g0 = Math.floor(gPos);
			const g1 = Math.min(SP_BINS - 1, g0 + 1);
			outSpec[k] = lerp(spGrid[g0], spGrid[g1], gPos - g0);
		}
	};

	const evalBandAp = (apBands: Float64Array, k: number): number => {
		const hz = (k * SAMPLE_RATE) / FFT_SIZE;
		let base: number;
		if (hz <= AP_BAND_CENTERS_HZ[0]) {
			base = apBands[0];
		} else if (hz >= AP_BAND_CENTERS_HZ[AP_BANDS - 1]) {
			base = apBands[AP_BANDS - 1];
		} else {
			let b = 0;
			while (b + 1 < AP_BANDS - 1 && hz > AP_BAND_CENTERS_HZ[b + 1]) b++;
			const r = (hz - AP_BAND_CENTERS_HZ[b]) / (AP_BAND_CENTERS_HZ[b + 1] - AP_BAND_CENTERS_HZ[b]);
			base = lerp(apBands[b], apBands[b + 1], r);
		}
		return clamp(base * (1 + breathAdjust) + aperiodicExtra, 0, 1);
	};

	// Precompute frequency-dependent D4C weights & organic glottal all-pass phase dispersion.
	const binHz = SAMPLE_RATE / FFT_SIZE;
	const glottalDisp = new Float64Array(FFT_HALF + 1);
	for (let k = 1; k <= FFT_HALF; k++) {
		const hz = k * binHz;
		if (hz > 900) {
			const x = clamp((hz - 900) / 10000, 0, 1.5);
			glottalDisp[k] = -1.65 * Math.sin(x * 1.4) * Math.min(1, x * 2.2);
		}
	}

	const pcm = new Float32Array(outSamples);
	const srcPcm = features.pcm;
	const srcLen = srcPcm.length;

	const spBuf = new Float64Array(SP_BINS);
	const apBandBuf = new Float64Array(AP_BANDS);
	const logSpec = new Float64Array(FFT_HALF + 1);
	const re = new Float64Array(FFT_SIZE);
	const im = new Float64Array(FFT_SIZE);

	// 1) Pitch-synchronous minimum-phase harmonic synthesis (WORLD-style excitation at exact targetF0).
	let pulsePos = 0;
	while (pulsePos < outSamples) {
		const outMs = (pulsePos / SAMPLE_RATE) * 1000;
		const fIdx = clamp(Math.floor(outMs / FRAME_PERIOD_MS), 0, totalFrames - 1);
		const fNext = Math.min(totalFrames - 1, fIdx + 1);
		const fFrac = clamp((outMs - fIdx * FRAME_PERIOD_MS) / FRAME_PERIOD_MS, 0, 1);
		const targetF0 = lerp(f0Contour[fIdx], f0Contour[fNext], fFrac);
		const targetPeriod = SAMPLE_RATE / targetF0;

		const sMs = srcMsAt(outMs);
		const { rms, voiced } = sampleFeaturesAt(sMs, spBuf, apBandBuf);
		const lowAp = evalBandAp(apBandBuf, 4);

		if (voiced > 0.01 && lowAp < 0.985 && rms > 1e-4) {
			evalLogSpectrum(spBuf, logSpec);

			// Real cepstrum of vocal tract envelope -> minimum-phase spectrum.
			re[0] = logSpec[0];
			re[FFT_HALF] = logSpec[FFT_HALF];
			for (let k = 1; k < FFT_HALF; k++) {
				const v = logSpec[k];
				re[k] = v;
				re[FFT_SIZE - k] = v;
			}
			im.fill(0);
			fft2048(re, im, true);

			for (let q = 1; q < FFT_HALF; q++) re[q] *= 2;
			for (let q = FFT_HALF + 1; q < FFT_SIZE; q++) re[q] = 0;
			im.fill(0);
			fft2048(re, im, false);

			const baseIdx = Math.floor(pulsePos);
			const subFrac = pulsePos - baseIdx;
			const phaseStep = (-2 * Math.PI * subFrac) / FFT_SIZE;
			const rumbleCutoffHz = Math.min(72, targetF0 * 0.68);

			// Remove DC & sub-F0 thump; apply D4C frequency-band harmonic weighting & glottal dispersion.
			re[0] = 0;
			im[0] = 0;
			const apNyq = evalBandAp(apBandBuf, FFT_HALF);
			const harmNyq = Math.sqrt(Math.max(0, 1 - apNyq * apNyq)) * voiced;
			re[FFT_HALF] = Math.exp(clamp(re[FFT_HALF], -20, 20)) * harmNyq;
			im[FFT_HALF] = 0;

			for (let k = 1; k < FFT_HALF; k++) {
				const hz = k * binHz;
				const hp = hz < rumbleCutoffHz ? (hz / rumbleCutoffHz) ** 2 : 1;
				const apK = evalBandAp(apBandBuf, k);
				const harmW = Math.sqrt(Math.max(0, 1 - apK * apK)) * voiced * hp;
				const mag = Math.exp(clamp(re[k], -20, 20)) * harmW;
				const phase = im[k] + k * phaseStep + glottalDisp[k];
				const xr = mag * Math.cos(phase);
				const xi = mag * Math.sin(phase);
				re[k] = xr;
				im[k] = xi;
				re[FFT_SIZE - k] = xr;
				im[FFT_SIZE - k] = -xi;
			}
			fft2048(re, im, true);

			// Target harmonic RMS matches total voiced harmonic band share.
			const maxPulseLen = Math.min(FFT_SIZE, Math.max(360, Math.round(targetPeriod * 2.6)));
			const taperStart = Math.floor(maxPulseLen * 0.72);
			let energy = 0;
			for (let n = 0; n < maxPulseLen; n++) {
				let s = re[n];
				if (n >= taperStart) {
					const w = 0.5 * (1 + Math.cos((Math.PI * (n - taperStart)) / (maxPulseLen - taperStart)));
					s *= w;
					re[n] = s;
				}
				energy += s * s;
			}
			const expectedRms = Math.sqrt(energy / Math.max(1, targetPeriod));
			const harmScale = Math.sqrt(Math.max(0, 1 - lowAp * lowAp)) * voiced;
			const ampScale = (rms * harmScale) / Math.max(expectedRms, 1e-6);

			for (let n = 0; n < maxPulseLen; n++) {
				const oi = baseIdx + n;
				if (oi >= outSamples) break;
				pcm[oi] += re[n] * ampScale;
			}
		}

		pulsePos += targetPeriod;
	}

	// 2) Frequency-dependent D4C aperiodic air & crisp unvoiced consonants (220-sample / 5ms OLA).
	const hop = 220;
	const winLen = HANN_440.length; // 440 samples -> unity sum every 220 samples
	const halfWin = winLen >> 1;
	let noiseState = 0x12345678;

	for (let center = 0; center < outSamples; center += hop) {
		const outMs = (center / SAMPLE_RATE) * 1000;
		const sMs = srcMsAt(outMs);
		const { rms, voiced } = sampleFeaturesAt(sMs, spBuf, apBandBuf);
		if (rms <= 1e-4) continue;

		const inConsonant = outMs < renderPreutterMs + outFixedConsonantMs;
		if (inConsonant && voiced < 0.35 && Math.abs(flags.gender) < 5) {
			// Preserve crisp plosives/fricatives directly from the sample during unvoiced attacks.
			const srcCenter = Math.round((sMs / 1000) * SAMPLE_RATE);
			const unvoicedShare = 1 - voiced;
			for (let j = 0; j < winLen; j++) {
				const oi = center - halfWin + j;
				if (oi < 0 || oi >= outSamples) continue;
				const si = clamp(srcCenter - halfWin + j, 0, srcLen - 1);
				pcm[oi] += srcPcm[si] * HANN_440[j] * unvoicedShare;
			}
			continue;
		}

		evalLogSpectrum(spBuf, logSpec);
		re[0] = 0;
		im[0] = 0;
		const magNyqFull = Math.exp(clamp(logSpec[FFT_HALF], -20, 20));
		const apNyq = evalBandAp(apBandBuf, FFT_HALF);
		const wNyq = Math.sqrt(clamp(1 - voiced * voiced * (1 - apNyq * apNyq), 0, 1));
		const magNyqNoise = magNyqFull * wNyq;
		re[FFT_HALF] = magNyqNoise;
		im[FFT_HALF] = 0;

		let fullPwr = 0.5 * magNyqFull * magNyqFull;
		let noisePwr = 0.5 * magNyqNoise * magNyqNoise;

		for (let k = 1; k < FFT_HALF; k++) {
			noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
			const angle = (noiseState / 0xffffffff) * 2 * Math.PI;
			const magFull = Math.exp(clamp(logSpec[k], -20, 20));
			const apK = evalBandAp(apBandBuf, k);
			const wK = Math.sqrt(clamp(1 - voiced * voiced * (1 - apK * apK), 0, 1));
			const magNoise = magFull * wK;
			fullPwr += magFull * magFull;
			noisePwr += magNoise * magNoise;

			const xr = magNoise * Math.cos(angle);
			const xi = magNoise * Math.sin(angle);
			re[k] = xr;
			im[k] = xi;
			re[FFT_SIZE - k] = xr;
			im[FFT_SIZE - k] = -xi;
		}

		// True fraction of this frame's acoustic energy that belongs in the aperiodic band.
		const apEnergyShare = Math.sqrt(clamp(noisePwr / Math.max(fullPwr, 1e-24), 0, 1));
		if (apEnergyShare <= 0.015) continue;

		fft2048(re, im, true);

		let energy = 0;
		for (let j = 0; j < winLen; j++) {
			const v = re[j] * HANN_440[j];
			energy += v * v;
		}
		const segRms = Math.sqrt(energy / hop);
		const nScale = (rms * apEnergyShare) / Math.max(segRms, 1e-6);

		for (let j = 0; j < winLen; j++) {
			const oi = center - halfWin + j;
			if (oi < 0 || oi >= outSamples) continue;
			pcm[oi] += re[j] * HANN_440[j] * nScale;
		}
	}

	// 3) Apply dynamic frame gain (A / fe / gw), peak compression (P flag), & soft limiting.
	let rawPeak = 0;
	for (let i = 0; i < outSamples; i++) {
		const fPos = ((i / SAMPLE_RATE) * 1000) / FRAME_PERIOD_MS;
		const fLo = clamp(Math.floor(fPos), 0, totalFrames - 1);
		const fHi = clamp(fLo + 1, 0, totalFrames - 1);
		const g = lerp(frameGain[fLo], frameGain[fHi], fPos - fLo);
		const val = pcm[i] * g * volume;
		const finite = Number.isFinite(val) ? val : 0;
		pcm[i] = finite;
		const abs = Math.abs(finite);
		if (abs > rawPeak) rawPeak = abs;
	}

	if (rawPeak > 1e-5) {
		const pAmt = flags.peakCompression / 100;
		const targetCeiling = 0.85;
		const peakScale = rawPeak > targetCeiling ? lerp(1, targetCeiling / rawPeak, pAmt) : 1;
		for (let i = 0; i < outSamples; i++) {
			let s = pcm[i] * peakScale;
			if (s > 0.9) s = 0.9 + 0.08 * Math.tanh((s - 0.9) / 0.25);
			else if (s < -0.9) s = -0.9 - 0.08 * Math.tanh((-s - 0.9) / 0.25);
			pcm[i] = s;
		}
	}

	// 4) Crossfade envelopes (equal-power quarter-sine, matching resample.rs).
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
