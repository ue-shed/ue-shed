import { Predicate, Result, Schema } from "effect";
import { defaultLocalizationLimits, LocalizationError, LocalizationLimits } from "./schema.js";

export function localizationError(code: LocalizationError["code"]): LocalizationError {
	const regenerate =
		"Check the target configuration and regenerate its evidence through Unreal if needed.";
	const recovery = {
		invalid_encoding: regenerate,
		malformed_json: regenerate,
		invalid_schema: regenerate,
		malformed_struct: regenerate,
		malformed_ini: regenerate,
		malformed_locmeta: regenerate,
		malformed_csv: regenerate,
		target_not_found: regenerate,
		limit_exceeded: "Reduce the input or explicitly increase the localization reader limits.",
		unsupported_version: "Use a supported Unreal localization format or update the reader.",
		file_missing:
			"Restore the expected file or generate it through Unreal's localization pipeline.",
		file_unreadable:
			"Check file permissions and ensure the selected evidence is a regular file.",
		directory_unreadable:
			"Choose an existing readable project root and check directory permissions.",
		unsafe_path:
			"Configure evidence paths inside the selected project root without external symlinks.",
		ambiguous_config:
			"Reconcile conflicting target recipes before reading the target's evidence.",
		file_changed: "Retry after localization processes finish writing the saved evidence.",
		file_unwritable:
			"Check the file out in source control or make it writable, then write the changes again.",
		malformed_po: "Repair the PO syntax with the translation tool, then read the file again."
	} satisfies Record<LocalizationError["code"], LocalizationError["recovery"]>;
	return new LocalizationError({
		code,
		message: `Localization evidence could not be read (${code}).`,
		recovery: recovery[code]
	});
}

/** Only safe error codes escape this boundary; decoder errors may contain authored evidence. */
export function parseResult<A>(parse: () => A): Result.Result<A, LocalizationError> {
	try {
		return Result.succeed(parse());
	} catch (cause) {
		return Result.fail(
			cause instanceof LocalizationError ? cause : localizationError("invalid_schema")
		);
	}
}

export function validate<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	input: S["Encoded"] | Schema.Json | undefined,
	code: LocalizationError["code"] = "invalid_schema",
	strict = false
): S["Type"] {
	const result = Schema.decodeUnknownResult(schema)(
		input,
		strict ? { onExcessProperty: "error" } : undefined
	);
	if (Result.isFailure(result)) throw localizationError(code);
	return result.success;
}

export function limitsFor(limits?: LocalizationLimits): LocalizationLimits {
	return limits === undefined ? defaultLocalizationLimits : validate(LocalizationLimits, limits);
}

export function checkSize(bytes: Uint8Array, limits: LocalizationLimits): void {
	if (bytes.byteLength > limits.maxFileBytes) throw localizationError("limit_exceeded");
}

export function decodeText(bytes: Uint8Array, limits = defaultLocalizationLimits): string {
	checkSize(bytes, limits);
	const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
	const utf8BOM = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	try {
		return new TextDecoder(utf16 ? "utf-16le" : "utf-8", {
			fatal: true,
			ignoreBOM: true
		}).decode(bytes.subarray(utf16 ? 2 : utf8BOM ? 3 : 0));
	} catch {
		throw localizationError("invalid_encoding");
	}
}

const JsonFromString = Schema.fromJsonString(Schema.Json);
const FormatVersion = Schema.Struct({ FormatVersion: Schema.Int });

/** Bound nesting before recursive schema validation, ignoring brackets inside JSON strings. */
function checkJsonNesting(text: string, limits: LocalizationLimits): void {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === "{" || character === "[") {
			if (++depth > limits.maxDepth + 1) {
				// Preserve malformed-JSON precedence without traversing an unbounded value.
				const syntax = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(text);
				if (Result.isFailure(syntax)) throw localizationError("malformed_json");
				throw localizationError("limit_exceeded");
			}
		} else if (character === "}" || character === "]") depth--;
	}
}

/** Decode the complete wire contract before domain transformations consume it. */
export function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(
	bytes: Uint8Array,
	limits: LocalizationLimits,
	schema: S,
	version: number
): S["Type"] {
	const text = decodeText(bytes, limits);
	checkJsonNesting(text, limits);
	const value = validate(JsonFromString, text, "malformed_json");
	checkDepth(value, limits);
	if (validate(FormatVersion, value).FormatVersion !== version)
		throw localizationError("unsupported_version");
	return validate(schema, value);
}

export function checkDepth(value: Schema.Json, limits: LocalizationLimits): void {
	const pending = [{ value, depth: 0 }];
	while (pending.length > 0) {
		const item = pending.pop();
		if (item === undefined) break;
		if (item.depth > limits.maxDepth) throw localizationError("limit_exceeded");
		if (Predicate.isObjectKeyword(item.value)) {
			for (const child of Object.values(item.value)) {
				pending.push({ value: child, depth: item.depth + 1 });
			}
		}
	}
}

/** Freeze ordinary decoded values, including opaque metadata, without exposing mutable lists. */
export function immutable<A>(value: A): A {
	if (Predicate.isObjectKeyword(value) && !Object.isFrozen(value)) {
		if (Array.isArray(value)) {
			for (const child of value) immutable(child);
		} else {
			for (const child of Object.values(value)) immutable(child);
		}
		Object.freeze(value);
	}
	return value;
}
