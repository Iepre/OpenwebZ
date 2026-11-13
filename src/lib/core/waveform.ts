export interface DecodedWav {
	sampleRate: number;
	samples: Float32Array;
}

export interface OtoTiming {
	sampleKey: string;
	offsetMs: number;
	consonantMs: number;
	cutoffMs: number;
	preutteranceMs: number;
	overlapMs: number;
}

function readTag(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(
		bytes[offset],
		bytes[offset + 1],
		bytes[offset + 2],
		bytes[offset + 3]
	);
}

/**
 * Decodes uncompressed PCM (8/16/24/32-bit) or IEEE float (32/64-bit) WAV bytes
 * into a mono Float32Array normalized to [-1, 1]. Returns null if unsupported/invalid.
 */
export function parseWavSamples(bytes: Uint8Array): DecodedWav | null {
	if (bytes.byteLength < 44) return null;
	if (readTag(bytes, 0) !== 'RIFF' || readTag(bytes, 8) !== 'WAVE') return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let audioFormat = 0;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let hasFmt = false;
	let dataOffset = -1;
	let dataSize = 0;

	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id = readTag(bytes, offset);
		const chunkSize = view.getUint32(offset + 4, true);
		const bodyStart = offset + 8;
		const available = Math.max(0, Math.min(chunkSize, bytes.byteLength - bodyStart));

		if (id === 'fmt ' && available >= 16) {
			hasFmt = true;
			audioFormat = view.getUint16(bodyStart, true);
			channels = view.getUint16(bodyStart + 2, true);
			sampleRate = view.getUint32(bodyStart + 4, true);
			bitsPerSample = view.getUint16(bodyStart + 14, true);
			if (audioFormat === 0xfffe && available >= 40) {
				audioFormat = view.getUint16(bodyStart + 24, true);
			}
		} else if (id === 'data') {
			dataOffset = bodyStart;
			dataSize = available;
			if (hasFmt) break;
		}

		const advance = 8 + chunkSize + (chunkSize & 1);
		if (advance <= 8) break;
		offset += advance;
	}

	if (!hasFmt || dataOffset < 0 || channels <= 0 || sampleRate <= 0) return null;
	const bytesPerSample = bitsPerSample >> 3;
	const frameBytes = channels * bytesPerSample;
	if (bytesPerSample <= 0 || frameBytes <= 0) return null;
	if (audioFormat !== 1 && audioFormat !== 3) return null;

	const frameCount = Math.floor(dataSize / frameBytes);
	if (frameCount <= 0) return null;

	const out = new Float32Array(frameCount);
	const invChannels = 1 / channels;

	for (let f = 0; f < frameCount; f++) {
		const base = dataOffset + f * frameBytes;
		let sum = 0;
		for (let ch = 0; ch < channels; ch++) {
			const pos = base + ch * bytesPerSample;
			let v = 0;
			if (audioFormat === 1) {
				if (bitsPerSample === 8) {
					v = (bytes[pos] - 128) / 128;
				} else if (bitsPerSample === 16) {
					v = view.getInt16(pos, true) / 32768;
				} else if (bitsPerSample === 24) {
					const raw = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16);
					const signed = (raw << 8) >> 8;
					v = signed / 8388608;
				} else if (bitsPerSample === 32) {
					v = view.getInt32(pos, true) / 2147483648;
				} else {
					return null;
				}
			} else if (audioFormat === 3) {
				if (bitsPerSample === 32) {
					v = view.getFloat32(pos, true);
				} else if (bitsPerSample === 64) {
					v = view.getFloat64(pos, true);
				} else {
					return null;
				}
			}
			sum += Number.isFinite(v) ? v : 0;
		}
		const mono = sum * invChannels;
		out[f] = mono > 1 ? 1 : mono < -1 ? -1 : mono;
	}

	return { sampleRate, samples: out };
}

/** Parses UTAU oto.ini text into an alias -> timing lookup map. */
export function parseOtoTiming(otoText: string): Map<string, OtoTiming> {
	const map = new Map<string, OtoTiming>();
	for (const rawLine of otoText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const filePart = line.slice(0, eq).trim();
		const sampleKey = (filePart.replace(/\\/g, '/').split('/').pop() ?? filePart).toLowerCase();
		const fields = line.slice(eq + 1).split(',');
		const rawAlias = (fields[0] ?? '').trim();
		const alias = rawAlias || sampleKey.replace(/\.wav$/i, '');
		const num = (i: number) => {
			const n = Number.parseFloat(fields[i] ?? '0');
			return Number.isFinite(n) ? n : 0;
		};
		const entry: OtoTiming = {
			sampleKey,
			offsetMs: num(1),
			consonantMs: num(2),
			cutoffMs: num(3),
			preutteranceMs: num(4),
			overlapMs: num(5)
		};
		if (!map.has(alias)) map.set(alias, entry);
	}
	return map;
}

/** Computes the active sample window [start, end) inside a WAV according to its oto entry. */
export function otoSampleRange(
	totalSamples: number,
	sampleRate: number,
	timing?: Pick<OtoTiming, 'offsetMs' | 'cutoffMs'> | null
): [number, number] {
	if (totalSamples <= 0 || sampleRate <= 0) return [0, 0];
	if (!timing) return [0, totalSamples];
	const msToSample = sampleRate / 1000;
	const start = Math.max(0, Math.min(totalSamples - 1, Math.floor(timing.offsetMs * msToSample)));
	let end = totalSamples;
	if (timing.cutoffMs < 0) {
		end = Math.floor((timing.offsetMs - timing.cutoffMs) * msToSample);
	} else if (timing.cutoffMs > 0) {
		end = Math.floor(totalSamples - timing.cutoffMs * msToSample);
	}
	end = Math.max(0, Math.min(totalSamples, end));
	return end > start + 8 ? [start, end] : [0, totalSamples];
}

/**
 * Downsamples a PCM slice into `buckets` normalized peak amplitudes in [0, 1].
 * Returns null if the slice is empty or effectively silent.
 */
export function computeWaveformPeaks(
	samples: Float32Array,
	startSample: number,
	endSample: number,
	buckets = 96
): Float32Array | null {
	if (buckets <= 0 || !samples.length) return null;
	const start = Math.max(0, Math.min(samples.length, Math.floor(startSample)));
	const end = Math.max(start, Math.min(samples.length, Math.ceil(endSample)));
	const span = end - start;
	if (span <= 0) return null;

	const peaks = new Float32Array(buckets);
	let globalMax = 0;

	for (let b = 0; b < buckets; b++) {
		const s0 = start + Math.floor((b * span) / buckets);
		const s1 = Math.max(s0 + 1, start + Math.floor(((b + 1) * span) / buckets));
		let peak = 0;
		for (let i = s0; i < s1 && i < end; i++) {
			const abs = Math.abs(samples[i]);
			if (abs > peak) peak = abs;
		}
		peaks[b] = peak;
		if (peak > globalMax) globalMax = peak;
	}

	if (globalMax < 0.0015) return null;

	const scale = 1 / Math.max(globalMax, 0.05);
	for (let b = 0; b < buckets; b++) {
		const scaled = peaks[b] * scale;
		peaks[b] = scaled > 1 ? 1 : scaled;
	}

	return peaks;
}
