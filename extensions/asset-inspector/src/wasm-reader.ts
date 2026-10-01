import { Effect, Schema } from "effect";
import {
	AssetInspection,
	type AssetInspectionFailureReason,
	type AssetInspectionReadResult
} from "./contract.js";

export interface WasmInspectionRuntime {
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Foreign evidence is validated below.
	readonly inspect: (path: string, bytes: Uint8Array) => unknown;
}

const FailureKind = Schema.Literals([
	"malformed_data",
	"resource_limit",
	"unsupported_format",
	"unsupported_version",
	"unsupported_capability",
	"internal"
]);
const Output = Schema.Union([
	AssetInspection,
	Schema.Struct({
		schema_version: Schema.Literal(8),
		status: Schema.Literal("error"),
		path: Schema.String,
		kind: FailureKind,
		message: Schema.NonEmptyString,
		field: Schema.optionalKey(Schema.NullOr(Schema.String)),
		offset: Schema.optionalKey(Schema.NullOr(Schema.Number))
	})
]);
const FileIdentity = Schema.Struct({
	fileName: Schema.NonEmptyString.check(Schema.isMaxLength(32_768)),
	fileBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});

function failureReason(kind: Schema.Schema.Type<typeof FailureKind>): AssetInspectionFailureReason {
	switch (kind) {
		case "malformed_data":
			return "malformed_package";
		case "unsupported_format":
			return "unsupported_asset";
		case "unsupported_version":
			return "unsupported_version";
		case "unsupported_capability":
			return "unsupported_capability";
		case "resource_limit":
		case "internal":
			return "reader_failure";
	}
}

function recovery(reason: AssetInspectionFailureReason): string {
	switch (reason) {
		case "malformed_package":
			return "Restore or resave the package, then try again.";
		case "unsupported_asset":
			return "Choose an uncooked .uasset with saved editor data.";
		case "unsupported_version":
			return "Choose a package saved by a supported Unreal revision.";
		case "unsupported_capability":
			return "Inspect this asset in Unreal; this saved format is not supported yet.";
		case "reader_failure":
			return "Try a smaller .uasset (up to 64 MiB), or reload and retry.";
	}
}

export const adaptWasmInspectionResult = Effect.fn("AssetInspector.adaptWasmResult")(function* (
	fileName: string,
	fileBytes: number,
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Runtime decoding boundary.
	output: unknown
): Effect.fn.Return<AssetInspectionReadResult> {
	const identity = yield* Schema.decodeUnknownEffect(FileIdentity)({ fileName, fileBytes }).pipe(
		Effect.catch(() => Effect.succeed(undefined))
	);
	if (identity === undefined) {
		return {
			status: "failed",
			fileName,
			reason: "reader_failure",
			message: "The file name or size is invalid.",
			recovery: "Rename the file and choose it again."
		};
	}
	return yield* Schema.decodeUnknownEffect(Output)(output).pipe(
		Effect.map((value): AssetInspectionReadResult => {
			if (value.status !== "error") {
				return { status: "ready", fileName, fileBytes, inspection: value };
			}
			const reason = failureReason(value.kind);
			return {
				status: "failed",
				fileName,
				reason,
				message: value.message,
				recovery: recovery(reason)
			};
		}),
		Effect.catch(() =>
			Effect.succeed<AssetInspectionReadResult>({
				status: "failed",
				fileName,
				reason: "reader_failure",
				message: "The browser reader returned invalid package evidence.",
				recovery: "Reload the page and try again. This file was not modified."
			})
		)
	);
});

export const readWasmInspection = Effect.fn("AssetInspector.readWasm")(function* (
	runtime: WasmInspectionRuntime,
	fileName: string,
	bytes: Uint8Array
) {
	const output = yield* Effect.try({
		try: () => runtime.inspect(fileName, bytes),
		catch: (cause) => cause
	}).pipe(
		Effect.catch(() =>
			Effect.succeed({
				schema_version: 8,
				status: "error",
				path: fileName,
				kind: "internal",
				message: "The browser reader could not decode this saved package."
			})
		)
	);
	return yield* adaptWasmInspectionResult(fileName, bytes.byteLength, output);
});
