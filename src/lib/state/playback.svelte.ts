import { isAudible, toEngineNotes } from '#lib/core/engine-notes';
import type { Note, Track } from '#lib/core/types';
import { encodeWav } from '#lib/io/wav';
import { downloadBlob, safeFilename } from '#lib/io/download';
import {
	mixOutcomes,
	startRender,
	type MixedOutcome,
	type NoteSpanInfo,
	type ProjectRender,
	type RenderGroup
} from '#lib/render/registry';
import type { Interval } from '#lib/render/intervals';
import type { RenderJob, RenderOutcome, RenderStream, RendererBackend } from '#lib/render/types';
import { resolveLyric } from '#lib/plugins/registry';
import { plugins } from './plugins.svelte';
import { renderers } from './renderers';
import { project } from './project.svelte';
import { settings } from './settings.svelte';
import { DEFAULT_CEILING, LIMITER_LOOKAHEAD, limit } from '#lib/render/limiter';
import { createStudioReverbImpulse, masterVocalPcm } from '#lib/render/mastering';
import { ui } from './ui.svelte';
import { lyrics } from './lyrics.svelte';
import { voicebank } from './voicebank.svelte';

export type RenderStatus = 'idle' | 'analyzing' | 'rendering' | 'ready' | 'error';

const SAMPLE_RATE = 44100;
/** How far ahead of the playhead audio is handed to the sound card. */
const AHEAD_S = 0.5;
/** Size of one scheduled piece of audio. */
const CHUNK_MS = 200;
/** Do not schedule slivers: wait until at least this much is ready. */
const MIN_CHUNK_MS = 20;
/**
 * After running dry (or at the start) playback waits until this much audio is ready ahead of the
 * playhead, so that a single finished note does not make it stutter forward one note at a time.
 */
const LEAD_MS = 2000;
/** A song longer than this is not rendered: its audio alone would take hundreds of megabytes. */
const MAX_SONG_MS = 30 * 60 * 1000;
/** An edit made under playback is re-rendered once the changes stop for this long (or after EDIT_MAX_WAIT_MS). */
const EDIT_SETTLE_MS = 150;
const EDIT_MAX_WAIT_MS = 800;

class PlaybackState {
	status = $state<RenderStatus>('idle');
	progress = $state(0);
	message = $state('');
	playing = $state(false);
	/** Playing, but the render has not caught up with the playhead yet. */
	buffering = $state(false);
	/** Gain the limiter applied to the piece last handed to the sound card (1 = untouched, below 1 = it was clipping). */
	limiterGain = $state(1);
	/** Playhead position in milliseconds. */
	positionMs = $state(0);
	durationMs = $state(0);
	/** The stretches of the song whose audio is final so far (while a render is going on). */
	readyRanges = $state.raw<Interval[]>([]);
	/** Notes whose lyric was not found in the voicebank (after the last render). */
	unknownLyrics = $state.raw<ReadonlySet<string>>(new Set());
	/** Where each note's sound lies on the time axis after the last render (for diagnostics and tests). */
	spans = $state.raw<NoteSpanInfo[]>([]);
	/** Increments whenever synthesized PCM buffers or ready ranges change. */
	waveformRevision = $state(0);

	/** Playhead in ticks (follows tempo changes). */
	positionTick = $derived(project.tempoMap.msToTick(this.positionMs));
	busy = $derived(this.status === 'analyzing' || this.status === 'rendering');

	private buffer: AudioBuffer | null = null;
	private renderedPcmData: Float32Array | null = null;
	private renderedKey = '';
	private run: ProjectRender | null = null;
	private ctx: AudioContext | null = null;
	private studioInput: AudioNode | null = null;
	private sources: AudioBufferSourceNode[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Next sample (of the song) to hand over, and the audio-clock time at which it will sound. */
	private nextSample = 0;
	private nextCtx = 0;
	private startedFrom = 0;
	private completed = false;
	/** Waiting for the render to get LEAD_MS ahead of the playhead before going on. */
	private holding = false;
	private exporting = false;
	/** The render the sound card is being fed from; differs from `run` while an edit is being re-rendered. */
	private feed: RenderStream | null = null;
	/** When the project last changed under playback (debounce), and when the first of those changes was. */
	private editSeen = { key: '', at: 0, first: 0 };

	/** The progressive render that is going on (or was the last one). */
	get stream(): RenderStream | null {
		return this.run?.stream ?? null;
	}

	private key(): string {
		const trackSingers = project.tracks.map((t) => `${t.id}=${t.singer ?? ''}`).join(',');
		return `${project.revision}:${voicebank.revision}:${settings.data.analysisQuality}:${trackSingers}`;
	}

	/** True when there is no finished or running render of what is on screen now. */
	get isStale(): boolean {
		return !this.run || this.renderedKey !== this.key();
	}

	/** 44.1 kHz mono PCM for the current render (live stream while rendering, final mix once done). */
	get renderPcm(): Float32Array | null {
		if (this.completed && !this.isStale && this.renderedPcmData) return this.renderedPcmData;
		if (this.run && this.renderedKey === this.key()) return this.run.stream.buffer;
		return null;
	}

	/** True when `[startMs, endMs]` already contains synthesized audio in `renderPcm`. */
	hasRenderedRange(startMs: number, endMs: number): boolean {
		if (this.completed && !this.isStale && this.renderedPcmData) return true;
		if (!this.run || this.renderedKey !== this.key()) return false;
		for (const r of this.readyRanges) {
			if (r.end > startMs && r.start < endMs) return true;
		}
		return false;
	}

	/** End of the music in ms (a short tail after the last note). */
	private endMs(): number {
		return project.tempoMap.tickToMs(project.songEnd) + 300;
	}

	// ---- rendering -----------------------------------------------------------

	private resolveTrackSingerKey(track: Track | undefined): string {
		const raw = track?.singer?.trim();
		if (raw) {
			const meta = voicebank.findMeta(raw);
			return meta ? meta.id : raw;
		}
		return voicebank.current?.id ?? '';
	}

	private startMultiSingerRender(
		partitions: { backend: RendererBackend; singerRef: string; notes: Note[] }[],
		tempo: number
	): ProjectRender {
		const totalNotes = partitions.reduce((sum, p) => sum + p.notes.length, 0);
		const progress = { done: 0, total: totalNotes };
		let pcm: Float32Array = new Float32Array(0);
		let complete = false;
		let waiting = 'Loading voicebanks…';
		let cancelled = false;
		let currentJob: RenderJob | null = null;

		const emptyReport: RenderOutcome['report'] = {
			total: 0,
			rendered: 0,
			cached: 0,
			skipped_rests: 0,
			missing_alias: [],
			missing_features: [],
			errors: []
		};

		let resolveResult!: (value: MixedOutcome | null) => void;
		let rejectResult!: (reason?: unknown) => void;
		const result = new Promise<MixedOutcome | null>((res, rej) => {
			resolveResult = res;
			rejectResult = rej;
		});

		const stream: RenderStream = {
			get buffer() {
				return pcm;
			},
			get durationMs() {
				return (pcm.length / SAMPLE_RATE) * 1000;
			},
			focus: () => {},
			readyUntil: (ms) => (complete ? Math.max(ms, (pcm.length / SAMPLE_RATE) * 1000) : ms),
			ready: (): Interval[] =>
				complete ? [{ start: 0, end: (pcm.length / SAMPLE_RATE) * 1000 }] : [],
			get complete() {
				return complete;
			},
			progress,
			get waiting() {
				return waiting;
			},
			onChange: null,
			promise: result.then((o) => (o ? { pcm: o.pcm, report: emptyReport } : null)),
			cancel: () => {
				cancelled = true;
				currentJob?.cancel();
			}
		};

		void (async () => {
			const groups: RenderGroup[] = [];
			const outcomes: RenderOutcome[] = [];
			try {
				let completedNotes = 0;
				for (const part of partitions) {
					if (cancelled) {
						resolveResult(null);
						return;
					}
					const vb =
						(part.singerRef ? await voicebank.resolveBank(part.singerRef) : null) ??
						voicebank.current;
					if (!vb) {
						throw new Error(
							part.singerRef
								? `Voicebank “${part.singerRef}” is not loaded.`
								: 'Load a voicebank first (left panel).'
						);
					}
					waiting = `Loading ${vb.name}…`;
					stream.onChange?.();
					await part.backend.load(vb);
					if (cancelled) {
						resolveResult(null);
						return;
					}

					const index = voicebank.indexFor(vb);
					const resMap = index ? plugins.resolver.resolveAll(part.notes, index) : null;
					const aliasOf = (n: Note) => {
						const r = resMap?.get(n.id);
						return r && r.status !== 'rest' && r.status !== 'missing' && r.alias
							? r.alias
							: n.lyric;
					};
					const converted = toEngineNotes(part.notes, project.tempoMap, project.tracks, aliasOf);
					groups.push({ backend: part.backend, ...converted });

					const partBase = completedNotes;
					waiting = `Rendering (${vb.name})…`;
					stream.onChange?.();

					const job = part.backend.render(converted.notes, tempo, {
						onAnalyze: (done, total) => {
							waiting = `Analyzing ${vb.name} ${done}/${total}`;
							stream.onChange?.();
						},
						onSynthesize: (done) => {
							progress.done = partBase + done;
							waiting = `Rendering ${vb.name} ${progress.done}/${totalNotes}`;
							stream.onChange?.();
						}
					});
					currentJob = job;
					const outcome = await job.promise;
					currentJob = null;
					if (cancelled || !outcome) {
						resolveResult(null);
						return;
					}
					outcomes.push(outcome);
					completedNotes += part.notes.length;
					progress.done = completedNotes;
					stream.onChange?.();
				}

				const currentVb = voicebank.current;
				if (currentVb) {
					const restoreBackend = renderers.all().find((r) => r.supports(currentVb));
					if (restoreBackend) await restoreBackend.load(currentVb).catch(() => {});
				}
				if (cancelled) {
					resolveResult(null);
					return;
				}
				const mixed = mixOutcomes(groups, outcomes);
				pcm = mixed.pcm;
				complete = true;
				stream.onChange?.();
				resolveResult(mixed);
			} catch (err) {
				rejectResult(err);
			}
		})();

		return {
			stream,
			result,
			cancel: () => stream.cancel()
		};
	}

	/**
	 * Makes sure there is a render of the current project (starting one if needed) and tells it
	 * to work around `focusMs` first. Returns null when there is nothing to render.
	 */
	private ensureRender(focusMs: number): ProjectRender | null {
		if (!project.notes.length) {
			ui.error('Add some notes first.');
			return null;
		}
		if (this.endMs() > MAX_SONG_MS) {
			const minutes = Math.round(this.endMs() / 60000);
			ui.error(
				`The song is ${minutes} minutes long; rendering is limited to ${MAX_SONG_MS / 60000}.`
			);
			return null;
		}

		const byTrack = new Map(project.tracks.map((t) => [t.id, t]));
		const audibleNotes = project.notes.filter((n) =>
			isAudible(byTrack.get(n.track), project.tracks)
		);
		const hasAnyBank =
			Boolean(voicebank.current) ||
			audibleNotes.some((n) => {
				const singer = byTrack.get(n.track)?.singer?.trim();
				return Boolean(singer && voicebank.findMeta(singer));
			});
		if (!hasAnyBank) {
			ui.error('Load a voicebank first (left panel).');
			return null;
		}

		if (this.run && this.renderedKey === this.key()) {
			this.run.stream.focus(focusMs);
			return this.run;
		}
		this.run?.cancel();

		const key = this.key();
		const partMap = new Map<
			string,
			{ backend: RendererBackend; singerRef: string; notes: Note[] }
		>();
		for (const n of audibleNotes) {
			const track = byTrack.get(n.track);
			const backend = renderers.forTrack(track);
			const singerRef = this.resolveTrackSingerKey(track);
			const pKey = `${backend.id}::${singerRef}`;
			let entry = partMap.get(pKey);
			if (!entry) {
				entry = { backend, singerRef, notes: [] };
				partMap.set(pKey, entry);
			}
			entry.notes.push(n);
		}
		const partitions = [...partMap.values()];
		const useSingleActiveStream =
			partitions.length <= 1 &&
			(!partitions.length ||
				!partitions[0].singerRef ||
				partitions[0].singerRef === voicebank.current?.id);

		this.status = 'analyzing';
		this.progress = 0;
		this.message = 'Preparing samples…';
		this.completed = false;
		this.buffer = null;
		this.renderedPcmData = null;
		this.readyRanges = [];
		this.waveformRevision++;

		let run: ProjectRender;
		if (useSingleActiveStream) {
			const groups: RenderGroup[] = renderers
				.plan(project.notes, project.tracks)
				.map(({ backend, notes }) => ({
					backend,
					...toEngineNotes(notes, project.tempoMap, project.tracks, lyrics.alias)
				}));
			run = startRender(groups, project.primaryTempo, {
				onAnalyze: (done, total) => {
					if (this.run !== run) return;
					this.status = 'analyzing';
					this.message = `Analyzing samples ${done}/${total}`;
				}
			});
		} else {
			run = this.startMultiSingerRender(partitions, project.primaryTempo);
		}

		this.run = run;
		this.renderedKey = key;
		run.stream.focus(focusMs);
		run.stream.onChange = () => this.syncStream(run);

		void run.result.then(
			(outcome) => {
				if (this.run !== run) return;
				if (!outcome) {
					this.run = null;
					this.renderedPcmData = null;
					this.status = 'idle';
					this.readyRanges = [];
					this.waveformRevision++;
					return;
				}
				const buffer = new AudioBuffer({ length: outcome.pcm.length, sampleRate: SAMPLE_RATE });
				buffer.copyToChannel(outcome.pcm as Float32Array<ArrayBuffer>, 0);
				this.buffer = buffer;
				this.renderedPcmData = outcome.pcm;
				this.completed = true;
				this.durationMs = buffer.duration * 1000;
				this.unknownLyrics = new Set(outcome.missingAlias);
				this.spans = outcome.spans;
				this.readyRanges = [];
				this.status = 'ready';
				this.progress = 1;
				this.waveformRevision++;
				this.message = `Rendered ${outcome.rendered}, reused ${outcome.cached}`;
				ui.setStatus(this.message);
				if (outcome.missingAlias.length) {
					ui.toast(
						`${outcome.missingAlias.length} note(s) have lyrics that are not in the voicebank (marked in red).`,
						'error'
					);
				}
				if (outcome.errors.length) console.warn('[render]', outcome.errors);
			},
			(error) => {
				if (this.run !== run) return;
				this.run = null;
				this.renderedPcmData = null;
				this.status = 'error';
				this.buffering = false;
				this.waveformRevision++;
				this.message = error instanceof Error ? error.message : 'Synthesis failed.';
				ui.error(this.message);
			}
		);
		return run;
	}

	/** Copies what the running render knows into reactive state. */
	private syncStream(run: ProjectRender) {
		if (this.run !== run || this.completed) return;
		const { stream } = run;
		const { done, total } = stream.progress;
		this.durationMs = stream.durationMs;
		this.readyRanges = stream.ready();
		this.waveformRevision++;
		this.progress = total ? done / total : 0;
		this.status =
			stream.waiting?.startsWith('Analy') || stream.waiting?.startsWith('Load')
				? 'analyzing'
				: 'rendering';
		this.message = this.buffering
			? `Buffering… ${done}/${total} notes`
			: (stream.waiting ?? `Rendering ${done}/${total}`);
	}

	/** Synthesizes the whole project. Resolves true when all of its audio is available. */
	async render(): Promise<boolean> {
		const run = this.ensureRender(0);
		if (!run) return false;
		const outcome = await run.result.catch(() => null);
		return !!outcome && this.run === run;
	}

	cancelRender() {
		this.run?.cancel();
		this.run = null;
		this.readyRanges = [];
		this.buffering = false;
		this.waveformRevision++;
		if (this.busy) this.status = 'idle';
	}

	// ---- transport -----------------------------------------------------------------

	async toggle() {
		if (this.playing) this.pause();
		else await this.play();
	}

	/** Starts playing at once: whatever is not rendered yet is rendered ahead of the playhead. */
	async play() {
		const from = this.startPosition();
		if (!this.ensureRender(from)) return;
		this.start(from);
	}

	private startPosition(): number {
		if (settings.data.playbackStart === 'start') return 0;
		return this.positionMs >= this.endMs() - 30 ? 0 : this.positionMs;
	}

	private audioContext(): AudioContext {
		if (!this.ctx) {
			try {
				// The song is rendered at 44.1 kHz; the same rate avoids resampling at piece borders.
				this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE });
			} catch {
				this.ctx = new AudioContext({ latencyHint: 'interactive' });
			}
			this.studioInput = this.buildStudioBus(this.ctx);
		}
		return this.ctx;
	}

	private buildStudioBus(ctx: AudioContext): AudioNode {
		const input = ctx.createGain();
		const hp = ctx.createBiquadFilter();
		hp.type = 'highpass';
		hp.frequency.value = 65;

		const mudTrim = ctx.createBiquadFilter();
		mudTrim.type = 'peaking';
		mudTrim.frequency.value = 320;
		mudTrim.Q.value = 0.9;
		mudTrim.gain.value = -1.0;

		const presence = ctx.createBiquadFilter();
		presence.type = 'peaking';
		presence.frequency.value = 3200;
		presence.Q.value = 0.85;
		presence.gain.value = 1.6;

		const air = ctx.createBiquadFilter();
		air.type = 'highshelf';
		air.frequency.value = 10500;
		air.gain.value = 1.2;

		const comp = ctx.createDynamicsCompressor();
		comp.threshold.value = -10;
		comp.knee.value = 12;
		comp.ratio.value = 2.5;
		comp.attack.value = 0.004;
		comp.release.value = 0.14;

		const dryGain = ctx.createGain();
		dryGain.gain.value = 0.94;

		const wetGain = ctx.createGain();
		wetGain.gain.value = 0.095;

		const convolver = ctx.createConvolver();
		const sr = ctx.sampleRate || SAMPLE_RATE;
		const ir = createStudioReverbImpulse(sr, 0.34);
		const irBuf = ctx.createBuffer(2, ir.left.length, sr);
		irBuf.copyToChannel(ir.left as Float32Array<ArrayBuffer>, 0);
		irBuf.copyToChannel(ir.right as Float32Array<ArrayBuffer>, 1);
		convolver.buffer = irBuf;

		input.connect(hp);
		hp.connect(mudTrim);
		mudTrim.connect(presence);
		presence.connect(air);
		air.connect(dryGain);
		dryGain.connect(comp);
		air.connect(convolver);
		convolver.connect(wetGain);
		wetGain.connect(comp);
		comp.connect(ctx.destination);
		return input;
	}

	private outputNode(ctx: AudioContext): AudioNode {
		if (settings.data.vocalPolish === 'studio') {
			return this.studioInput ?? ctx.destination;
		}
		return ctx.destination;
	}

	private start(fromMs: number) {
		const ctx = this.audioContext();
		void ctx.resume();
		this.halt();
		this.playing = true;
		this.buffering = false;
		this.holding = true;
		this.feed = this.run?.stream ?? null;
		this.startedFrom = fromMs;
		this.positionMs = fromMs;
		this.nextSample = Math.floor((fromMs / 1000) * SAMPLE_RATE);
		this.nextCtx = ctx.currentTime + 0.06;
		this.run?.stream.focus(fromMs);
		this.timer = setInterval(() => this.pump(), 30);
		this.pump();
	}

	/** What of `stream` can be handed to the sound card from `fromSample` on. */
	private availability(stream: RenderStream, fromSample: number, endSample: number) {
		// Limiting a sample needs a little final audio after it too.
		const readyMs = stream.readyUntil((fromSample / SAMPLE_RATE) * 1000);
		const whole = stream.complete || (stream.durationMs > 0 && readyMs >= stream.durationMs - 1);
		const lastSample = Math.min(endSample, Math.floor((stream.durationMs / 1000) * SAMPLE_RATE));
		const playable = Math.min(
			endSample,
			Math.floor((readyMs / 1000) * SAMPLE_RATE) - (whole ? 0 : LIMITER_LOOKAHEAD)
		);
		const lead = Math.min(Math.floor((LEAD_MS / 1000) * SAMPLE_RATE), endSample - fromSample);
		return {
			playable,
			hasLead: playable - fromSample >= lead || (whole && playable >= lastSample)
		};
	}

	/**
	 * The project changed while playing (solo, volume, notes…): render it again from the playhead
	 * and, once the new render has a lead, carry on from it. The old audio plays until then.
	 */
	private followEdits() {
		const key = this.key();
		if (!this.run || key === this.renderedKey) {
			this.editSeen.first = 0;
			return;
		}
		const t = performance.now();
		if (key !== this.editSeen.key) this.editSeen = { key, at: t, first: this.editSeen.first || t };
		// Wait for a burst of changes (a slider being dragged) to settle, but not for ever.
		if (t - this.editSeen.at < EDIT_SETTLE_MS && t - this.editSeen.first < EDIT_MAX_WAIT_MS) return;
		this.editSeen.first = 0;
		this.ensureRender(this.positionMs);
	}

	/** Hands the next ready pieces of the song to the sound card and moves the playhead. */
	private pump() {
		const ctx = this.ctx;
		if (!ctx || !this.run || !this.playing) return;
		this.followEdits();
		const run = this.run;
		if (!run) return;
		const now = ctx.currentTime;
		const endSample = Math.floor((this.endMs() / 1000) * SAMPLE_RATE);

		if (this.nextCtx < now) {
			// Everything handed over has been played: the playhead waits where the audio ends.
			this.positionMs = Math.max(this.positionMs, (this.nextSample / SAMPLE_RATE) * 1000);
			this.nextCtx = now + 0.03;
		}
		run.stream.focus((this.nextSample / SAMPLE_RATE) * 1000);

		// A newer render takes over as soon as it has a lead at the point where the sound card is fed next.
		if (
			this.feed !== run.stream &&
			(!this.feed || this.availability(run.stream, this.nextSample, endSample).hasLead)
		) {
			this.feed = run.stream;
		}
		const stream = this.feed ?? run.stream;
		const { playable, hasLead } = this.availability(stream, this.nextSample, endSample);

		let starving = false;
		if (this.holding && this.nextSample < endSample) {
			if (hasLead) this.holding = false;
			else starving = true;
		}
		while (!starving && this.nextCtx - now < AHEAD_S && this.nextSample < endSample) {
			const toSample = Math.min(
				playable,
				this.nextSample + Math.floor((CHUNK_MS / 1000) * SAMPLE_RATE)
			);
			if (toSample - this.nextSample < (MIN_CHUNK_MS / 1000) * SAMPLE_RATE) {
				starving = true;
				break;
			}
			this.schedule(ctx, stream.buffer, this.nextSample, toSample);
		}

		const queued = Math.max(0, this.nextCtx - now);
		const playedMs = (this.nextSample / SAMPLE_RATE) * 1000 - queued * 1000;
		this.positionMs = Math.max(this.positionMs, this.startedFrom, playedMs);

		// Out of audio to play: from now on wait for a proper lead. If a newer render exists, it is the one to wait for.
		if (starving && queued < 0.04 && this.nextSample < endSample) {
			this.holding = true;
			this.feed = run.stream;
		}
		const wasBuffering = this.buffering;
		this.buffering = this.holding && queued < 0.04 && this.nextSample < endSample;
		if (this.buffering !== wasBuffering && this.run) this.syncStream(this.run);

		if (this.nextSample >= endSample && queued <= 0.01) {
			this.halt();
			this.playing = false;
			this.buffering = false;
			this.positionMs = 0;
		}
	}

	private schedule(ctx: AudioContext, pcm: Float32Array, from: number, to: number) {
		const limited = limit(pcm, from, to, DEFAULT_CEILING);
		this.limiterGain = limited.minGain;
		const piece = ctx.createBuffer(1, to - from, SAMPLE_RATE);
		piece.copyToChannel(limited.pcm as Float32Array<ArrayBuffer>, 0);
		const source = ctx.createBufferSource();
		source.buffer = piece;
		source.connect(this.outputNode(ctx));
		source.onended = () => {
			this.sources = this.sources.filter((s) => s !== source);
		};
		source.start(this.nextCtx);
		this.sources.push(source);
		this.nextCtx += (to - from) / SAMPLE_RATE;
		this.nextSample = to;
	}

	/** Stops the audio without touching the playhead. */
	private halt() {
		clearInterval(this.timer);
		this.timer = undefined;
		for (const source of this.sources) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				/* already stopped */
			}
			source.disconnect();
		}
		this.sources = [];
	}

	pause() {
		if (this.playing && this.ctx) {
			const queued = Math.max(0, this.nextCtx - this.ctx.currentTime);
			const playedMs = (this.nextSample / SAMPLE_RATE) * 1000 - queued * 1000;
			this.positionMs = Math.max(this.startedFrom, playedMs, this.positionMs);
		}
		this.halt();
		this.playing = false;
		this.buffering = false;
		this.settingsChanged();
	}

	/** Without background rendering an unfinished render stops when nothing is playing (the cache keeps its work). */
	settingsChanged() {
		if (this.playing || this.exporting || this.completed || settings.data.backgroundRender) return;
		if (!this.run) return;
		this.cancelRender();
		this.message = '';
	}

	stop() {
		this.pause();
		this.cancelRender();
		this.positionMs = 0;
	}

	/** Moves the playhead. The render follows: whatever is around the new position is done first. */
	seekMs(ms: number) {
		const target = Math.max(0, ms);
		this.run?.stream.focus(target);
		if (this.playing) this.start(target);
		else this.positionMs = target;
	}

	seekTick(tick: number) {
		this.seekMs(project.tempoMap.tickToMs(Math.max(0, tick)));
	}

	// ---- note preview (piano keys) -------------------------------------------

	private previewCache = new Map<string, AudioBuffer>();
	private previewing = new Set<string>();
	private previewSource: AudioBufferSourceNode | null = null;
	private stopBeep: (() => void) | null = null;

	/**
	 * Plays a short note when a piano key is pressed: with the track's voicebank
	 * if the lyric exists there, otherwise as a plain tone.
	 */
	async preview(pitch: number) {
		void this.audioContext().resume();
		const activeTrack = project.tracks.find((t) => t.id === project.activeTrack);
		const trackVb =
			(activeTrack?.singer?.trim() ? await voicebank.resolveBank(activeTrack.singer) : null) ??
			voicebank.current;
		const lyric = (project.selectedNotes[0]?.lyric || settings.data.defaultLyric || 'a').trim();
		const singerKey = trackVb?.id ?? voicebank.revision;
		const key = `${singerKey}|${lyric}|${pitch}`;
		this.stopPreview();

		const cached = this.previewCache.get(key);
		if (cached) return this.playPreview(cached);
		if (!trackVb || this.previewing.has(key)) return this.beep(pitch);

		this.previewing.add(key);
		const pressedAt = performance.now();
		this.beep(pitch); // instant feedback while the voice is rendered
		try {
			const index = voicebank.indexFor(trackVb);
			const resolved = index
				? resolveLyric(lyric, { index, pitch, prev: null }, plugins.registry)
				: null;
			const alias =
				resolved && resolved.status !== 'missing' && resolved.status !== 'rest'
					? resolved.alias
					: lyric;
			const note = {
				alias,
				pitch,
				start_time: 0,
				duration: 500,
				pitchbend: [],
				flags: '',
				velocity: 100,
				volume: 100,
				modulation: 0
			};
			const backend = renderers.forTrack(activeTrack);
			await backend.load(trackVb);
			const out = await backend.render([note], project.primaryTempo).promise;
			if (!out || out.report.missing_alias.length || out.report.missing_features.length) return;
			const samples = out.pcm.subarray(0, Math.floor(SAMPLE_RATE * 0.75));
			const buffer = new AudioBuffer({ length: samples.length, sampleRate: SAMPLE_RATE });
			buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
			if (this.previewCache.size > 80)
				this.previewCache.delete(this.previewCache.keys().next().value!);
			this.previewCache.set(key, buffer);
			// If the voice is ready quickly it replaces the beep; later it is just cached.
			if (performance.now() - pressedAt < 1200) {
				this.stopPreview();
				this.playPreview(buffer);
			}
		} catch {
			/* the beep already played */
		} finally {
			this.previewing.delete(key);
		}
	}

	private playPreview(buffer: AudioBuffer) {
		if (!this.ctx) return;
		const source = this.ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(this.outputNode(this.ctx));
		source.onended = () => {
			if (this.previewSource === source) this.previewSource = null;
		};
		source.start();
		this.previewSource = source;
	}

	private beep(pitch: number) {
		const ctx = this.ctx;
		if (!ctx) return;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = 'triangle';
		osc.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
		const t = ctx.currentTime;
		gain.gain.setValueAtTime(0, t);
		gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
		osc.connect(gain).connect(ctx.destination);
		osc.start(t);
		osc.stop(t + 0.5);
		this.previewSource = {
			stop: () => osc.stop(),
			onended: null
		} as unknown as AudioBufferSourceNode;
		osc.onended = () => {
			if (this.previewSource && 'stop' in this.previewSource) this.previewSource = null;
		};
	}

	private stopPreview() {
		try {
			this.previewSource?.stop();
			this.stopBeep?.();
		} catch {
			/* already stopped */
		}
		this.previewSource = null;
		this.stopBeep = null;
	}

	// ---- export ---------------------------------------------------------------------

	async exportWav() {
		this.exporting = true;
		try {
			if ((this.isStale || !this.completed) && !(await this.render())) return;
		} finally {
			this.exporting = false;
		}
		const source = this.buffer!.getChannelData(0);
		const polished =
			settings.data.vocalPolish === 'studio' ? masterVocalPcm(source, SAMPLE_RATE) : source;
		// Playback is limited on the fly; the file gets the same limiter, and quiet mixes are brought up first.
		let peak = 0;
		for (const v of polished) peak = Math.max(peak, Math.abs(v));
		const boost = peak > 0.001 && peak < 0.8 ? 0.95 / peak : 1;
		const mix = boost === 1 ? polished : polished.map((v) => v * boost);
		const pcm = limit(mix, 0, mix.length, DEFAULT_CEILING).pcm;
		downloadBlob(encodeWav(pcm, SAMPLE_RATE), `${safeFilename(project.name)}.wav`, 'audio/wav');
		ui.toast('WAV exported.', 'success');
	}
}

export const playback = new PlaybackState();
