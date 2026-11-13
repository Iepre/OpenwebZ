import JSZip from 'jszip';
import { encodeText } from '#lib/io/text';
import { encodeWav } from '#lib/io/wav';
import { buildAnyVoicebank, loadFromFileList, type StatusFn } from './loader';
import type { Voicebank } from './types';

export type StarterPresetId = 'standard' | 'soft';

interface VowelSpec {
	formants: [number, number, number];
	bw: [number, number, number];
}

const VOWELS: Record<string, VowelSpec> = {
	a: { formants: [730, 1090, 2440], bw: [70, 90, 140] },
	i: { formants: [280, 2250, 2900], bw: [55, 110, 150] },
	u: { formants: [320, 900, 2250], bw: [60, 85, 130] },
	e: { formants: [500, 1800, 2500], bw: [65, 100, 140] },
	o: { formants: [500, 820, 2350], bw: [65, 85, 135] },
	n: { formants: [300, 1150, 2200], bw: [70, 110, 160] }
};

const SYLLABLES: {
	alias: string;
	vowel: keyof typeof VOWELS;
	consonantNoise: number;
	pitch: number;
}[] = [
	{ alias: 'a', vowel: 'a', consonantNoise: 0.0, pitch: 220 },
	{ alias: 'i', vowel: 'i', consonantNoise: 0.0, pitch: 220 },
	{ alias: 'u', vowel: 'u', consonantNoise: 0.0, pitch: 220 },
	{ alias: 'e', vowel: 'e', consonantNoise: 0.0, pitch: 220 },
	{ alias: 'o', vowel: 'o', consonantNoise: 0.0, pitch: 220 },
	{ alias: 'n', vowel: 'n', consonantNoise: 0.02, pitch: 220 },
	{ alias: 'ka', vowel: 'a', consonantNoise: 0.25, pitch: 220 },
	{ alias: 'ki', vowel: 'i', consonantNoise: 0.25, pitch: 220 },
	{ alias: 'ku', vowel: 'u', consonantNoise: 0.25, pitch: 220 },
	{ alias: 'ke', vowel: 'e', consonantNoise: 0.25, pitch: 220 },
	{ alias: 'ko', vowel: 'o', consonantNoise: 0.25, pitch: 220 },
	{ alias: 'sa', vowel: 'a', consonantNoise: 0.35, pitch: 220 },
	{ alias: 'si', vowel: 'i', consonantNoise: 0.35, pitch: 220 },
	{ alias: 'shi', vowel: 'i', consonantNoise: 0.35, pitch: 220 },
	{ alias: 'su', vowel: 'u', consonantNoise: 0.35, pitch: 220 },
	{ alias: 'se', vowel: 'e', consonantNoise: 0.35, pitch: 220 },
	{ alias: 'so', vowel: 'o', consonantNoise: 0.35, pitch: 220 },
	{ alias: 'ta', vowel: 'a', consonantNoise: 0.22, pitch: 220 },
	{ alias: 'ti', vowel: 'i', consonantNoise: 0.22, pitch: 220 },
	{ alias: 'tu', vowel: 'u', consonantNoise: 0.22, pitch: 220 },
	{ alias: 'te', vowel: 'e', consonantNoise: 0.22, pitch: 220 },
	{ alias: 'to', vowel: 'o', consonantNoise: 0.22, pitch: 220 },
	{ alias: 'na', vowel: 'a', consonantNoise: 0.06, pitch: 220 },
	{ alias: 'ni', vowel: 'i', consonantNoise: 0.06, pitch: 220 },
	{ alias: 'nu', vowel: 'u', consonantNoise: 0.06, pitch: 220 },
	{ alias: 'ne', vowel: 'e', consonantNoise: 0.06, pitch: 220 },
	{ alias: 'no', vowel: 'o', consonantNoise: 0.06, pitch: 220 },
	{ alias: 'ra', vowel: 'a', consonantNoise: 0.1, pitch: 220 },
	{ alias: 'ri', vowel: 'i', consonantNoise: 0.1, pitch: 220 },
	{ alias: 'ru', vowel: 'u', consonantNoise: 0.1, pitch: 220 },
	{ alias: 're', vowel: 'e', consonantNoise: 0.1, pitch: 220 },
	{ alias: 'ro', vowel: 'o', consonantNoise: 0.1, pitch: 220 },
	{ alias: 'la', vowel: 'a', consonantNoise: 0.08, pitch: 220 },
	{ alias: 'ma', vowel: 'a', consonantNoise: 0.05, pitch: 220 },
	{ alias: 'mi', vowel: 'i', consonantNoise: 0.05, pitch: 220 }
];

function synthesizeFormantWav(
	vowelKey: keyof typeof VOWELS,
	consonantNoise: number,
	baseHz: number,
	soft: boolean
): Uint8Array<ArrayBuffer> {
	const sr = 44100;
	const durSec = 0.55;
	const len = Math.floor(sr * durSec);
	const pcm = new Float32Array(len);
	const spec = VOWELS[vowelKey];
	const shift = soft ? 0.94 : 1.03;
	const f1 = spec.formants[0] * shift;
	const f2 = spec.formants[1] * shift;
	const f3 = spec.formants[2] * shift;

	const maxH = soft ? 12 : 18;
	let seed = 0x9e3779b9;

	for (let i = 0; i < len; i++) {
		const t = i / sr;
		const envIn = Math.min(1, t / 0.025);
		const envOut = Math.min(1, (durSec - t) / 0.05);
		const attackFade = t < 0.06 ? t / 0.06 : 1;

		let harmonic = 0;
		for (let h = 1; h <= maxH; h++) {
			const freq = baseHz * h;
			if (freq >= sr * 0.45) break;
			const rolloff = soft ? 1 / Math.pow(h, 1.35) : 1 / Math.pow(h, 1.05);
			const g1 = Math.exp(-Math.pow((freq - f1) / (spec.bw[0] * 1.8), 2));
			const g2 = 0.7 * Math.exp(-Math.pow((freq - f2) / (spec.bw[1] * 2.0), 2));
			const g3 = 0.35 * Math.exp(-Math.pow((freq - f3) / (spec.bw[2] * 2.2), 2));
			const amp = rolloff * (0.15 + g1 + g2 + g3);
			harmonic += amp * Math.sin(2 * Math.PI * freq * t);
		}

		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		const noise = seed / 0xffffffff - 0.5;
		const cEnv = t < 0.07 ? Math.sin((Math.PI * t) / 0.07) : 0;
		const breath = soft ? 0.04 : 0.012;

		pcm[i] =
			0.22 * envIn * envOut * (harmonic * attackFade + noise * (consonantNoise * cEnv + breath));
	}
	return encodeWav(pcm, sr);
}

/** Builds a ready-to-sing built-in starter UTAU voicebank for immediate multi-bank testing. */
export async function buildStarterVoicebank(
	preset: StarterPresetId,
	status: StatusFn
): Promise<Voicebank> {
	const soft = preset === 'soft';
	const name = soft ? 'WebTAU Soft (Starter)' : 'WebTAU Standard (Starter)';
	const author = 'WebTAU Built-in';
	const baseHz = soft ? 261.63 : 220.0;

	status(`Building ${name}…`);

	const charText = `name=${name}\nauthor=${author}\nversion=1.0\n`;
	const otoLines = SYLLABLES.map(
		(s) => `${s.alias}.wav=${s.alias},10,90,-100,${s.consonantNoise > 0 ? 45 : 20},15`
	).join('\n');

	const entries = [
		{
			path: `${name}/character.txt`,
			size: charText.length,
			read: async () => encodeText(charText) as Uint8Array<ArrayBuffer>,
			blob: async () => new Blob([charText], { type: 'text/plain' })
		},
		{
			path: `${name}/oto.ini`,
			size: otoLines.length,
			read: async () => encodeText(otoLines) as Uint8Array<ArrayBuffer>,
			blob: async () => new Blob([otoLines], { type: 'text/plain' })
		},
		...SYLLABLES.map((s) => {
			let cached: Uint8Array<ArrayBuffer> | null = null;
			const read = async () => {
				cached ??= synthesizeFormantWav(s.vowel, s.consonantNoise, baseHz, soft);
				return cached.slice();
			};
			return {
				path: `${name}/${s.alias}.wav`,
				size: 44 + Math.floor(44100 * 0.55) * 2,
				read,
				blob: async () => new Blob([await read()], { type: 'audio/wav' })
			};
		})
	];

	return buildAnyVoicebank(entries, name, `starter:${preset}:v1`, status);
}

/** Downloads a .zip voicebank from a direct URL (CORS-enabled) and parses it. */
export async function loadVoicebankFromUrl(url: string, status: StatusFn): Promise<Voicebank> {
	const trimmed = url.trim();
	if (!trimmed) throw new Error('Enter a voicebank .zip URL first.');

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error('The URL is not valid.');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('Only http:// and https:// URLs are supported.');
	}

	status(`Downloading ${parsed.pathname.split('/').pop() || 'voicebank.zip'}…`);
	let response: Response;
	try {
		response = await fetch(parsed.toString());
	} catch {
		throw new Error(
			'Download failed (network error or server does not allow browser CORS requests).'
		);
	}
	if (!response.ok) {
		throw new Error(`Download failed with HTTP ${response.status}.`);
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength < 30 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
		// Verify it is at least a ZIP or valid archive.
		throw new Error('The downloaded file is not a valid .zip voicebank archive.');
	}

	const rawName = decodeURIComponent(parsed.pathname.split('/').pop() || 'voicebank.zip');
	const fileName = rawName.toLowerCase().endsWith('.zip') ? rawName : `${rawName}.zip`;
	const zipFile = new File([bytes], fileName, { type: 'application/zip' });
	// Double-check ZIP readability cleanly.
	await JSZip.loadAsync(bytes);
	return loadFromFileList([zipFile], status);
}
