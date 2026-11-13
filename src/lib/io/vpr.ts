import JSZip from 'jszip';
import { createNote, createTrack } from '#lib/core/music';
import { sortNotes, trimOverlaps } from '#lib/core/ops';
import { PPQ, type Note, type TempoChange, type TimeSignature, type Track } from '#lib/core/types';

export interface VprImport {
	name: string;
	tempos: TempoChange[];
	timeSignature: TimeSignature;
	tracks: Track[];
	notes: Note[];
	warnings: string[];
}

export interface VprExportInput {
	name: string;
	notes: readonly Note[];
	tracks: readonly Track[];
	tempos: readonly TempoChange[];
	timeSignature: TimeSignature;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, fallback: number): number => {
	const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : fallback;
};

/** Parses VOCALOID5 / VOCALOID6 (.vpr) archives containing Project/sequence.json. */
export async function parseVpr(
	bytes: Uint8Array,
	fallbackName = 'Imported VPR'
): Promise<VprImport> {
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(bytes);
	} catch (error) {
		throw new Error(
			`The VPR file is not a valid archive (${error instanceof Error ? error.message : error}).`,
			{ cause: error }
		);
	}

	const seqPath = Object.keys(zip.files).find(
		(p) =>
			!zip.files[p].dir && p.replace(/\\/g, '/').toLowerCase().endsWith('project/sequence.json')
	);
	if (!seqPath) {
		throw new Error(
			'This is not a valid VOCALOID5+ (.vpr) file: Project/sequence.json is missing.'
		);
	}

	const seq = JSON.parse(await zip.files[seqPath].async('string')) as unknown;
	if (!isObj(seq)) throw new Error('Invalid sequence.json in VPR archive.');

	const warnings: string[] = [];
	const master = isObj(seq.masterTrack) ? seq.masterTrack : {};
	const tempoObj = isObj(master.tempo) ? master.tempo : {};
	const rawTempos = arr(tempoObj.events).filter(isObj);
	let tempos: TempoChange[] = rawTempos
		.map((e) => ({
			tick: Math.max(0, Math.round(num(e.pos, 0))),
			bpm: num(e.value, 12000) / 100
		}))
		.filter((t) => t.bpm > 0)
		.sort((a, b) => a.tick - b.tick);
	if (!tempos.length) tempos = [{ tick: 0, bpm: 120 }];
	tempos = tempos.filter((t, i) => i === 0 || t.tick !== tempos[i - 1].tick);
	if (tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0].bpm });

	const tsObj = isObj(master.timeSig) ? master.timeSig : {};
	const firstTs = arr(tsObj.events).filter(isObj)[0];
	const timeSignature: TimeSignature = {
		numerator: Math.max(1, Math.round(num(firstTs?.numer, 4))),
		denominator: Math.max(1, Math.round(num(firstTs?.denom, 4)))
	};

	const tracks: Track[] = [];
	const notes: Note[] = [];

	arr(seq.tracks)
		.filter(isObj)
		.forEach((rt, idx) => {
			const parts = arr(rt.parts).filter(isObj);
			const trackNotes: Note[] = [];
			const track = createTrack(idx, {
				name: typeof rt.name === 'string' && rt.name.trim() ? rt.name.trim() : `Track ${idx + 1}`,
				mute: rt.isMuted === true,
				solo: rt.isSoloMode === true
			});

			for (const part of parts) {
				const partPos = Math.max(0, Math.round(num(part.pos, 0)));
				for (const n of arr(part.notes).filter(isObj)) {
					const tick = partPos + Math.max(0, Math.round(num(n.pos, 0)));
					const length = Math.max(1, Math.round(num(n.duration, PPQ / 2)));
					const pitch = Math.max(12, Math.min(119, Math.round(num(n.number, 60))));
					const lyric = typeof n.lyric === 'string' && n.lyric.trim() ? n.lyric.trim() : 'a';
					trackNotes.push(createNote({ track: track.id, tick, length, pitch, lyric }));
				}
			}
			if (trackNotes.length) {
				tracks.push(track);
				notes.push(...trackNotes);
			}
		});

	if (!tracks.length) tracks.push(createTrack(0));

	return {
		name: typeof seq.title === 'string' && seq.title.trim() ? seq.title.trim() : fallbackName,
		tempos,
		timeSignature,
		tracks,
		notes: sortNotes(notes),
		warnings
	};
}

/** Exports project to a VOCALOID5+ (.vpr) ZIP archive. */
export async function serializeVpr(
	input: VprExportInput
): Promise<{ bytes: Uint8Array<ArrayBuffer>; warnings: string[] }> {
	const warnings: string[] = [];
	let overlapped = false;

	const vprTracks = input.tracks.map((track, idx) => {
		const own = input.notes.filter((n) => n.track === track.id);
		const trimmed = trimOverlaps(own);
		if (trimmed.some((n, i) => n.length !== own[i].length)) overlapped = true;
		const sorted = sortNotes(trimmed);
		const endTick = sorted.reduce((m, n) => Math.max(m, n.tick + n.length), PPQ * 4);

		return {
			type: 0,
			name: track.name,
			color: idx % 10,
			busNo: 0,
			isFolded: false,
			height: 0,
			volume: { isFolded: true, height: 24, events: [{ pos: 0, value: 0 }] },
			panpot: { isFolded: true, height: 24, events: [{ pos: 0, value: 0 }] },
			isMuted: track.mute,
			isSoloMode: track.solo,
			parts: [
				{
					pos: 0,
					duration: endTick,
					styleName: 'No Effect',
					voice: { compID: 'WEBTAU', langID: 0 },
					notes: sorted.map((n) => ({
						lyric: n.lyric || 'a',
						phoneme: 'a',
						isProtected: false,
						pos: n.tick,
						duration: n.length,
						number: n.pitch,
						velocity: Math.round(n.velocity),
						exp: { opening: 127 },
						singingSkill: { duration: 64, weight: { pre: 64, post: 64 } },
						vibrato: { type: 0, duration: 0 }
					}))
				}
			]
		};
	});

	if (overlapped) {
		warnings.push('Overlapping notes were shortened: VOCALOID tracks hold one voice.');
	}

	const sequence = {
		version: { major: 5, minor: 0, revision: 0 },
		vender: 'WebTAU',
		title: input.name,
		masterTrack: {
			samplingRate: 44100,
			loop: { isEnabled: false, begin: 0, end: PPQ * 16 },
			tempo: {
				isFolded: false,
				height: 24,
				global: { isEnabled: false, value: Math.round((input.tempos[0]?.bpm ?? 120) * 100) },
				events: input.tempos.map((t) => ({ pos: t.tick, value: Math.round(t.bpm * 100) }))
			},
			timeSig: {
				isFolded: false,
				events: [
					{
						bar: 0,
						numer: input.timeSignature.numerator,
						denom: input.timeSignature.denominator
					}
				]
			},
			volume: { isFolded: true, height: 24, events: [{ pos: 0, value: 0 }] }
		},
		tracks: vprTracks
	};

	const zip = new JSZip();
	zip.file('Project/sequence.json', JSON.stringify(sequence));
	const bytes = (await zip.generateAsync({ type: 'uint8array' })) as Uint8Array<ArrayBuffer>;
	return { bytes, warnings };
}
