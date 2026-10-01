import { AuthoringTableSnapshot, BlueprintGraphDiagnostic } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";

export const AuthoringAssetPath = Schema.Trim.check(
	Schema.isNonEmpty(),
	Schema.isMaxLength(32_768)
);
export const AuthoringFailureReason = Schema.Literals([
	"malformed_package",
	"reader_failure",
	"unsupported_asset",
	"unsupported_version"
]);
export const AuthoringReadFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	assetPath: Schema.optionalKey(AuthoringAssetPath),
	reason: AuthoringFailureReason,
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString
});
export type AuthoringReadFailure = Schema.Schema.Type<typeof AuthoringReadFailure>;
export const AuthoringReadResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		assetPath: AuthoringAssetPath,
		snapshot: AuthoringTableSnapshot,
		outcome: Schema.Literals(["complete", "partial"]),
		diagnostics: Schema.Array(BlueprintGraphDiagnostic)
	}),
	AuthoringReadFailure
]);
export type AuthoringReadResult = Schema.Schema.Type<typeof AuthoringReadResult>;

/** The initialized runtime is supplied by the host, with no WASM package dependency. */
export interface WasmAuthoringRuntime {
	// oxlint-disable-next-line anti-slop/no-unknown-returns -- Foreign output is decoded below.
	readonly extractAuthoringTable: (path: string, bytes: Uint8Array) => unknown;
}

const FailureKind = Schema.Literals([
	"malformed_data",
	"resource_limit",
	"unsupported_format",
	"unsupported_version",
	"unsupported_capability",
	"internal"
]);
const WasmAuthoringOutput = Schema.Union([
	Schema.Struct({
		schema_version: Schema.Literal(1),
		status: Schema.Literals(["ok", "partial"]),
		path: AuthoringAssetPath,
		snapshot: AuthoringTableSnapshot
	}),
	Schema.Struct({
		schema_version: Schema.Literal(1),
		status: Schema.Literal("error"),
		path: AuthoringAssetPath,
		kind: FailureKind,
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

function failed(
	assetPath: string,
	reason: AuthoringReadFailure["reason"],
	message: string
): AuthoringReadFailure {
	const recovery =
		reason === "unsupported_asset"
			? "Choose an uncooked DataTable or Composite DataTable .uasset."
			: reason === "unsupported_version"
				? "Choose an uncooked package in the supported saved-revision window."
				: reason === "malformed_package"
					? "Restore or resave the package, then retry."
					: "Try a smaller .uasset (up to 64 MiB), or reload the page and retry.";
	return { assetPath, message, reason, recovery, status: "failed" };
}

export const adaptWasmAuthoringTable = Effect.fn("DataAuthoring.adaptWasmTable")(function* (
	assetPath: string,
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Runtime decoding boundary.
	output: unknown
): Effect.fn.Return<AuthoringReadResult> {
	const path = yield* Schema.decodeUnknownEffect(AuthoringAssetPath)(assetPath).pipe(
		Effect.catch(() => Effect.succeed(undefined))
	);
	if (path === undefined) {
		return {
			status: "failed",
			reason: "reader_failure",
			message: "The file name is not a valid DataTable asset path.",
			recovery: "Rename the file and choose it again."
		};
	}
	return yield* Schema.decodeUnknownEffect(WasmAuthoringOutput)(output).pipe(
		Effect.map((read): AuthoringReadResult => {
			if (read.status === "error") {
				const reason =
					read.kind === "malformed_data"
						? "malformed_package"
						: read.kind === "unsupported_version"
							? "unsupported_version"
							: read.kind === "unsupported_format" ||
								  read.kind === "unsupported_capability"
								? "unsupported_asset"
								: "reader_failure";
				return failed(path, reason, read.message);
			}
			return {
				assetPath: path,
				snapshot: read.snapshot,
				// Keep native snapshot diagnostics byte-for-byte; normalize only display warnings.
				diagnostics: read.snapshot.diagnostics.map((diagnostic) => ({
					code: diagnosticCode(diagnostic.code),
					message: diagnostic.message,
					severity: "warning"
				})),
				outcome:
					read.status === "partial" || read.snapshot.completeness === "partial"
						? "partial"
						: "complete",
				status: "ready"
			};
		}),
		Effect.catch(() =>
			Effect.succeed(
				failed(
					path,
					"reader_failure",
					"The browser reader returned invalid table evidence."
				)
			)
		)
	);
});

export const readWasmAuthoringTable = Effect.fn("DataAuthoring.readWasmTable")(function* (
	runtime: WasmAuthoringRuntime,
	assetPath: string,
	bytes: Uint8Array
) {
	const output = yield* Effect.try({
		try: () => runtime.extractAuthoringTable(assetPath, bytes),
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
	return yield* adaptWasmAuthoringTable(assetPath, output);
});
