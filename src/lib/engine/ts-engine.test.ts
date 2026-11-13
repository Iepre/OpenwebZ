import { describe, expect, it } from 'vitest';
import {
	SAMPLE_RATE,
	TsEngineInstance,
	analyzeWavBytes,
	computeTiming,
	decodeFeatures,
	decodeWav,
	parseOtoIni,
	parsePrefixMap
} from './ts-engine';
import type { EngineNote } from './bridge';

function makeSineWav(
	freqHz: number,
	durationSec: number,
	sr = SAMPLE_RATE
): Uint8Array<ArrayBuffer> {
	const numSamples = Math.round(sr * durationSec);
	const buf = new ArrayBuffer(44 + numSamples * 2);
	const view = new DataView(buf);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};
	writeStr(0, 'RIFF');
	view.setUint32(4, 36 + numSamples * 2, true);
	writeStr(8, 'WAVE');
	writeStr(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sr, true);
	view.setUint32(28, sr * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeStr(36, 'data');
	view.setUint32(40, numSamples * 2, true);
	for (let i = 0; i < numSamples; i++) {
		const s = Math.sin((2 * Math.PI * freqHz * i) / sr) * 0.45;
		view.setInt16(44 + i * 2, Math.round(s * 32767), true);
	}
	return new Uint8Array(buf);
}

describe('Pure-TS synthesis engine DSP primitives', () => {
	it('decodes 16-bit PCM WAV files and resamples to 44100 Hz', () => {
		const wav = makeSineWav(220, 0.4, SAMPLE_RATE);
		const decoded = decodeWav(wav);
		expect(decoded).not.toBeNull();
		const { pcm } = decoded!;
		expect(pcm.length).toBe(Math.round(SAMPLE_RATE * 0.4));
		let peak = 0;
		for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
		expect(peak).toBeGreaterThan(0.4);
		expect(peak).toBeLessThan(0.5);
	});

	it('parses oto.ini and prefix.map deterministically', () => {
		const otoText = new TextEncoder().encode(
			'# comment\na.wav=a,25,110,-40,30,15\nka.wav=,10,95,-35,20,10\n'
		);
		const oto = parseOtoIni(otoText);
		expect(oto.get('a')).toEqual({
			filename: 'a.wav',
			alias: 'a',
			offset: 25,
			consonant: 110,
			cutoff: -40,
			preutterance: 30,
			overlap: 15
		});
		expect(oto.get('ka')?.filename).toBe('ka.wav');

		const pmap = parsePrefixMap(new TextEncoder().encode('C4=soft_\t_lo\n64=hi_\t\n'));
		expect(pmap.get(60)).toEqual({ prefix: 'soft_', suffix: '_lo' });
		expect(pmap.get(64)).toEqual({ prefix: 'hi_', suffix: '' });
	});

	it('computes neighbor timing without overlap exceeding gap', () => {
		const res = computeTiming([
			{ start: 0, duration: 400, preutter: 20, overlap: 10 },
			{ start: 400, duration: 400, preutter: 50, overlap: 25 }
		]);
		expect(res).toHaveLength(2);
		expect(res[1].overlap).toBeLessThanOrEqual(25);
		expect(res[0].tailAdjust).toBe(-25);
	});

	it('analyzes WAV into binary WTFA features and detects approximate F0', () => {
		const wav = makeSineWav(261.63, 0.5);
		const featBytes = analyzeWavBytes(wav, 0);
		expect(featBytes).not.toBeNull();
		const parsed = decodeFeatures(featBytes!);
		expect(parsed).not.toBeNull();
		expect(parsed!.sampleRate).toBe(SAMPLE_RATE);
		expect(parsed!.baseF0).toBeGreaterThan(220);
		expect(parsed!.baseF0).toBeLessThan(300);
	});
});

describe('TsEngineInstance session & streaming pipeline', () => {
	function setupEngine() {
		const engine = new TsEngineInstance();
		const oto = new TextEncoder().encode('a.wav=a,20,100,-50,25,15\n');
		expect(engine.loadOto(oto)).toBe(true);
		const wav = makeSineWav(220, 0.6);
		const feat = analyzeWavBytes(wav, 0);
		expect(feat).not.toBeNull();
		expect(engine.cacheFeatures('a.wav', feat!)).toBe(true);
		return engine;
	}

	it('renders notes via batch session, caches repeats, and produces valid audio', () => {
		const engine = setupEngine();
		const notes: EngineNote[] = [
			{
				start_time: 0,
				duration: 450,
				pitch: 64,
				alias: 'a',
				flags: 'g5fe1',
				velocity: 100,
				volume: 100,
				modulation: 0,
				pitchbend: [
					{ offset: 0, value: 0 },
					{ offset: 200, value: 1.5 },
					{ offset: 400, value: 0 }
				]
			},
			{
				start_time: 450,
				duration: 450,
				pitch: 67,
				alias: 'a',
				flags: 'A10B60',
				velocity: 100,
				volume: 100,
				modulation: 0,
				pitchbend: []
			}
		];

		expect(engine.beginSession(notes, 120)).toBe(2);
		expect(engine.step(1)).toBe(1);
		expect(engine.step(1)).toBe(0);
		const pcm1 = engine.finish();
		expect(pcm1).not.toBeNull();
		let peak = 0;
		for (let i = 0; i < pcm1!.length; i++) {
			expect(Number.isFinite(pcm1![i])).toBe(true);
			peak = Math.max(peak, Math.abs(pcm1![i]));
		}
		expect(peak).toBeGreaterThan(0.1);
		expect(engine.report().rendered).toBe(2);

		// Second identical render should reuse cached note PCMs.
		expect(engine.beginSession(notes, 120)).toBe(2);
		expect(engine.step(2)).toBe(0);
		engine.finish();
		expect(engine.report().cached).toBe(2);
		expect(engine.report().rendered).toBe(0);
	});

	it('supports progressive streaming read & renderOneshot without corrupting stream', () => {
		const engine = setupEngine();
		const notes: EngineNote[] = [
			{
				start_time: 0,
				duration: 500,
				pitch: 60,
				alias: 'a',
				flags: '',
				velocity: 100,
				volume: 100,
				modulation: 0,
				pitchbend: []
			}
		];
		expect(engine.beginSession(notes, 120)).toBe(1);
		const plan = engine.plan();
		expect(plan).toHaveLength(1);
		expect(engine.renderPlanned([0])).toBe(0);
		const chunk = engine.read(0, 8192);
		expect(chunk).not.toBeNull();
		expect(chunk!.some((x) => Math.abs(x) > 0.01)).toBe(true);

		const oneshot = engine.renderOneshot(notes, 120);
		expect(oneshot).not.toBeNull();
		expect(oneshot!.pcm.some((x) => Math.abs(x) > 0.01)).toBe(true);

		expect(engine.endStream(true)).toBe(true);
	});
});
