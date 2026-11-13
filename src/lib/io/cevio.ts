import JSZip from 'jszip';
import { TRACK_COLORS, createNote, createTrack } from '#lib/core/music';
import { sortNotes, trimOverlaps } from '#lib/core/ops';
import { PPQ, type Note, type TempoChange, type TimeSignature, type Track } from '#lib/core/types';
import { decodeText } from './text';

/** CeVIO Creative Studio / CeVIO AI / VoiSona use 960 clocks per quarter note. */
export const CEVIO_PPQ = 960;

export interface CevioImport {
	name: string;
	voicebank: string;
	tempos: TempoChange[];
	timeSignature: TimeSignature;
	tracks: Track[];
	notes: Note[];
	warnings: string[];
}

export interface CevioExportInput {
	name: string;
	voicebank: string;
	notes: readonly Note[];
	tracks: readonly Track[];
	tempos: readonly TempoChange[];
	timeSignature: TimeSignature;
}

const STEP_MAP: Record<string, number> = {
	c: 0,
	'c#': 1,
	db: 1,
	d: 2,
	'd#': 3,
	eb: 3,
	e: 4,
	f: 5,
	'f#': 6,
	gb: 6,
	g: 7,
	'g#': 8,
	ab: 8,
	a: 9,
	'a#': 10,
	bb: 10,
	b: 11
};

function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')
		.trim();
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function parseAttrs(attrString: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const m of attrString.matchAll(/([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		attrs[m[1].toLowerCase()] = decodeXml(m[2] ?? m[3] ?? '');
	}
	return attrs;
}

function findElements(xml: string, tag: string): { attrs: Record<string, string>; body: string }[] {
	const out: { attrs: Record<string, string>; body: string }[] = [];
	const re = new RegExp(`<${tag}(?:\\s([^>]*?))?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi');
	for (const m of xml.matchAll(re)) {
		out.push({ attrs: parseAttrs(m[1] ?? ''), body: m[2] ?? '' });
	}
	return out;
}

function childText(body: string, tag: string): string | undefined {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
	const m = re.exec(body);
	return m ? decodeXml(m[1]) : undefined;
}

function parseMidiPitch(attrs: Record<string, string>, body: string): number {
	const directMidi = Number(attrs.pitch ?? attrs.notenum ?? childText(body, 'Pitch') ?? NaN);
	if (Number.isFinite(directMidi) && !('pitchoctave' in attrs) && !('pitchstep' in attrs)) {
		return Math.max(12, Math.min(119, Math.round(directMidi)));
	}
	const octRaw = attrs.pitchoctave ?? childText(body, 'PitchOctave') ?? '4';
	const stepRaw = attrs.pitchstep ?? childText(body, 'PitchStep') ?? '0';
	const oct = Number.isFinite(Number(octRaw)) ? Number(octRaw) : 4;
	const step = Number.isFinite(Number(stepRaw))
		? Number(stepRaw)
		: (STEP_MAP[stepRaw.toLowerCase()] ?? 0);
	// CeVIO convention: PitchOctave=4, PitchStep=0 -> C4 = MIDI 60.
	return Math.max(12, Math.min(119, Math.round((oct + 1) * 12 + step)));
}

function parseClockOffset(startTime: string | undefined, bpm: number): number {
	if (!startTime) return 0;
	const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(startTime.trim());
	if (!m) return 0;
	const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
	return Math.max(0, Math.round((sec * bpm * PPQ) / 60));
}

function extractXmlNotes(xml: string, trackId: string, scale: number, tickOffset: number): Note[] {
	const notes: Note[] = [];
	for (const el of findElements(xml, 'Note')) {
		const clock = Number(el.attrs.clock ?? el.attrs.tick ?? childText(el.body, 'Clock') ?? 0);
		const dur = Number(
			el.attrs.duration ?? el.attrs.length ?? childText(el.body, 'Duration') ?? CEVIO_PPQ / 2
		);
		const lyric = el.attrs.lyric ?? childText(el.body, 'Lyric') ?? 'a';
		const doReMiOrR = lyric.trim();
		if (!Number.isFinite(clock) || !Number.isFinite(dur)) continue;

		notes.push(
			createNote({
				track: trackId,
				tick: Math.max(0, tickOffset + Math.round(clock * scale)),
				length: Math.max(1, Math.round(dur * scale)),
				pitch: parseMidiPitch(el.attrs, el.body),
				lyric: doReMiOrR || 'a'
			})
		);
	}
	return notes;
}

function extractXmlTempos(xml: string, scale: number): TempoChange[] {
	const tempos: TempoChange[] = [];
	for (const t of findElements(xml, 'Sound')) {
		const clock = Number(t.attrs.clock ?? 0);
		const bpm = Number(t.attrs.tempo ?? t.attrs.bpm ?? NaN);
		if (Number.isFinite(bpm) && bpm > 0) {
			tempos.push({ tick: Math.max(0, Math.round(clock * scale)), bpm });
		}
	}
	tempos.sort((a, b) => a.tick - b.tick);
	const deduped = tempos.filter((t, i) => i === 0 || t.tick !== tempos[i - 1].tick);
	if (!deduped.length) return [{ tick: 0, bpm: 120 }];
	if (deduped[0].tick > 0) deduped.unshift({ tick: 0, bpm: deduped[0].bpm });
	return deduped;
}

function extractXmlTimeSignature(xml: string): TimeSignature {
	const beat = findElements(xml, 'Time')[0];
	if (!beat) return { numerator: 4, denominator: 4 };
	const numerator = Math.max(
		1,
		Math.round(Number(beat.attrs.beats ?? beat.attrs.numerator ?? 4) || 4)
	);
	const denominator = Math.max(
		1,
		Math.round(Number(beat.attrs.beattype ?? beat.attrs.denominator ?? 4) || 4)
	);
	return { numerator, denominator };
}

/**
 * Parses CeVIO Creative Studio / CeVIO AI projects (.ccs / .ccst) and
 * VoiSona song projects (.tssln) in XML (or ZIP-wrapped XML) format.
 */
export async function parseCevioOrVoiSona(
	input: Uint8Array | string,
	kind: 'ccs' | 'tssln' = 'ccs'
): Promise<CevioImport> {
	let xml = '';
	if (typeof input === 'string') {
		xml = input;
	} else if (input[0] === 0x50 && input[1] === 0x4b) {
		// ZIP-wrapped project (used by some VoiSona .tssln archives).
		const zip = await JSZip.loadAsync(input);
		const candidates = Object.keys(zip.files).filter(
			(p) => !zip.files[p].dir && /\.(xml|tssln|ccs|json)$/i.test(p)
		);
		for (const path of candidates) {
			const text = await zip.files[path].async('string');
			if (
				/<(Scenario|TSSolution|TSSong|Song|Score|Note)\b/i.test(text) ||
				text.trim().startsWith('{')
			) {
				xml = text;
				break;
			}
		}
		if (!xml) throw new Error(`No readable song data was found inside the .${kind} archive.`);
	} else {
		xml = decodeText(input);
	}

	return parseCevioXml(xml, kind);
}

/** Synchronous parser when the project payload is already decoded XML text. */
export function parseCevioXml(xml: string, kind: 'ccs' | 'tssln' = 'ccs'): CevioImport {
	if (!/<(Scenario|Sequence|Scene|Unit|TSSolution|TSSong|Song|Score|Note)\b/i.test(xml)) {
		throw new Error(
			kind === 'tssln'
				? 'This is not a valid VoiSona (.tssln) project file.'
				: 'This is not a valid CeVIO (.ccs) XML project file.'
		);
	}

	const warnings: string[] = [];
	const resStr = childText(xml, 'Resolution') ?? childText(xml, 'TicksPerQuarterNote');
	const resolution = Number(resStr) > 0 ? Number(resStr) : CEVIO_PPQ;
	const scale = PPQ / resolution;

	const tempos = extractXmlTempos(xml, scale);
	const timeSignature = extractXmlTimeSignature(xml);
	const baseBpm = tempos[0]?.bpm ?? 120;

	// Build group metadata map from <Group Id="..." Name="..." Color="..." Volume="..." IsMuted="..." IsSolo="..."/>.
	const groups = new Map<string, Record<string, string>>();
	for (const g of findElements(xml, 'Group')) {
		if (g.attrs.id) groups.set(g.attrs.id, g.attrs);
	}

	const tracks: Track[] = [];
	const notes: Note[] = [];
	let voicebank = '';

	const units = findElements(xml, 'Unit').filter((u) => {
		const cat = (u.attrs.category ?? '').toLowerCase();
		return !cat || cat === 'singersong' || /<Note\b/i.test(u.body);
	});

	if (units.length) {
		const trackByGroup = new Map<string, Track>();
		units.forEach((u, idx) => {
			const groupId = u.attrs.group ?? `unit-${idx}`;
			const meta = groups.get(groupId);
			let track = trackByGroup.get(groupId);
			if (!track) {
				const rawCol = meta?.color ?? u.attrs.color ?? '';
				const color = /^#[0-9a-f]{6}$/i.test(rawCol)
					? rawCol
					: /^#[0-9a-f]{8}$/i.test(rawCol)
						? `#${rawCol.slice(3)}`
						: TRACK_COLORS[tracks.length % TRACK_COLORS.length];
				const db = Number(meta?.volume ?? 0);
				const volume = Number.isFinite(db)
					? Math.max(0, Math.min(150, Math.round(100 * Math.pow(10, db / 20))))
					: 100;
				const singerName = (u.attrs.castid ?? meta?.castid ?? '').trim();
				track = createTrack(tracks.length, {
					name: meta?.name || u.attrs.name || `Track ${tracks.length + 1}`,
					color,
					...(singerName ? { singer: singerName } : {}),
					mute: (meta?.ismuted ?? '').toLowerCase() === 'true',
					solo: (meta?.issolo ?? '').toLowerCase() === 'true',
					volume
				});
				trackByGroup.set(groupId, track);
				tracks.push(track);
			}
			if (!voicebank && (u.attrs.castid || meta?.castid)) {
				voicebank = u.attrs.castid ?? meta?.castid ?? '';
			}
			const tickOffset = parseClockOffset(u.attrs.starttime, baseBpm);
			notes.push(...extractXmlNotes(u.body, track.id, scale, tickOffset));
		});
	} else {
		const trackEls = findElements(xml, 'Track');
		if (trackEls.length) {
			trackEls.forEach((te, idx) => {
				const track = createTrack(idx, {
					name: te.attrs.name || childText(te.body, 'Name') || `Track ${idx + 1}`
				});
				tracks.push(track);
				notes.push(...extractXmlNotes(te.body, track.id, scale, 0));
			});
		} else {
			const track = createTrack(0, { name: kind === 'tssln' ? 'VoiSona Track' : 'CeVIO Track' });
			tracks.push(track);
			notes.push(...extractXmlNotes(xml, track.id, scale, 0));
		}
	}

	if (!tracks.length) tracks.push(createTrack(0));
	const tssongTag = /<TSSong\b([^>]*)>/i.exec(xml);
	const tssongName = tssongTag ? parseAttrs(tssongTag[1]).name : undefined;
	const title =
		childText(xml, 'Name') ??
		tssongName ??
		(kind === 'tssln' ? 'Imported VoiSona' : 'Imported CeVIO');

	return {
		name: title || (kind === 'tssln' ? 'Imported VoiSona' : 'Imported CeVIO'),
		voicebank,
		tempos,
		timeSignature,
		tracks,
		notes: sortNotes(notes),
		warnings
	};
}

function buildSongXml(
	trackNotes: readonly Note[],
	tempos: readonly TempoChange[],
	timeSignature: TimeSignature,
	scale: number
): string {
	const tempoLines = tempos
		.map((t) => `\t\t\t\t\t<Sound Clock="${Math.round(t.tick * scale)}" Tempo="${t.bpm}" />`)
		.join('\n');
	const noteLines = trackNotes
		.map((n) => {
			const clock = Math.round(n.tick * scale);
			const dur = Math.max(1, Math.round(n.length * scale));
			const pitch = Math.max(12, Math.min(119, Math.round(n.pitch)));
			const octave = Math.floor(pitch / 12) - 1;
			const step = ((pitch % 12) + 12) % 12;
			const lyric = escapeXml(n.lyric || 'a');
			return `\t\t\t\t\t<Note Clock="${clock}" Duration="${dur}" PitchStep="${step}" PitchOctave="${octave}" Lyric="${lyric}" />`;
		})
		.join('\n');

	return [
		`\t\t\t\t<Song Version="1.07">`,
		`\t\t\t\t\t<Tempo>`,
		tempoLines || `\t\t\t\t\t\t<Sound Clock="0" Tempo="120" />`,
		`\t\t\t\t\t</Tempo>`,
		`\t\t\t\t\t<Beat>`,
		`\t\t\t\t\t\t<Time Clock="0" Beats="${timeSignature.numerator}" BeatType="${timeSignature.denominator}" />`,
		`\t\t\t\t\t</Beat>`,
		`\t\t\t\t\t<Score>`,
		noteLines,
		`\t\t\t\t\t</Score>`,
		`\t\t\t\t</Song>`
	].join('\n');
}

/** Exports project to CeVIO Creative Studio / CeVIO AI XML (.ccs). */
export function serializeCcs(input: CevioExportInput): { text: string; warnings: string[] } {
	const warnings: string[] = [];
	const scale = CEVIO_PPQ / PPQ;
	let overlapped = false;

	const groupXml: string[] = [];
	const unitXml: string[] = [];

	input.tracks.forEach((track, idx) => {
		const own = input.notes.filter((n) => n.track === track.id);
		const trimmed = trimOverlaps(own);
		if (trimmed.some((n, i) => n.length !== own[i].length)) overlapped = true;
		const sorted = sortNotes(trimmed);

		const groupId = `00000000-0000-0000-0000-${String(idx + 1).padStart(12, '0')}`;
		const unitId = `10000000-0000-0000-0000-${String(idx + 1).padStart(12, '0')}`;
		const db = track.volume > 0 ? (20 * Math.log10(track.volume / 100)).toFixed(2) : '-24';

		groupXml.push(
			`\t\t\t\t<Group Version="1.0" Id="${groupId}" Category="SingerSong" Name="${escapeXml(track.name)}" Color="#FF${track.color.replace('#', '').toUpperCase()}" Volume="${db}" IsVisible="true" IsMuted="${track.mute}" IsSolo="${track.solo}" />`
		);
		unitXml.push(
			[
				`\t\t\t\t<Unit Version="1.0" Id="${unitId}" Category="SingerSong" Group="${groupId}" StartTime="00:00:00" Duration="01:00:00" CastId="${escapeXml(track.singer || input.voicebank)}">`,
				buildSongXml(sorted, input.tempos, input.timeSignature, scale),
				`\t\t\t\t</Unit>`
			].join('\n')
		);
	});

	if (overlapped) {
		warnings.push('Overlapping notes were shortened: CeVIO tracks hold one voice.');
	}

	const text = [
		`<?xml version="1.0" encoding="utf-8"?>`,
		`<Scenario Code="1">`,
		`\t<Sequence Id="openwebz-seq">`,
		`\t\t<Scene Id="openwebz-scene">`,
		`\t\t\t<Units>`,
		unitXml.join('\n'),
		`\t\t\t</Units>`,
		`\t\t\t<Groups>`,
		groupXml.join('\n'),
		`\t\t\t</Groups>`,
		`\t\t</Scene>`,
		`\t</Sequence>`,
		`</Scenario>`
	].join('\n');

	return { text, warnings };
}

/** Exports project to VoiSona Song XML (.tssln). */
export function serializeTssln(input: CevioExportInput): { text: string; warnings: string[] } {
	const warnings: string[] = [];
	const scale = CEVIO_PPQ / PPQ;
	let overlapped = false;

	const units = input.tracks
		.map((track, idx) => {
			const own = input.notes.filter((n) => n.track === track.id);
			const trimmed = trimOverlaps(own);
			if (trimmed.some((n, i) => n.length !== own[i].length)) overlapped = true;
			const sorted = sortNotes(trimmed);
			return [
				`\t\t<Track Id="track-${idx + 1}" Name="${escapeXml(track.name)}">`,
				`\t\t\t<Unit Category="SingerSong" Name="${escapeXml(track.name)}" CastId="${escapeXml(track.singer || input.voicebank)}">`,
				buildSongXml(sorted, input.tempos, input.timeSignature, scale),
				`\t\t\t</Unit>`,
				`\t\t</Track>`
			].join('\n');
		})
		.join('\n');

	if (overlapped) {
		warnings.push('Overlapping notes were shortened: VoiSona tracks hold one voice.');
	}

	const text = [
		`<?xml version="1.0" encoding="utf-8"?>`,
		`<TSSolution Version="1.0">`,
		`\t<TSSong Name="${escapeXml(input.name)}">`,
		`\t\t<Resolution>${CEVIO_PPQ}</Resolution>`,
		units,
		`\t</TSSong>`,
		`</TSSolution>`
	].join('\n');

	return { text, warnings };
}
