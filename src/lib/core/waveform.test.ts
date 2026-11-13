import { describe, expect, it } from 'vitest';
import { computeWaveformPeaks, otoSampleRange, parseOtoTiming, parseWavSamples } from './waveform';

function buildWav({
	audioFormat,
	channels,
	sampleRate,
	bitsPerSample,
	frames
}: {
	audioFormat: number;
	channels: number;
	sampleRate: number;
	bitsPerSample: number;
	frames: number[][];
}): Uint8Array {
	const bytesPerSample = bitsPerSample >> 3;
	const dataSize = frames.length * channels * bytesPerSample;
	const buf = new ArrayBuffer(44 + dataSize);
	const bytes = new Uint8Array(buf);
	const view = new DataView(buf);

	const writeAscii = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
	};

	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, audioFormat, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true);
	view.setUint16(32, channels * bytesPerSample, true);
	view.setUint16(34, bitsPerSample, true);
	writeAscii(36, 'data');
	view.setUint32(40, dataSize, true);

	let pos = 44;
	for (const frame of frames) {
		for (let ch = 0; ch < channels; ch++) {
			const v = frame[ch] ?? 0;
			if (audioFormat === 1 && bitsPerSample === 16) {
				view.setInt16(pos, Math.round(v * 32767), true);
			} else if (audioFormat === 1 && bitsPerSample === 8) {
				bytes[pos] = Math.round(v * 127 + 128);
			} else if (audioFormat === 3 && bitsPerSample === 32) {
				view.setFloat32(pos, v, true);
			}
			pos += bytesPerSample;
		}
	}
	return bytes;
}

describe('waveform utilities', () => {
	it('parses mono 16-bit PCM WAV bytes', () => {
		const wav = buildWav({
			audioFormat: 1,
			channels: 1,
			sampleRate: 44100,
			bitsPerSample: 16,
			frames: [[0], [0.5], [-1], [0.25]]
		});
		const parsed = parseWavSamples(wav);
		expect(parsed).not.toBeNull();
		expect(parsed!.sampleRate).toBe(44100);
		expect(parsed!.samples.length).toBe(4);
		expect(parsed!.samples[0]).toBeCloseTo(0, 3);
		expect(parsed!.samples[1]).toBeCloseTo(0.5, 3);
		expect(parsed!.samples[2]).toBeCloseTo(-1, 3);
		expect(parsed!.samples[3]).toBeCloseTo(0.25, 3);
	});

	it('downmixes stereo 32-bit float WAV bytes to mono', () => {
		const wav = buildWav({
			audioFormat: 3,
			channels: 2,
			sampleRate: 48000,
			bitsPerSample: 32,
			frames: [
				[0.8, 0.2],
				[-0.4, 0.4]
			]
		});
		const parsed = parseWavSamples(wav);
		expect(parsed).not.toBeNull();
		expect(parsed!.sampleRate).toBe(48000);
		expect(parsed!.samples[0]).toBeCloseTo(0.5, 4);
		expect(parsed!.samples[1]).toBeCloseTo(0, 4);
	});

	it('returns null for truncated or non-WAV bytes', () => {
		expect(parseWavSamples(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(parseWavSamples(new Uint8Array(64))).toBeNull();
	});

	it('parses oto.ini timings and computes sample windows', () => {
		const oto = parseOtoTiming(
			['# comment', 'sub/ka.wav=か,100,50,-300,40,20', 'a.wav=,50,20,100,10,5'].join('\n')
		);
		expect(oto.get('か')).toEqual({
			sampleKey: 'ka.wav',
			offsetMs: 100,
			consonantMs: 50,
			cutoffMs: -300,
			preutteranceMs: 40,
			overlapMs: 20
		});
		expect(oto.get('a')?.sampleKey).toBe('a.wav');

		// Negative cutoff sets explicit duration from offset (100ms -> 400ms)
		expect(otoSampleRange(44100, 44100, oto.get('か'))).toEqual([4410, 17640]);
		// Positive cutoff trims from end of file (50ms -> 900ms on a 1000ms file)
		expect(otoSampleRange(44100, 44100, oto.get('a'))).toEqual([2205, 39690]);
	});

	it('computes normalized peak buckets and suppresses silence', () => {
		const silence = new Float32Array(1000);
		expect(computeWaveformPeaks(silence, 0, 1000, 16)).toBeNull();

		const samples = new Float32Array(100);
		samples[10] = 0.25;
		samples[60] = -0.5;
		const peaks = computeWaveformPeaks(samples, 0, 100, 4)!;
		expect(peaks.length).toBe(4);
		expect(peaks[0]).toBeCloseTo(0.5, 4);
		expect(peaks[1]).toBe(0);
		expect(peaks[2]).toBeCloseTo(1.0, 4);
		expect(peaks[3]).toBe(0);
	});
});
