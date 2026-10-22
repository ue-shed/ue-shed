import { relative } from "node:path";
import {
	AssetReader,
	isHeaderScanEntry,
	isFullScanEntry,
	type AssetReaderError,
	type AssetReaderApi,
	type SavedAssetScan
} from "@ue-shed/unreal-assets";
import { Context, Effect, Layer, Schema } from "effect";
import {
	buildEnhancedInputReport,
	ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
	ENHANCED_INPUT_CLASS_PREFIX,
	isEnhancedInputAssetClass,
	type EnhancedInputPackageOutcome
} from "./projectors.js";
import { EnhancedInputPublicError, type EnhancedInputReport } from "./schema.js";

/** The shared UE Shed error guidance shape, defined here because this package stays protocol-free. */
const ErrorGuidanceFields = {
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"])
};

export class EnhancedInputScanError extends Schema.TaggedError<EnhancedInputScanError>()(
	"EnhancedInputScanError",
	{
		code: EnhancedInputPublicError.fields.code,
		...ErrorGuidanceFields,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

export const EnhancedInputScanOptions = Schema.Struct({
	concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	maximumAssets: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	/** Roots to enumerate beneath the project, relative or absolute. Defaults to all of `Content`. */
	paths: Schema.optional(Schema.Array(Schema.String)),
	projectRoot: Schema.String
});
export type EnhancedInputScanOptions = Schema.Schema.Type<typeof EnhancedInputScanOptions>;

const decodeScanOptions = Schema.decodeUnknownEffect(EnhancedInputScanOptions);

/** Maps a reader failure onto the scan's typed failure, preserving recovery guidance. */
function enhancedInputScanFailure(error: AssetReaderError): EnhancedInputScanError {
	if (error.kind === "resource_limit") {
		return new EnhancedInputScanError({
			cause: error,
			code: "scan_limit_exceeded",
			message: error.message,
			recovery: "Narrow the project or raise the explicit maximum asset limit.",
			retrySafe: false,
			nextStep: "fix_input"
		});
	}
	return new EnhancedInputScanError({
		cause: error,
		code: error.kind === "discovery" ? "invalid_project" : "reader_failed",
		message: error.message,
		recovery: error.recovery,
		retrySafe: error.retrySafe,
		nextStep: error.nextStep
	});
}

function outcomesFromScan(
	scan: SavedAssetScan,
	projectRoot: string
): EnhancedInputPackageOutcome[] {
	return [
		...scan.assets.filter(isFullScanEntry).map(
			(entry): EnhancedInputPackageOutcome => ({
				status: "inspected",
				packageFile: relative(projectRoot, entry.inspection.path),
				inspection: entry.inspection
			})
		),
		...scan.failures.map(
			(failure): EnhancedInputPackageOutcome => ({
				status: "failed",
				packageFile: relative(projectRoot, failure.path),
				message: failure.message
			})
		)
	];
}

/** Selects only packages whose existing header projection identifies Enhanced Input evidence. */
export function enhancedInputCandidatePaths(scan: SavedAssetScan): readonly string[] {
	return [
		...new Set(
			scan.assets
				.filter(isHeaderScanEntry)
				.filter((entry) =>
					entry.header.exports.some(
						(exported) =>
							exported.class_path !== undefined &&
							isEnhancedInputAssetClass(exported.class_path)
					)
				)
				.map((entry) => entry.header.path)
		)
	].sort((left, right) => left.localeCompare(right));
}

/**
 * Reuses a project-wide header index, then fully decodes only the selected Enhanced Input packages.
 * The follow-up calls receive explicit package paths, so they do not recursively enumerate Content.
 */
export function scanEnhancedInputFromProjectIndex(
	index: SavedAssetScan,
	options: EnhancedInputScanOptions
): Effect.Effect<EnhancedInputReport, EnhancedInputScanError, AssetReader> {
	return Effect.gen(function* () {
		const reader = yield* AssetReader;
		const candidates = enhancedInputCandidatePaths(index);
		const batches = Array.from({ length: Math.ceil(candidates.length / 100) }, (_, batch) =>
			candidates.slice(batch * 100, batch * 100 + 100)
		);
		const scans = yield* Effect.forEach(batches, (paths) =>
			reader
				.scanProject({
					concurrency: Math.max(1, options.concurrency ?? 8),
					paths,
					projectRoot: options.projectRoot
				})
				.pipe(Effect.mapError(enhancedInputScanFailure))
		);
		const outcomes = [
			...index.failures.map(
				(failure): EnhancedInputPackageOutcome => ({
					status: "failed",
					packageFile: relative(options.projectRoot, failure.path),
					message: failure.message
				})
			),
			...scans.flatMap((scan) => outcomesFromScan(scan, options.projectRoot))
		];
		return buildEnhancedInputReport(outcomes, {
			discoveredPackages: index.summary.scannedAssets,
			inspectedPackages: scans.reduce((total, scan) => total + scan.summary.scannedAssets, 0)
		});
	}).pipe(Effect.withSpan("enhanced-input.scan_from_project_index"));
}

export function scanEnhancedInputWith(
	reader: Pick<AssetReaderApi, "scanProject">,
	options: EnhancedInputScanOptions
): Effect.Effect<EnhancedInputReport, EnhancedInputScanError> {
	return Effect.gen(function* () {
		// One reader process classifies the whole project from package headers, decoding only
		// packages that export Enhanced Input classes or conventionally named native subclasses.
		const scan = yield* reader
			.scanProject({
				classPrefixes: [ENHANCED_INPUT_CLASS_PREFIX],
				classNameSuffixes: ENHANCED_INPUT_CLASS_NAME_SUFFIXES,
				concurrency: Math.max(1, options.concurrency ?? 8),
				...(options.maximumAssets === undefined
					? undefined
					: { maximumAssets: options.maximumAssets }),
				...(options.paths === undefined ? undefined : { paths: options.paths }),
				projectRoot: options.projectRoot
			})
			.pipe(Effect.mapError(enhancedInputScanFailure));
		const outcomes = outcomesFromScan(scan, options.projectRoot);
		return buildEnhancedInputReport(outcomes, {
			discoveredPackages: scan.summary.scannedAssets,
			inspectedPackages: scan.summary.emittedAssets + scan.summary.skippedAssets
		});
	}).pipe(Effect.withSpan("enhanced-input.scan"));
}

function inspectEnhancedInputPathWith(
	reader: AssetReaderApi,
	path: string
): Effect.Effect<EnhancedInputReport, EnhancedInputScanError> {
	return Effect.gen(function* () {
		const inspection = yield* reader.readAsset(path).pipe(
			Effect.mapError(
				(error) =>
					new EnhancedInputScanError({
						cause: error,
						code: "invalid_path",
						message: error.message,
						recovery: "Provide a readable .uasset path or Unreal project root.",
						retrySafe: true,
						nextStep: "fix_input"
					})
			)
		);
		return buildEnhancedInputReport([
			{
				status: "inspected",
				packageFile: path,
				inspection
			}
		]);
	}).pipe(Effect.withSpan("enhanced-input.inspect-path"));
}

export interface EnhancedInputServiceApi {
	readonly inspectPath: (
		path: string
	) => Effect.Effect<EnhancedInputReport, EnhancedInputScanError>;
	readonly scan: (
		options: EnhancedInputScanOptions
	) => Effect.Effect<EnhancedInputReport, EnhancedInputScanError>;
}

export class EnhancedInputService extends Context.Service<
	EnhancedInputService,
	EnhancedInputServiceApi
>()("@ue-shed/enhanced-input/EnhancedInput") {}

export const EnhancedInputServiceLive = Layer.effect(
	EnhancedInputService,
	Effect.gen(function* () {
		const reader = yield* AssetReader;
		const scan = Effect.fn("EnhancedInput.scan")(function* (options: EnhancedInputScanOptions) {
			const validated = yield* decodeScanOptions(options).pipe(
				Effect.mapError(
					(cause) =>
						new EnhancedInputScanError({
							code: "scan_limit_exceeded",
							message:
								"Enhanced Input scan options need a project root and positive scan limits.",
							recovery: "Provide a project root and positive scan limits.",
							retrySafe: false,
							nextStep: "fix_input",
							cause
						})
				)
			);
			return yield* scanEnhancedInputWith(reader, validated);
		});
		const inspectPath = Effect.fn("EnhancedInput.inspectPath")(function* (path: string) {
			if (path.trim().length === 0) {
				return yield* new EnhancedInputScanError({
					code: "invalid_path",
					message: "Enhanced Input inspect requires a non-empty path.",
					recovery: "Provide a .uasset path or Unreal project root.",
					retrySafe: false,
					nextStep: "fix_input"
				});
			}
			return yield* inspectEnhancedInputPathWith(reader, path);
		});
		return EnhancedInputService.of({ inspectPath, scan });
	})
);
