import { TRACK_COLORS, createNote, createTrack } from '#lib/core/music';
import { sortNotes, trimOverlaps } from '#lib/core/ops';
import { bakeCurve, simplify } from '#lib/core/pitch-curve';
import { TempoMap } from '#lib/core/tempo';
import {
	PPQ,
	type CurvePoint,
	type Note,
	type PitchStroke,
	type TempoChange,
	type TimeSignature,
	type Track,
	type Vibrato
} from '#lib/core/types';
import { decodeText } from './text';

/** Synthesizer V Studio uses 705,600,000 blicks per quarter note (480 ticks in OpenwebZ). */
export const BLICKS_PER_QUARTER = 705_600_000;

export interface SvpImport {
	name: string;
	voicebank: string;
	tempos: TempoChange[];
	timeSignature: TimeSignature;
	tracks: Track[];
	notes: Note[];
	warnings: string[];
}

export interface SvpExportInput {
	name: string;
	voicebank: string;
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
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function blicksToTick(blicks: number): number {
	return Math.round((blicks * PPQ) / BLICKS_PER_QUARTER);
}

export function tickToBlicks(tick: number): number {
	return Math.round((tick * BLICKS_PER_QUARTER) / PPQ);
}

function dbToPercent(db: number): number {
	if (db <= -24) return 0;
	const effective = db < -16 ? db * 2 + 16 : db;
	return Math.round(clamp(100 * Math.pow(10, effective / 20), 0, 150));
}

function percentToDb(percent: number): number {
	if (percent <= 0) return -24;
	const effective = 20 * Math.log10(percent / 100);
	const db = effective < -16 ? (effective - 16) / 2 : effective;
	return Math.round(clamp(db, -24, 12) * 100) / 100;
}

function normalizeColor(raw: unknown, fallback: string): string {
	if (typeof raw !== 'string') return fallback;
	const s = raw.trim();
	if (/^#[0-9a-f]{6}$/i.test(s)) return s;
	if (/^ff[0-9a-f]{6}$/i.test(s)) return `#${s.slice(2)}`;
	if (/^[0-9a-f]{6}$/i.test(s)) return `#${s}`;
	return fallback;
}

function sampleSeries(xs: number[], ys: number[], x: number): number {
	if (!xs.length) return 0;
	if (x < xs[0] || x > xs[xs.length - 1]) return 0;
	let lo = 0;
	let hi = xs.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] <= x) lo = mid;
		else hi = mid;
	}
	const span = xs[hi] - xs[lo];
	if (span <= 0) return ys[hi];
	return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / span;
}

function pitchDeltaToStrokes(
	pointsRaw: unknown,
	notes: readonly Note[],
	blickOffset: number
): PitchStroke[] {
	const raw = arr(pointsRaw);
	if (raw.length < 4) return [];
	const pairs: { x: number; y: number }[] = [];
	for (let i = 0; i + 1 < raw.length; i += 2) {
		pairs.push({ x: blicksToTick(blickOffset + num(raw[i], 0)), y: num(raw[i + 1], 0) });
	}
	pairs.sort((a, b) => a.x - b.x);
	const xs = pairs.map((p) => p.x);
	const ys = pairs.map((p) => p.y);

	const strokes: PitchStroke[] = [];
	for (const n of notes) {
		const from = n.tick;
		const to = n.tick + n.length - 1;
		if (to <= from) continue;
		const inside = pairs.filter((p) => p.x > from && p.x < to).map((p) => p.x);
		const edges = [from, ...inside, to];
		const vals = edges.map((x) => sampleSeries(xs, ys, x));
		if (vals.every((v) => Math.abs(v) < 1)) continue;
		strokes.push(edges.map((x, i): CurvePoint => ({ tick: x, pitch: n.pitch + vals[i] / 100 })));
	}
	return strokes;
}

function parseGroupNotes(
	group: Obj,
	trackId: string,
	blickOffset: number,
	pitchOffset: number,
	warnings: Set<string>
): { notes: Note[]; strokes: PitchStroke[] } {
	const rawNotes = arr(group.notes).filter(isObj);
	const notes: Note[] = [];
	let prevLyric = 'a';
	let contCount = 0;

	for (const n of rawNotes) {
		const onset = blicksToTick(blickOffset + num(n.onset, 0));
		const duration = Math.max(1, blicksToTick(num(n.duration, tickToBlicks(PPQ))));
		const pitch = Math.round(clamp(num(n.pitch, 60) + pitchOffset, 12, 119));

		let lyric = typeof n.lyrics === 'string' ? n.lyrics.trim() : 'a';
		if (lyric === '-' || lyric === '+') {
			lyric = prevLyric;
			contCount++;
		}
		if (!lyric) lyric = 'a';
		prevLyric = lyric;

		let vibrato: Vibrato | null = null;
		const attrs = isObj(n.attributes) ? n.attributes : null;
		if (attrs) {
			const depthSemis = num(attrs.dF0Vbr, 0);
			const freqHz = num(attrs.fF0Vbr, 5.5);
			const startSec = num(attrs.tF0VbrStart, 0.25);
			if (depthSemis > 0) {
				vibrato = {
					length: clamp(Math.round(startSec <= 0.2 ? 75 : 60), 10, 100),
					period: clamp(Math.round(1000 / Math.max(1, freqHz)), 50, 500),
					depth: clamp(Math.round(depthSemis * 50), 5, 200),
					fadeIn: 20,
					fadeOut: 20,
					phase: 0
				};
			}
		}

		notes.push(
			createNote({
				track: trackId,
				tick: Math.max(0, onset),
				length: duration,
				pitch,
				lyric,
				vibrato
			})
		);
	}

	if (contCount) {
		warnings.add(`${contCount} continuation note(s) ("-"/"+") repeat the previous lyric.`);
	}

	const params = isObj(group.parameters) ? group.parameters : null;
	const pitchDelta = params && isObj(params.pitchDelta) ? params.pitchDelta : null;
	const strokes = pitchDelta ? pitchDeltaToStrokes(pitchDelta.points, notes, blickOffset) : [];
	return { notes, strokes };
}

/** Parses Synthesizer V Studio project files (.svp). */
export function parseSvp(input: Uint8Array | string): SvpImport {
	const text = typeof input === 'string' ? input : decodeText(input);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`The SVP file is not valid JSON (${error instanceof Error ? error.message : error}).`,
			{ cause: error }
		);
	}
	if (!isObj(raw) || (!Array.isArray(raw.tracks) && !isObj(raw.time))) {
		throw new Error('This is not a valid Synthesizer V (.svp) project file.');
	}

	const warnings = new Set<string>();
	const timeObj = isObj(raw.time) ? raw.time : {};

	const rawTempos = arr(timeObj.tempo).filter(isObj);
	let tempos: TempoChange[] = rawTempos
		.map((t) => ({
			tick: Math.max(0, blicksToTick(num(t.position, 0))),
			bpm: num(t.bpm, 120)
		}))
		.filter((t) => t.bpm > 0)
		.sort((a, b) => a.tick - b.tick);
	if (!tempos.length) tempos = [{ tick: 0, bpm: 120 }];
	tempos = tempos.filter((t, i) => i === 0 || t.tick !== tempos[i - 1].tick);
	if (tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0].bpm });

	const rawMeters = arr(timeObj.meter).filter(isObj);
	const firstMeter = rawMeters[0];
	const timeSignature: TimeSignature = {
		numerator: Math.max(1, Math.round(num(firstMeter?.numerator, 4))),
		denominator: Math.max(1, Math.round(num(firstMeter?.denominator, 4)))
	};
	if (rawMeters.length > 1) warnings.add('Only the first time signature was kept.');

	// Index shared library note groups.
	const library = new Map<string, Obj>();
	for (const g of arr(raw.library).filter(isObj)) {
		if (typeof g.uuid === 'string') library.set(g.uuid, g);
	}

	const rawTracks = arr(raw.tracks).filter(isObj);
	const tracks: Track[] = [];
	const notes: Note[] = [];
	let voicebank = '';

	rawTracks.forEach((rt, idx) => {
		const mixer = isObj(rt.mixer) ? rt.mixer : {};
		const mainRef = isObj(rt.mainRef) ? rt.mainRef : {};
		const db = isObj(mainRef.database) ? mainRef.database : null;
		const singerName = db && typeof db.name === 'string' ? db.name.trim() : '';
		const track = createTrack(idx, {
			name: typeof rt.name === 'string' && rt.name.trim() ? rt.name.trim() : `Track ${idx + 1}`,
			color: normalizeColor(rt.dispColor, TRACK_COLORS[idx % TRACK_COLORS.length]),
			...(singerName ? { singer: singerName } : {}),
			mute: mixer.mute === true,
			solo: mixer.solo === true,
			volume: dbToPercent(num(mixer.gainDecibel, 0))
		});

		if (!voicebank && singerName) {
			voicebank = singerName;
		}

		const trackNotes: Note[] = [];
		const trackStrokes: PitchStroke[] = [];

		if (isObj(rt.mainGroup)) {
			const res = parseGroupNotes(
				rt.mainGroup,
				track.id,
				num(mainRef.blickOffset, 0),
				num(mainRef.pitchOffset, 0),
				warnings
			);
			trackNotes.push(...res.notes);
			trackStrokes.push(...res.strokes);
		}

		for (const ref of arr(rt.groups).filter(isObj)) {
			const id = typeof ref.groupID === 'string' ? ref.groupID : '';
			const libGroup = library.get(id);
			if (!libGroup) continue;
			const res = parseGroupNotes(
				libGroup,
				track.id,
				num(ref.blickOffset, 0),
				num(ref.pitchOffset, 0),
				warnings
			);
			trackNotes.push(...res.notes);
			trackStrokes.push(...res.strokes);
		}

		track.pitchCurve = trackStrokes.sort((a, b) => a[0].tick - b[0].tick);
		tracks.push(track);
		notes.push(...trackNotes);
	});

	if (!tracks.length) tracks.push(createTrack(0));

	return {
		name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Imported SVP',
		voicebank,
		tempos,
		timeSignature,
		tracks,
		notes: sortNotes(notes),
		warnings: [...warnings]
	};
}

/** Exports project to Synthesizer V Studio (.svp) JSON format. */
export function serializeSvp(input: SvpExportInput): { text: string; warnings: string[] } {
	const warnings: string[] = [];
	const tempoMap = new TempoMap([...input.tempos]);
	let overlapped = false;

	const svpTracks = input.tracks.map((track, idx) => {
		const own = input.notes.filter((n) => n.track === track.id);
		const trimmed = trimOverlaps(own);
		if (trimmed.some((n, i) => n.length !== own[i].length)) overlapped = true;
		const baked = bakeCurve(sortNotes(trimmed), track, tempoMap);

		const svpNotes = baked.map((n) => ({
			onset: tickToBlicks(n.tick),
			duration: tickToBlicks(n.length),
			lyrics: n.lyric || 'a',
			phonemes: '',
			pitch: n.pitch,
			detune: 0,
			attributes: n.vibrato
				? {
						tF0VbrStart: Number((((100 - n.vibrato.length) / 100) * 0.5).toFixed(3)),
						tF0VbrLeft: Number((n.vibrato.fadeIn / 100).toFixed(3)),
						tF0VbrRight: Number((n.vibrato.fadeOut / 100).toFixed(3)),
						dF0Vbr: Number((n.vibrato.depth / 50).toFixed(3)),
						fF0Vbr: Number((1000 / Math.max(50, n.vibrato.period)).toFixed(2))
					}
				: {}
		}));

		// Export track pitch strokes as pitchDelta points when present.
		const deltaPoints: number[] = [];
		for (const stroke of track.pitchCurve) {
			if (stroke.length < 2) continue;
			const simple = simplify(stroke, 0.02);
			for (const pt of simple) {
				const cov = baked.find((n) => pt.tick >= n.tick && pt.tick <= n.tick + n.length);
				if (!cov) continue;
				deltaPoints.push(tickToBlicks(pt.tick), Math.round((pt.pitch - cov.pitch) * 100));
			}
		}

		const uuid = `openwebz-track-${idx + 1}`;
		return {
			name: track.name,
			dispColor: track.color,
			dispOrder: idx,
			renderEnabled: true,
			mixer: {
				gainDecibel: percentToDb(track.volume),
				pan: 0,
				mute: track.mute,
				solo: track.solo,
				display: true
			},
			mainGroup: {
				name: track.name,
				uuid,
				parameters: {
					pitchDelta: { mode: 'linear', points: deltaPoints },
					vibratoEnv: { mode: 'cubic', points: [] },
					loudness: { mode: 'cubic', points: [] },
					tension: { mode: 'cubic', points: [] },
					breathiness: { mode: 'cubic', points: [] },
					voicing: { mode: 'cubic', points: [] },
					gender: { mode: 'cubic', points: [] }
				},
				notes: svpNotes
			},
			mainRef: {
				groupID: uuid,
				blickAbsolute: 0,
				blickOffset: 0,
				pitchOffset: 0,
				isInstrumental: false,
				database: {
					name: track.singer || input.voicebank || '',
					language: 'japanese',
					phoneset: 'romaji',
					backendType: 'SVR2'
				},
				dictionary: '',
				voice: {}
			},
			groups: []
		};
	});

	if (overlapped) {
		warnings.push('Overlapping notes were shortened: Synthesizer V tracks hold one voice.');
	}

	const svp = {
		version: 113,
		time: {
			meter: [
				{
					index: 0,
					numerator: input.timeSignature.numerator,
					denominator: input.timeSignature.denominator
				}
			],
			tempo: input.tempos.map((t) => ({
				position: tickToBlicks(t.tick),
				bpm: t.bpm
			}))
		},
		library: [],
		tracks: svpTracks,
		renderConfig: {
			destination: '',
			filename: input.name,
			numChannels: 1,
			aspirationFormat: 'noAspiration',
			bitDepth: 16,
			sampleRate: 44100,
			exportMixDown: true
		}
	};

	return { text: JSON.stringify(svp, null, '\t'), warnings };
}
