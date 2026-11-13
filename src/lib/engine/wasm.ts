const wasmFiles = import.meta.glob('./wasm/w-synth.wasm', {
	query: '?url',
	import: 'default'
});

let compiled: Promise<WebAssembly.Module> | null = null;

/** Downloads and compiles the optional WASM engine once; rejects cleanly when absent. */
export function compileWasm(): Promise<WebAssembly.Module> {
	const loader = wasmFiles['./wasm/w-synth.wasm'];
	if (!loader) {
		return Promise.reject(
			new Error('WebAssembly engine binary is not bundled; using TypeScript engine.')
		);
	}
	compiled ??= (async () => {
		const wasmUrl = (await loader()) as string;
		try {
			return await WebAssembly.compileStreaming(fetch(wasmUrl));
		} catch {
			// Servers that do not send application/wasm.
			const response = await fetch(wasmUrl);
			return WebAssembly.compile(await response.arrayBuffer());
		}
	})();
	compiled.catch(() => (compiled = null));
	return compiled;
}
