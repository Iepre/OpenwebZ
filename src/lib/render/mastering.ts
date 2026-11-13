/**
 * Pure vocal mastering DSP primitives shared between WAV export and WebAudio
 * stereo room impulse generation. Keeps subsonic rumble clean, adds gentle
 * vocal presence/air, and applies soft ceiling protection without artifacts.
 */

export type VocalPolishMode = 'studio' | 'dry';

interface BiquadCoeffs {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

function highpassCoeffs(freqHz: number, q: number, sampleRate: number): BiquadCoeffs {
	const w0 = (2 * Math.PI * freqHz) / sampleRate;
	const cosW = Math.cos(w0);
	const alpha = Math.sin(w0) / (2 * q);
	const a0 = 1 + alpha;
	return {
		b0: (1 + cosW) / 2 / a0,
		b1: -(1 + cosW) / a0,
		b2: (1 + cosW) / 2 / a0,
		a1: (-2 * cosW) / a0,
		a2: (1 - alpha) / a0
	};
}

function peakingCoeffs(
	freqHz: number,
	q: number,
	gainDb: number,
	sampleRate: number
): BiquadCoeffs {
	const a = Math.pow(10, gainDb / 40);
	const w0 = (2 * Math.PI * freqHz) / sampleRate;
	const cosW = Math.cos(w0);
	const alpha = Math.sin(w0) / (2 * q);
	const a0 = 1 + alpha / a;
	return {
		b0: (1 + alpha * a) / a0,
		b1: (-2 * cosW) / a0,
		b2: (1 - alpha * a) / a0,
		a1: (-2 * cosW) / a0,
		a2: (1 - alpha / a) / a0
	};
}

function highShelfCoeffs(freqHz: number, gainDb: number, sampleRate: number): BiquadCoeffs {
	const a = Math.pow(10, gainDb / 40);
	const w0 = (2 * Math.PI * freqHz) / sampleRate;
	const cosW = Math.cos(w0);
	const sinW = Math.sin(w0);
	const beta = Math.sqrt(a) / Math.SQRT1_2; // slope = 1
	const ap1 = a + 1;
	const am1 = a - 1;
	const a0 = ap1 - am1 * cosW + beta * sinW;
	return {
		b0: (a * (ap1 + am1 * cosW + beta * sinW)) / a0,
		b1: (-2 * a * (am1 + ap1 * cosW)) / a0,
		b2: (a * (ap1 + am1 * cosW - beta * sinW)) / a0,
		a1: (2 * (am1 - ap1 * cosW)) / a0,
		a2: (ap1 - am1 * cosW - beta * sinW) / a0
	};
}

function applyBiquadInPlace(pcm: Float32Array, c: BiquadCoeffs) {
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	for (let i = 0; i < pcm.length; i++) {
		const x0 = pcm[i];
		const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
		x2 = x1;
		x1 = x0;
		y2 = y1;
		y1 = y0;
		pcm[i] = Number.isFinite(y0) ? y0 : 0;
	}
}

/**
 * Applies studio vocal polish to mono PCM:
 *  - 65 Hz subsonic rumble cut
 *  - subtle 320 Hz boxiness trim (-1.0 dB)
 *  - vocal clarity presence (+1.6 dB @ 3.2 kHz)
 *  - silky air shelf (+1.2 dB @ 10.5 kHz)
 *  - transparent soft-knee harmonic warmth above 0.86
 */
export function masterVocalPcm(pcm: Float32Array, sampleRate = 44100): Float32Array {
	const out = pcm.slice();
	if (out.length === 0) return out;

	applyBiquadInPlace(out, highpassCoeffs(65, Math.SQRT1_2, sampleRate));
	applyBiquadInPlace(out, peakingCoeffs(320, 0.9, -1.0, sampleRate));
	applyBiquadInPlace(out, peakingCoeffs(3200, 0.85, 1.6, sampleRate));
	applyBiquadInPlace(out, highShelfCoeffs(10500, 1.2, sampleRate));

	for (let i = 0; i < out.length; i++) {
		let s = out[i];
		if (s > 0.86) s = 0.86 + 0.11 * Math.tanh((s - 0.86) / 0.28);
		else if (s < -0.86) s = -0.86 - 0.11 * Math.tanh((-s - 0.86) / 0.28);
		out[i] = s;
	}
	return out;
}

/**
 * Generates a deterministic, damped stereo room impulse response (~0.34 s)
 * for transparent studio vocal depth without muddy tails.
 */
export function createStudioReverbImpulse(
	sampleRate = 44100,
	durationSec = 0.34
): { left: Float32Array; right: Float32Array } {
	const length = Math.max(64, Math.round(sampleRate * durationSec));
	const left = new Float32Array(length);
	const right = new Float32Array(length);

	let stateL = 0x9e3779b9;
	let stateR = 0x85ebca6b;
	let lpL = 0;
	let lpR = 0;
	const preDelaySamples = Math.round(0.011 * sampleRate);

	for (let i = preDelaySamples; i < length; i++) {
		const t = (i - preDelaySamples) / Math.max(1, length - preDelaySamples);
		const env = Math.pow(1 - t, 2.8) * Math.exp(-3.4 * t);

		stateL = (Math.imul(stateL, 1664525) + 1013904223) >>> 0;
		stateR = (Math.imul(stateR, 22695477) + 1) >>> 0;
		const wL = (stateL / 0xffffffff) * 2 - 1;
		const wR = (stateR / 0xffffffff) * 2 - 1;

		// One-pole dark air damping so reverb tails stay silky, never metallic.
		lpL = lpL * 0.62 + wL * 0.38;
		lpR = lpR * 0.62 + wR * 0.38;

		left[i] = lpL * env;
		right[i] = lpR * env;
	}

	// Sparse early reflections give crisp acoustic space before diffuse tail.
	const taps = [0.014, 0.023, 0.037, 0.053];
	for (let k = 0; k < taps.length; k++) {
		const idx = Math.min(length - 1, Math.round(taps[k] * sampleRate));
		const g = 0.28 * Math.pow(0.72, k);
		left[idx] += (k % 2 === 0 ? 1 : -0.8) * g;
		right[Math.min(length - 1, idx + 19)] += (k % 2 === 0 ? -0.85 : 1) * g;
	}

	return { left, right };
}
