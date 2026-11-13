<script lang="ts">
	import Icon from './Icon.svelte';
	import { voicebank } from '#lib/state/voicebank.svelte';
	import { project } from '#lib/state/project.svelte';
	import { settings } from '#lib/state/settings.svelte';
	import { ui } from '#lib/state/ui.svelte';
	import { edit } from '#lib/state/commands';

	let zipInput = $state<HTMLInputElement>();
	let folderInput = $state<HTMLInputElement>();
	let query = $state('');
	let showUrlBox = $state(false);
	let urlInput = $state('');

	const vb = $derived(voicebank.current);
	const stats = $derived(voicebank.stats);
	const percent = $derived(stats.total ? Math.round((stats.ready / stats.total) * 100) : 0);

	const found = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const all = vb?.aliases ?? [];
		return (q ? all.filter((a) => a.toLowerCase().includes(q)) : all).slice(0, 150);
	});

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	function chosen(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		if (files.length) void voicebank.load(files);
	}

	async function submitUrl(e: Event) {
		e.preventDefault();
		const target = urlInput.trim();
		if (!target) return;
		await voicebank.loadFromUrl(target);
		if (!voicebank.loading) showUrlBox = false;
	}

	function useAlias(alias: string) {
		if (project.selection.size) project.updateSelected({ lyric: alias });
		else {
			settings.data.defaultLyric = alias;
			ui.toast(`New notes will use “${alias}”.`);
		}
	}
</script>

<div class="panel">
	<div class="actions">
		<button class="btn primary" disabled={voicebank.loading} onclick={() => zipInput?.click()}>
			<Icon name="upload" size={18} /> Open ZIP
		</button>
		<button class="btn" disabled={voicebank.loading} onclick={() => folderInput?.click()}>
			<Icon name="folder" size={18} /> Folder
		</button>
		<button
			class="btn"
			disabled={voicebank.loading}
			onclick={() => (showUrlBox = !showUrlBox)}
			title="Download a .zip voicebank from URL"
			aria-label="Download from URL"
		>
			<Icon name="download" size={18} /> URL
		</button>
		<input
			bind:this={zipInput}
			type="file"
			accept=".zip,application/zip"
			multiple
			hidden
			onchange={chosen}
		/>
		<input bind:this={folderInput} type="file" webkitdirectory hidden onchange={chosen} />
	</div>

	{#if showUrlBox}
		<form class="url-form" onsubmit={submitUrl}>
			<input
				type="url"
				placeholder="https://example.com/voicebank.zip"
				bind:value={urlInput}
				aria-label="Voicebank ZIP URL"
				required
			/>
			<button class="btn primary" type="submit" disabled={voicebank.loading || !urlInput.trim()}>
				Fetch
			</button>
		</form>
	{/if}

	<p class="hint">…or drop one or more voicebanks (.zip or folder) anywhere on the window.</p>

	{#if voicebank.loading}
		<div class="loading"><span class="spinner"></span> {ui.status}</div>
	{/if}

	{#if voicebank.library.length}
		<section>
			<div class="section-head">
				<h3>Remembered voicebanks ({voicebank.library.length})</h3>
			</div>
			<div class="library-list">
				{#each voicebank.library as item (item.id)}
					{@const active = vb?.id === item.id}
					<div class="lib-item" class:active>
						<button
							type="button"
							class="lib-select"
							disabled={voicebank.loading}
							aria-current={active ? 'true' : undefined}
							aria-label={active ? `${item.name} (active)` : `Switch to ${item.name}`}
							onclick={() => !active && voicebank.switchTo(item.id)}
							title={active ? `${item.name} is active` : `Switch to ${item.name}`}
						>
							<span class="lib-title">
								<strong>{item.name}</strong>
								{#if active}<span class="badge">Active</span>{/if}
							</span>
							<span class="muted">
								{item.aliasCount} aliases · {item.sampleCount} samples · {formatSize(
									item.totalBytes
								)}
							</span>
						</button>
						<div class="lib-actions">
							<button
								type="button"
								class="icon-btn sm"
								title="Download ZIP"
								aria-label="Download {item.name} ZIP"
								disabled={voicebank.loading}
								onclick={() => voicebank.exportSavedZip(item.id)}
							>
								<Icon name="download" size={15} />
							</button>
							<button
								type="button"
								class="icon-btn sm danger"
								title="Remove from library"
								aria-label="Remove {item.name}"
								disabled={voicebank.loading}
								onclick={() => voicebank.removeSaved(item.id)}
							>
								<Icon name="trash" size={15} />
							</button>
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	{#if vb}
		<div class="card">
			{#if vb.image}<img src={vb.image} alt="" class="portrait" />{/if}
			<div class="meta">
				<strong>{vb.name}</strong>
				{#if vb.character.get('author')}<span class="muted">by {vb.character.get('author')}</span
					>{/if}
				<span class="muted">{vb.aliases.length} aliases · {vb.samples.size} samples</span>
				{#if vb.generatedOto}
					<span class="warn"><Icon name="alert" size={14} /> oto.ini generated from file names</span
					>
				{/if}
			</div>
		</div>

		<section>
			<h3>Sample analysis</h3>
			<div
				class="meter"
				role="progressbar"
				aria-valuenow={percent}
				aria-valuemin="0"
				aria-valuemax="100"
			>
				<div class="fill" style:width="{percent}%"></div>
			</div>
			<div class="meter-text">
				<span>{stats.ready} / {stats.total} analyzed</span>
				{#if stats.fromCache}<span class="muted">· {stats.fromCache} from cache</span>{/if}
				{#if stats.failed}<span class="warn">· {stats.failed} failed</span>{/if}
			</div>
			<p class="hint">
				Samples are analyzed on demand when you press Play, and cached in your browser for next
				time.
			</p>
			{#if voicebank.warmingUp}
				<button class="btn" onclick={() => voicebank.stopAnalysis()}
					>Pause background analysis</button
				>
			{:else if stats.ready < stats.total}
				<button class="btn" onclick={() => voicebank.analyzeAll()}>Analyze everything now</button>
			{/if}
		</section>

		<section>
			<h3>Aliases</h3>
			<input
				type="text"
				placeholder="Search aliases…"
				bind:value={query}
				aria-label="Search aliases"
			/>
			<div class="chips">
				{#each found as alias (alias)}
					<button class="chip" onclick={() => useAlias(alias)} ondblclick={edit.appendNote}
						>{alias}</button
					>
				{/each}
			</div>
			<p class="hint">
				{project.selection.size
					? 'Click an alias to apply it to the selected notes.'
					: 'Click an alias to use it for new notes.'}
			</p>
		</section>
	{:else if !voicebank.loading}
		<div class="empty">
			<Icon name="mic" size={30} />
			<p>No voicebank loaded</p>
			<span class="hint">WebTAU works with UTAU voicebanks (oto.ini + WAV samples).</span>
			<div class="starter-row">
				<button
					class="btn"
					disabled={voicebank.loading}
					onclick={() => voicebank.installStarter('standard')}
				>
					Load Standard Starter
				</button>
				<button
					class="btn"
					disabled={voicebank.loading}
					onclick={() => voicebank.installStarter('soft')}
				>
					Load Soft Starter
				</button>
			</div>
		</div>
	{/if}

	{#if vb}
		<section>
			<h3>Built-in starter banks</h3>
			<div class="starter-row">
				<button
					class="btn"
					disabled={voicebank.loading}
					onclick={() => voicebank.installStarter('standard')}
				>
					+ Standard CV
				</button>
				<button
					class="btn"
					disabled={voicebank.loading}
					onclick={() => voicebank.installStarter('soft')}
				>
					+ Soft CV
				</button>
			</div>
		</section>
	{/if}
</div>

<style>
	.panel {
		padding: 14px;
		display: grid;
		gap: 12px;
		align-content: start;
	}
	.actions {
		display: flex;
		gap: 6px;
	}
	.actions .btn {
		flex: 1;
		padding: 0 8px;
		white-space: nowrap;
	}
	.url-form {
		display: flex;
		gap: 6px;
	}
	.url-form input {
		flex: 1;
		min-width: 0;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.library-list {
		display: grid;
		gap: 6px;
		max-height: 196px;
		overflow-y: auto;
	}
	.lib-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 8px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--panel-2);
		transition:
			border-color 0.15s,
			background 0.15s;
	}
	.lib-item.active {
		border-color: var(--accent);
		background:
			radial-gradient(160px circle at 0% 50%, rgba(255, 61, 143, 0.14), transparent 75%),
			var(--surface);
	}
	.lib-select {
		flex: 1;
		min-width: 0;
		text-align: left;
		display: grid;
		gap: 2px;
		background: none;
		border: 0;
		padding: 0;
		color: inherit;
		cursor: pointer;
	}
	.lib-select:disabled,
	.lib-item.active .lib-select {
		cursor: default;
	}
	.lib-item.active .lib-title strong {
		color: #ffffff;
	}
	.lib-title {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.lib-title strong {
		font-size: 13px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 1px 6px;
		border-radius: 6px;
		background: var(--accent);
		color: var(--accent-contrast);
		flex: none;
	}
	.lib-actions {
		display: flex;
		gap: 2px;
		flex: none;
	}
	.icon-btn.sm {
		width: 26px;
		height: 26px;
		min-height: 26px;
		padding: 0;
		display: grid;
		place-items: center;
		border-radius: 7px;
	}
	.icon-btn.sm.danger:hover {
		color: var(--danger, #ff5d73);
	}
	.starter-row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		width: 100%;
	}
	.starter-row .btn {
		flex: 1;
		font-size: 12px;
		padding: 0 8px;
	}
	.card {
		position: relative;
		display: flex;
		gap: 14px;
		padding: 14px;
		border: 1px solid var(--border);
		border-radius: 14px;
		background:
			radial-gradient(220px circle at 0% 0%, rgba(255, 61, 143, 0.12), transparent 70%),
			var(--surface);
		box-shadow:
			var(--inset),
			0 8px 24px rgba(0, 0, 0, 0.35);
	}
	.portrait {
		width: 68px;
		height: 68px;
		border-radius: 14px;
		object-fit: cover;
		flex: none;
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.12),
			0 8px 22px rgba(0, 0, 0, 0.5),
			0 0 26px rgba(255, 61, 143, 0.22);
	}
	.meta {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.meta strong {
		font-size: 16px;
		font-weight: 700;
		overflow-wrap: anywhere;
		background: linear-gradient(135deg, #fff 0%, #ffc2da 100%);
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
	}
	.muted {
		color: var(--muted);
		font-size: 12px;
	}
	.warn {
		color: var(--warn);
		font-size: 12px;
		display: inline-flex;
		gap: 4px;
		align-items: center;
	}
	h3 {
		margin: 0 0 8px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: var(--accent-2);
	}
	.meter {
		height: 8px;
		border-radius: 4px;
		background: var(--panel-2);
		border: 1px solid var(--border);
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: var(--accent-grad);
		box-shadow: 0 0 12px rgba(255, 61, 143, 0.6);
		transition: width 0.2s;
	}
	.meter-text {
		display: flex;
		gap: 6px;
		margin: 6px 0;
		font-size: 12px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 8px;
		max-height: 260px;
		overflow-y: auto;
	}
	.chip {
		padding: 3px 11px;
		border-radius: 999px;
		background: var(--surface-hi);
		border: 1px solid var(--border);
		font-size: 12px;
		min-height: 28px;
		transition:
			background 0.15s,
			border-color 0.15s,
			box-shadow 0.15s;
	}
	.chip:hover {
		background: var(--accent-grad);
		border-color: transparent;
		color: var(--accent-contrast);
		box-shadow: var(--glow);
	}
	.empty {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 26px 14px;
		text-align: center;
		color: var(--muted);
		border: 1px dashed var(--border-strong);
		border-radius: 14px;
		background: radial-gradient(240px circle at 50% 0%, rgba(255, 61, 143, 0.08), transparent 70%);
	}
	.empty p {
		margin: 4px 0 0;
		color: var(--text);
		font-weight: 600;
	}
	.loading {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
	}
	.spinner {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid var(--panel-3);
		border-top-color: var(--accent);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.hint {
		margin: 0;
	}
</style>
