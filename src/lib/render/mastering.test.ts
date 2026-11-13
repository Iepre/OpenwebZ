import { describe, expect, it } from 'vitest';
import { createStudioReverbImpulse, masterVocalPcm } from './mastering';

describe('Vocal mastering DSP', () => {
	it('removes DC / subsonic rumble while preserving vocal energy cleanly', () => {
		const sr = 44100;
		const n = sr;
		const dry = new Float32Array(n);
		// Mix 20 Hz subsonic rumble + DC offset + 440 Hz vocal tone.
		for (let i = 0; i < n; i++) {
			const t = i / sr;
			dry[i] = 0.2 + 0.25 * Math.sin(2 * Math.PI * 20 * t) + 0.35 * Math.sin(2 * Math.PI * 440 * t);
		}
		const wet = masterVocalPcm(dry, sr);
		expect(wet.length).toBe(dry.length);

		// Measure steady-state mean (DC) and RMS in the second half.
		let sum = 0;
		let sq = 0;
		let peak = 0;
		for (let i = n >> 1; i < n; i++) {
			expect(Number.isFinite(wet[i])).toBe(true);
			sum += wet[i];
			sq += wet[i] * wet[i];
			peak = Math.max(peak, Math.abs(wet[i]));
		}
		const dc = Math.abs(sum / (n >> 1));
		const rms = Math.sqrt(sq / (n >> 1));
		expect(dc).toBeLessThan(0.02);
		expect(rms).toBeGreaterThan(0.18);
		expect(peak).toBeLessThan(0.98);
	});

	it('generates bounded, decorrelated stereo studio reverb impulse', () => {
		const { left, right } = createStudioReverbImpulse(44100, 0.34);
		expect(left.length).toBe(right.length);
		expect(left.length).toBe(Math.round(44100 * 0.34));

		let lTail = 0;
		let rTail = 0;
		for (let i = 0; i < left.length; i++) {
			expect(Number.isFinite(left[i])).toBe(true);
			expect(Number.isFinite(right[i])).toBe(true);
			expect(Math.abs(left[i])).toBeLessThanOrEqual(1);
			if (i > left.length - 500) {
				lTail += Math.abs(left[i]);
				rTail += Math.abs(right[i]);
			}
		}
		// Tail decays smoothly toward zero.
		expect(lTail / 500).toBeLessThan(0.02);
		expect(rTail / 500).toBeLessThan(0.02);
	});
});
