// @ts-check

/** @typedef {import("./types.d.ts").RuntimeLimits} RuntimeLimits */
/** @typedef {import("./types.d.ts").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./types.d.ts").WasmRuntime} WasmRuntime */
/** @typedef {import("./types.d.ts").InspectionResult} InspectionResult */
/** @typedef {import("./types.d.ts").TextResult} TextResult */
/** @typedef {import("./types.d.ts").TextureResult} TextureResult */

/**
 * @typedef WasmBinding
 * @property {(path: string, bytes: Uint8Array) => string} inspect
 * @property {(path: string, bytes: Uint8Array) => string} extract_text
 * @property {(path: string, bytes: Uint8Array) => string} extract_textures
 * @property {() => string} version
 */

export const DEFAULT_LIMITS = Object.freeze({
	maxInputBytes: 64 * 1024 * 1024,
	maxOutputBytes: 64 * 1024 * 1024,
	maxExports: 100_000,
	maxProjectionItems: 1_000_000
});

const textEncoder = new TextEncoder();

export class WasmInputLimitError extends Error {
	/** @param {number} actualBytes @param {number} maxBytes */
	constructor(actualBytes, maxBytes) {
		super(`WASM input is ${actualBytes} bytes; the configured limit is ${maxBytes} bytes.`);
		this.name = "WasmInputLimitError";
		this.code = "UE_SHED_UASSET_WASM_INPUT_LIMIT";
		this.actualBytes = actualBytes;
		this.maxBytes = maxBytes;
	}
}

export class WasmOutputLimitError extends Error {
	/** @param {number} actualBytes @param {number} maxBytes */
	constructor(actualBytes, maxBytes) {
		super(`WASM output is ${actualBytes} bytes; the configured limit is ${maxBytes} bytes.`);
		this.name = "WasmOutputLimitError";
		this.code = "UE_SHED_UASSET_WASM_OUTPUT_LIMIT";
		this.actualBytes = actualBytes;
		this.maxBytes = maxBytes;
	}
}

export class WasmProtocolError extends Error {
	/** @param {string} operation @param {string} message @param {unknown} [cause] */
	constructor(operation, message, cause) {
		super(`WASM ${operation} returned an invalid result: ${message}`, { cause });
		this.name = "WasmProtocolError";
		this.code = "UE_SHED_UASSET_WASM_PROTOCOL";
		this.operation = operation;
	}
}

export class WasmInitializationError extends Error {
	/** @param {string} message @param {unknown} [cause] */
	constructor(message, cause) {
		super(message, { cause });
		this.name = "WasmInitializationError";
		this.code = "UE_SHED_UASSET_WASM_INITIALIZATION";
	}
}

/**
 * @param {RuntimeOptions | undefined} options
 * @returns {RuntimeLimits}
 */
export function normalizeLimits(options = undefined) {
	return Object.freeze({
		...DEFAULT_LIMITS,
		maxInputBytes: normalizeLimit(
			options?.maxInputBytes,
			DEFAULT_LIMITS.maxInputBytes,
			"maxInputBytes"
		),
		maxOutputBytes: normalizeLimit(
			options?.maxOutputBytes,
			DEFAULT_LIMITS.maxOutputBytes,
			"maxOutputBytes"
		)
	});
}

/**
 * @param {number | undefined} value
 * @param {number} maximum
 * @param {string} name
 */
function normalizeLimit(value, maximum, name) {
	if (value === undefined) return maximum;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
	}
	return value;
}

/**
 * @param {unknown} bytes
 * @param {number} maxInputBytes
 * @returns {Uint8Array}
 */
function assertInputBytes(bytes, maxInputBytes) {
	const isUint8Array =
		bytes instanceof Uint8Array ||
		Object.prototype.toString.call(bytes) === "[object Uint8Array]";
	if (!isUint8Array) {
		throw new TypeError("WASM package operations require a Uint8Array of package bytes.");
	}
	const input = /** @type {Uint8Array} */ (bytes);
	if (input.byteLength > maxInputBytes) {
		throw new WasmInputLimitError(input.byteLength, maxInputBytes);
	}
	return input;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
	return typeof value === "object" && value !== null;
}

/**
 * @param {string} operation
 * @param {unknown} raw
 * @param {number} schemaVersion
 * @param {number} maxOutputBytes
 */
function decodeResult(operation, raw, schemaVersion, maxOutputBytes) {
	if (typeof raw !== "string") {
		throw new WasmProtocolError(operation, "the binding did not return a JSON string");
	}
	const actualBytes = textEncoder.encode(raw).byteLength;
	if (actualBytes > maxOutputBytes) {
		throw new WasmOutputLimitError(actualBytes, maxOutputBytes);
	}
	let value;
	try {
		value = JSON.parse(raw);
	} catch (cause) {
		throw new WasmProtocolError(operation, "the result was not valid JSON", cause);
	}
	if (
		!isObject(value) ||
		value.schema_version !== schemaVersion ||
		typeof value.status !== "string"
	) {
		throw new WasmProtocolError(
			operation,
			`expected schema ${schemaVersion} with a status, received ${JSON.stringify(value)}`
		);
	}
	return value;
}

/**
 * @param {WasmBinding} binding
 * @param {RuntimeOptions | undefined} options
 * @returns {WasmRuntime}
 */
export function createRuntime(binding, options = undefined) {
	const limits = normalizeLimits(options);
	if (
		typeof binding.inspect !== "function" ||
		typeof binding.extract_text !== "function" ||
		typeof binding.extract_textures !== "function" ||
		typeof binding.version !== "function"
	) {
		throw new WasmProtocolError("initialization", "the generated binding is missing an export");
	}
	return Object.freeze({
		limits,
		inspect(/** @type {string} */ path, /** @type {Uint8Array} */ bytes) {
			const input = assertInputBytes(bytes, limits.maxInputBytes);
			return /** @type {InspectionResult} */ (
				/** @type {unknown} */ (
					decodeResult("inspect", binding.inspect(path, input), 8, limits.maxOutputBytes)
				)
			);
		},
		extractText(/** @type {string} */ path, /** @type {Uint8Array} */ bytes) {
			const input = assertInputBytes(bytes, limits.maxInputBytes);
			return /** @type {TextResult} */ (
				/** @type {unknown} */ (
					decodeResult(
						"extractText",
						binding.extract_text(path, input),
						1,
						limits.maxOutputBytes
					)
				)
			);
		},
		extractTextures(/** @type {string} */ path, /** @type {Uint8Array} */ bytes) {
			const input = assertInputBytes(bytes, limits.maxInputBytes);
			return /** @type {TextureResult} */ (
				/** @type {unknown} */ (
					decodeResult(
						"extractTextures",
						binding.extract_textures(path, input),
						1,
						limits.maxOutputBytes
					)
				)
			);
		},
		version() {
			const value = binding.version();
			if (typeof value !== "string" || value.length === 0) {
				throw new WasmProtocolError("version", "the binding returned an empty version");
			}
			return value;
		}
	});
}
