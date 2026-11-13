import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createNote, createTrack } from '#lib/core/music';
import { BLICKS_PER_QUARTER, blicksToTick, parseSvp, serializeSvp, tickToBlicks } from './svp';
import {
	CEVIO_PPQ,
	parseCevioOrVoiSona,
	parseCevioXml,
	serializeCcs,
	serializeTssln
} from './cevio';
import { parseVpr, serializeVpr } from './vpr';
import { PPQ } from '#lib/core/types';

describe('SVP (Synthesizer V Studio) format', () => {
	it('converts blicks <-> 480 PPQ ticks accurately', () => {
		expect(tickToBlicks(480)).toBe(BLICKS_PER_QUARTER);
		expect(blicksToTick(BLICKS_PER_QUARTER)).toBe(480);
		expect(blicksToTick(tickToBlicks(960))).toBe(960);
	});

	it('parses and serializes .svp tracks, notes, vibrato, and pitchDelta', () => {
		const track = createTrack(0, { name: 'Main Vocal', volume: 85 });
		track.pitchCurve = [
			[
				{ tick: 0, pitch: 60 },
				{ tick: 240, pitch: 62 },
				{ tick: 480, pitch: 60 }
			]
		];
		const notes = [
			createNote({
				track: track.id,
				tick: 0,
				length: 480,
				pitch: 60,
				lyric: 'ka',
				vibrato: { length: 70, period: 180, depth: 50, fadeIn: 20, fadeOut: 20, phase: 0 }
			}),
			createNote({ track: track.id, tick: 480, length: 480, pitch: 64, lyric: 'mi' })
		];

		const { text, warnings } = serializeSvp({
			name: 'Test SVP',
			voicebank: 'Teto SV',
			notes,
			tracks: [track],
			tempos: [
				{ tick: 0, bpm: 132 },
				{ tick: 960, bpm: 140 }
			],
			timeSignature: { numerator: 3, denominator: 4 }
		});
		expect(warnings).toEqual([]);

		const imported = parseSvp(text);
		expect(imported.tracks).toHaveLength(1);
		expect(imported.tracks[0].name).toBe('Main Vocal');
		expect(imported.tracks[0].volume).toBeCloseTo(85, -1);
		expect(imported.voicebank).toBe('Teto SV');
		expect(imported.tempos).toEqual([
			{ tick: 0, bpm: 132 },
			{ tick: 960, bpm: 140 }
		]);
		expect(imported.timeSignature).toEqual({ numerator: 3, denominator: 4 });
		expect(imported.notes.map((n) => [n.tick, n.length, n.pitch, n.lyric])).toEqual([
			[0, 480, 60, 'ka'],
			[480, 480, 64, 'mi']
		]);
		expect(imported.notes[0].vibrato).not.toBeNull();
		expect(imported.tracks[0].pitchCurve.length).toBeGreaterThan(0);
	});

	it('resolves shared library groups and continuation lyrics ("-"/"+")', () => {
		const raw = JSON.stringify({
			name: 'Lib Song',
			time: {
				meter: [{ index: 0, numerator: 4, denominator: 4 }],
				tempo: [{ position: 0, bpm: 120 }]
			},
			library: [
				{
					uuid: 'grp-1',
					notes: [
						{ onset: 0, duration: BLICKS_PER_QUARTER, lyrics: 'la', pitch: 60 },
						{ onset: BLICKS_PER_QUARTER, duration: BLICKS_PER_QUARTER, lyrics: '-', pitch: 62 }
					]
				}
			],
			tracks: [
				{
					name: 'Lead',
					mixer: { gainDecibel: 0, mute: false, solo: false },
					groups: [{ groupID: 'grp-1', blickOffset: BLICKS_PER_QUARTER, pitchOffset: 2 }]
				}
			]
		});
		const res = parseSvp(raw);
		expect(res.name).toBe('Lib Song');
		expect(res.notes).toHaveLength(2);
		expect(res.notes[0].tick).toBe(PPQ);
		expect(res.notes[0].pitch).toBe(62);
		expect(res.notes[1].lyric).toBe('la');
		expect(res.warnings.some((w) => w.includes('continuation note'))).toBe(true);
	});

	it('rejects invalid SVP JSON cleanly', () => {
		expect(() => parseSvp('{not json')).toThrow(/not valid JSON/i);
		expect(() => parseSvp('{"foo": 1}')).toThrow(/not a valid Synthesizer V/i);
	});
});

describe('CeVIO (.ccs) and VoiSona (.tssln) formats', () => {
	it('round-trips .ccs XML preserving notes, tempo, time signature, and tracks', async () => {
		const track = createTrack(0, { name: 'Kafu', volume: 100 });
		const notes = [
			createNote({ track: track.id, tick: 0, length: 480, pitch: 60, lyric: 'a' }),
			createNote({ track: track.id, tick: 480, length: 240, pitch: 69, lyric: 'ka' })
		];
		const { text } = serializeCcs({
			name: 'CeVIO Song',
			voicebank: 'KAFU_JP',
			notes,
			tracks: [track],
			tempos: [{ tick: 0, bpm: 145 }],
			timeSignature: { numerator: 4, denominator: 4 }
		});
		const imported = await parseCevioOrVoiSona(text, 'ccs');
		expect(imported.tracks).toHaveLength(1);
		expect(imported.tracks[0].name).toBe('Kafu');
		expect(imported.voicebank).toBe('KAFU_JP');
		expect(imported.tempos[0].bpm).toBe(145);
		expect(imported.notes.map((n) => [n.tick, n.length, n.pitch, n.lyric])).toEqual([
			[0, 480, 60, 'a'],
			[480, 240, 69, 'ka']
		]);
	});

	it('round-trips .tssln XML and supports ZIP-wrapped .tssln archives', async () => {
		const track = createTrack(0, { name: 'Chis-A' });
		const notes = [createNote({ track: track.id, tick: 240, length: 480, pitch: 64, lyric: 'so' })];
		const { text } = serializeTssln({
			name: 'VoiSona Song',
			voicebank: 'Chis-A_JP',
			notes,
			tracks: [track],
			tempos: [{ tick: 0, bpm: 128 }],
			timeSignature: { numerator: 6, denominator: 8 }
		});

		const plain = parseCevioXml(text, 'tssln');
		expect(plain.name).toBe('VoiSona Song');
		expect(plain.timeSignature).toEqual({ numerator: 6, denominator: 8 });
		expect(plain.notes[0].pitch).toBe(64);
		expect(plain.notes[0].lyric).toBe('so');

		const zip = new JSZip();
		zip.file('song.tssln', text);
		const archiveBytes = await zip.generateAsync({ type: 'uint8array' });
		const archived = await parseCevioOrVoiSona(archiveBytes, 'tssln');
		expect(archived.notes).toHaveLength(1);
		expect(archived.notes[0].tick).toBe(240);
		expect(CEVIO_PPQ).toBe(960);
	});
});

describe('VOCALOID5+ (.vpr) format', () => {
	it('serializes and parses .vpr ZIP archives accurately', async () => {
		const t1 = createTrack(0, { name: 'Miku' });
		const t2 = createTrack(1, { name: 'Harmony', mute: true });
		const notes = [
			createNote({ track: t1.id, tick: 0, length: 480, pitch: 67, lyric: 'mi' }),
			createNote({ track: t2.id, tick: 480, length: 480, pitch: 71, lyric: 'ku' })
		];
		const { bytes, warnings } = await serializeVpr({
			name: 'VPR Demo',
			notes,
			tracks: [t1, t2],
			tempos: [{ tick: 0, bpm: 150 }],
			timeSignature: { numerator: 4, denominator: 4 }
		});
		expect(warnings).toEqual([]);

		const imported = await parseVpr(bytes);
		expect(imported.name).toBe('VPR Demo');
		expect(imported.tracks).toHaveLength(2);
		expect(imported.tracks[1].mute).toBe(true);
		expect(imported.tempos[0].bpm).toBe(150);
		expect(imported.notes.map((n) => [n.tick, n.length, n.pitch, n.lyric])).toEqual([
			[0, 480, 67, 'mi'],
			[480, 480, 71, 'ku']
		]);
	});
});
