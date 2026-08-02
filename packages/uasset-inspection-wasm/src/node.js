// @ts-check

import { createRequire } from "node:module";
import { createRuntime } from "./runtime.js";

const require = createRequire(import.meta.url);
const binding = require("./wasm/node/uasset_inspection_wasm.js");
const runtime = createRuntime(binding);

/** @param {import("./types.d.ts").RuntimeOptions} [options] */
export function createNodeRuntime(options = undefined) {
	return createRuntime(binding, options);
}

export const limits = runtime.limits;
export const inspect = runtime.inspect;
export const extractText = runtime.extractText;
export const extractTextures = runtime.extractTextures;
export const version = runtime.version;

export {
	DEFAULT_LIMITS,
	WasmInitializationError,
	WasmInputLimitError,
	WasmOutputLimitError,
	WasmProtocolError
} from "./runtime.js";
