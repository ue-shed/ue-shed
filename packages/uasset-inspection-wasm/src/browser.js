// @ts-check

import { createRuntime, WasmInitializationError } from "./runtime.js";

/** @typedef {import("./types.d.ts").BrowserRuntimeOptions} BrowserRuntimeOptions */

let bindingPromise;

/**
 * @param {BrowserRuntimeOptions | undefined} options
 */
async function loadBinding(options = undefined) {
	if (bindingPromise === undefined) {
		bindingPromise = import(
			new URL("./wasm/browser/uasset_inspection_wasm.js", import.meta.url).href
		)
			.then(async (module) => {
				const wasmUrl = new URL(
					"./wasm/browser/uasset_inspection_wasm_bg.wasm",
					import.meta.url
				);
				await module.default(options?.module ?? wasmUrl);
				return module;
			})
			.catch((cause) => {
				bindingPromise = undefined;
				throw new WasmInitializationError(
					"Could not initialize the UAsset WebAssembly module.",
					cause
				);
			});
	}
	return bindingPromise;
}

/**
 * Initialize the browser binding and return a synchronous runtime over the initialized module.
 * The first initialization owns the module instance; per-runtime limits may still be narrowed.
 *
 * @param {BrowserRuntimeOptions} [options]
 */
export async function createBrowserRuntime(options = undefined) {
	return createRuntime(await loadBinding(options), options);
}

/** @param {BrowserRuntimeOptions} [options] */
export const initBrowser = createBrowserRuntime;

export async function inspect(path, bytes) {
	return (await createBrowserRuntime()).inspect(path, bytes);
}

export async function extractText(path, bytes) {
	return (await createBrowserRuntime()).extractText(path, bytes);
}

export async function extractTextures(path, bytes) {
	return (await createBrowserRuntime()).extractTextures(path, bytes);
}

export async function extractLevelSequences(path, bytes) {
	return (await createBrowserRuntime()).extractLevelSequences(path, bytes);
}

export async function extractBlueprints(path, bytes) {
	return (await createBrowserRuntime()).extractBlueprints(path, bytes);
}

export async function version() {
	return (await createBrowserRuntime()).version();
}

export {
	DEFAULT_LIMITS,
	WasmInitializationError,
	WasmInputLimitError,
	WasmOutputLimitError,
	WasmProtocolError
} from "./runtime.js";

export { DEFAULT_LIMITS as limits } from "./runtime.js";
