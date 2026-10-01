import { LevelSequenceProjection, type BlueprintGraphDiagnostic } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import {
	SequenceAssetPath,
	type SequenceFailureReason,
	type SequenceReadResult
} from "./contract.js";

/** The host supplies its initialized runtime; this extension never imports the WASM package. */
export interface WasmSequenceRuntime {
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Foreign runtime output is decoded below.
	readonly extractLevelSequences: (path: string, bytes: Uint8Array) => unknown;
}

const ProjectionFailureKind = Schema.Literals([
	"malformed_data",
	"resource_limit",
	"unsupported_format",
	"unsupported_version",
	"unsupported_capability"
]);

const WasmSequenceOutput = Schema.Union([
	Schema.Struct({
		schema_version: Schema.Literal(1),
		status: Schema.Literals(["complete", "partial"]),
		path: Schema.String,
		sequences: Schema.Array(LevelSequenceProjection).check(Schema.isMaxLength(1)),
		diagnostics: Schema.Array(
			Schema.Struct({
				object_path: Schema.String,
				class_path: Schema.optionalKey(Schema.String),
				code: Schema.NonEmptyString,
				message: Schema.NonEmptyString
			})
		)
	}),
	Schema.Struct({
		schema_version: Schema.Literal(1),
		status: Schema.Literal("error"),
		path: Schema.String,
		kind: Schema.Union([ProjectionFailureKind, Schema.Literal("internal")]),
		message: Schema.NonEmptyString
	})
]);

function diagnosticCode(code: string): string {
	switch (code) {
		case "malformed_data":
		case "resource_limit":
		case "unsupported_format":
		case "unsupported_version":
		case "unsupported_capability":
			return `asset_${code}`;
		default:
			return code;
	}
}

function failureReason(
	kind: Schema.Schema.Type<typeof ProjectionFailureKind> | "internal"
): SequenceFailureReason {
	switch (kind) {
		case "unsupported_capability":
			return "unsupported_asset";
		case "unsupported_version":
			return "unsupported_version";
		case "malformed_data":
			return "malformed_package";
		case "unsupported_format":
			return "unsupported_asset";
		case "resource_limit":
		case "internal":
			return "reader_failure";
	}
}

function failureRecovery(reason: SequenceFailureReason): string {
	switch (reason) {
		case "unsupported_version":
			return "Choose an uncooked package in the UE 5.7-loadable saved-revision window.";
		case "malformed_package":
			return "Restore or resave the package, then retry. The reader did not modify the file.";
		case "unsupported_asset":
			return "Choose an uncooked Level Sequence .uasset containing saved timeline data.";
		case "missing_reader":
		case "reader_failure":
			return "Try a smaller Sequence .uasset (up to 64 MiB), or reload the page and retry.";
	}
}

function failed(
	assetPath: string,
	reason: SequenceFailureReason,
	message: string
): SequenceReadResult {
	return { assetPath, message, reason, recovery: failureRecovery(reason), status: "failed" };
}

/** Validate the foreign envelope and reuse the authoritative protocol projection schema. */
export const adaptWasmSequenceResult = Effect.fn("Sequencer.adaptWasmResult")(function* (
	assetPath: string,
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the runtime decoding boundary.
	output: unknown
): Effect.fn.Return<SequenceReadResult> {
	const path = yield* Schema.decodeUnknownEffect(SequenceAssetPath)(assetPath).pipe(
		Effect.catch(() => Effect.succeed(undefined))
	);
	if (path === undefined) {
		return {
			message: "The file name is not a valid Sequence asset path.",
			reason: "reader_failure",
			recovery: "Rename the file and choose it again.",
			status: "failed"
		};
	}
	return yield* Schema.decodeUnknownEffect(WasmSequenceOutput)(output).pipe(
		Effect.map((read): SequenceReadResult => {
			if (read.status === "error") {
				return failed(path, failureReason(read.kind), read.message);
			}
			const sequence = read.sequences[0];
			if (sequence === undefined) {
				return failed(
					path,
					"unsupported_asset",
					`package ${path} contains no saved Level Sequence`
				);
			}
			return {
				assetPath: path,
				sequence,
				// Native scan_failure_code prefixes these codes; emit_diagnostic uses warning.
				diagnostics: read.diagnostics.map(
					(diagnostic): BlueprintGraphDiagnostic => ({
						code: diagnosticCode(diagnostic.code),
						message: diagnostic.message,
						severity: "warning"
					})
				),
				outcome: read.status === "complete" ? "complete" : "partial",
				status: "ready"
			};
		}),
		Effect.catch(() =>
			Effect.succeed(
				failed(
					path,
					"reader_failure",
					"The browser reader returned invalid Sequence evidence."
				)
			)
		)
	);
});

export const readWasmSequence = Effect.fn("Sequencer.readWasm")(function* (
	runtime: WasmSequenceRuntime,
	assetPath: string,
	bytes: Uint8Array
) {
	const output = yield* Effect.try({
		try: () => runtime.extractLevelSequences(assetPath, bytes),
		catch: (cause) => cause
	}).pipe(
		Effect.catch(() =>
			Effect.succeed({
				schema_version: 1,
				status: "error",
				path: assetPath,
				kind: "internal",
				message: "The browser reader could not decode this package."
			})
		)
	);
	return yield* adaptWasmSequenceResult(assetPath, output);
});

export { sequenceStats } from "./sequence-summary.js";
