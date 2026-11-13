import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import devtoolsJson from 'vite-plugin-devtools-json';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// The deployed app lives under /<repo>/ on GitHub Pages; the CI sets BASE_PATH.
const base = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

const SAFE_SET_FETCH_HELPER = `function __safeSetWindowFetch(fn) {
	try {
		window.fetch = fn;
	} catch {
		try {
			Object.defineProperty(window, 'fetch', {
				value: fn,
				writable: true,
				configurable: true,
				enumerable: true
			});
		} catch {
			// Host iframe/sandbox prevents reassigning window.fetch; keep native_fetch.
		}
	}
}
`;

/** Find the end index (exclusive of `;`) of an arrow/block expression starting at `start`. */
function findAssignmentEnd(code: string, start: number): number {
	let depth = 0;
	let quote: "'" | '"' | '`' | null = null;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = start; i < code.length; i++) {
		const ch = code[i];
		const next = code[i + 1];

		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '/' && next === '/') {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			continue;
		}
		if (ch === '{') {
			depth++;
			continue;
		}
		if (ch === '}') {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

function safeWindowFetchPlugin(): Plugin {
	const targetSuffix = '/@sveltejs/kit/src/runtime/client/fetcher.js';

	return {
		name: 'safe-window-fetch',
		enforce: 'pre',
		transform(code, id) {
			const normalized = id.replace(/\\/g, '/').split('?')[0];
			if (!normalized.endsWith(targetSuffix)) return null;

			const pattern = /\bwindow\.fetch\s*=\s*/g;
			let out = '';
			let cursor = 0;
			let changed = false;

			for (const match of code.matchAll(pattern)) {
				const start = match.index ?? -1;
				if (start < cursor) continue;
				const exprStart = start + match[0].length;
				const end = findAssignmentEnd(code, exprStart);
				if (end === -1) continue;

				out += code.slice(cursor, start);
				out += `__safeSetWindowFetch(${code.slice(exprStart, end)})`;
				cursor = end;
				changed = true;
			}

			if (!changed) return null;
			out += code.slice(cursor);
			return { code: `${SAFE_SET_FETCH_HELPER}${out}`, map: null };
		}
	};
}

export default defineConfig({
	plugins: [
		safeWindowFetchPlugin(),
		tailwindcss(),
		sveltekit({
			adapter: adapter({ fallback: 'index.html' }),
			paths: { base },
			// Registered manually in +layout.svelte so proxy redirects never surface errors.
			serviceWorker: { register: false }
		}),
		devtoolsJson()
	],
	worker: { format: 'es' },
	server: { host: '0.0.0.0', port: 3000, allowedHosts: true },
	test: { include: ['src/**/*.test.ts'], environment: 'node' }
});
