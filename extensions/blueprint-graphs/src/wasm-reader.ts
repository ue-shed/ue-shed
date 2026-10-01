import { BlueprintGraphProjection, type BlueprintGraphDiagnostic } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import {
	BlueprintAssetPath,
	type BlueprintGraphFailureReason,
	type BlueprintGraphReadResult
} from "./contract.js";

/** The host supplies its initialized runtime; this extension never imports the WASM package. */
export interface WasmBlueprintRuntime {
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Foreign runtime output is decoded below.
	readonly extractBlueprints: (path: string, bytes: Uint8Array) => unknown;
}

const ProjectionFailureKind = Schema.Literals([
	"malformed_data",
	"resource_limit",
	"unsupported_format",
	"unsupported_version",
	"unsupported_capability"
]);

const WasmBlueprintOutput = Schema.Union([
	Schema.Struct({
		schema_version: Schema.Literal(1),
		status: Schema.Literals(["ok", "partial"]),
		path: Schema.String,
		blueprints: Schema.Array(BlueprintGraphProjection).check(Schema.isMaxLength(1)),
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
): BlueprintGraphFailureReason {
	switch (kind) {
		case "unsupported_capability":
			return "control_rig";
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

function failureRecovery(reason: BlueprintGraphFailureReason): string {
	switch (reason) {
		case "control_rig":
			return "Inspect this asset in Unreal's Control Rig editor; saved RigVM graphs are not supported.";
		case "unsupported_version":
			return "Choose an uncooked package in the UE 5.7-loadable saved-revision window.";
		case "malformed_package":
			return "Restore or resave the package, then retry. The reader did not modify the file.";
		case "unsupported_asset":
			return "Choose an uncooked Blueprint .uasset containing saved editor graph data.";
		case "missing_reader":
		case "reader_failure":
			return "Try a smaller Blueprint .uasset (up to 64 MiB), or reload the page and retry.";
	}
}

function failed(
	assetPath: string,
	reason: BlueprintGraphFailureReason,
	message: string
): BlueprintGraphReadResult {
	return { assetPath, message, reason, recovery: failureRecovery(reason), status: "failed" };
}

/** Validate the foreign envelope and reuse the authoritative protocol projection schema. */
export const adaptWasmBlueprintResult = Effect.fn("BlueprintGraphs.adaptWasmResult")(function* (
	assetPath: string,
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the runtime decoding boundary.
	output: unknown
): Effect.fn.Return<BlueprintGraphReadResult> {
	const path = yield* Schema.decodeUnknownEffect(BlueprintAssetPath)(assetPath).pipe(
		Effect.catch(() => Effect.succeed(undefined))
	);
	if (path === undefined) {
		return {
			message: "The file name is not a valid Blueprint asset path.",
			reason: "reader_failure",
			recovery: "Rename the file and choose it again.",
			status: "failed"
		};
	}
	return yield* Schema.decodeUnknownEffect(WasmBlueprintOutput)(output).pipe(
		Effect.map((read): BlueprintGraphReadResult => {
			if (read.status === "error") {
				return failed(path, failureReason(read.kind), read.message);
			}
			const blueprint = read.blueprints[0];
			if (blueprint === undefined) {
				return failed(
					path,
					"unsupported_asset",
					`package ${path} contains no saved Blueprint editor graph`
				);
			}
			return {
				assetPath: path,
				blueprint,
				// Native scan_failure_code prefixes these codes; emit_diagnostic uses warning.
				diagnostics: read.diagnostics.map(
					(diagnostic): BlueprintGraphDiagnostic => ({
						code: diagnosticCode(diagnostic.code),
						message: diagnostic.message,
						severity: "warning"
					})
				),
				outcome: read.status === "ok" ? "complete" : "partial",
				status: "ready"
			};
		}),
		Effect.catch(() =>
			Effect.succeed(
				failed(
					path,
					"reader_failure",
					"The browser reader returned invalid Blueprint evidence."
				)
			)
		)
	);
});

export const readWasmBlueprint = Effect.fn("BlueprintGraphs.readWasm")(function* (
	runtime: WasmBlueprintRuntime,
	assetPath: string,
	bytes: Uint8Array
) {
	const output = yield* Effect.try({
		try: () => runtime.extractBlueprints(assetPath, bytes),
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
	return yield* adaptWasmBlueprintResult(assetPath, output);
});
