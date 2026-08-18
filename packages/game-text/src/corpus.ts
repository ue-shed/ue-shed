import { relative } from "node:path";
import {
	AssetReader,
	isHeaderScanEntry,
	type AssetReaderError,
	type AssetReaderApi,
	type SavedAssetInspection,
	type SavedAssetScan,
	type SavedAssetTextExtractionEvent,
	type SavedAssetTextOccurrence,
	type SavedProperty,
	type SavedPropertyValue
} from "@ue-shed/unreal-assets";
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect";
import {
	TextOccurrenceId,
	TextUnitId,
	type TextCorpus,
	type TextCorpusDiagnostic,
	type TextIdentity,
	type TextLocation,
	type TextOccurrence,
	type TextUnit
} from "./schema.js";

const makeOccurrenceId = TextOccurrenceId.make;
const makeUnitId = TextUnitId.make;

interface ExtractionProgress {
	readonly phase: "idle" | "scanning" | "ready" | "failed";
	readonly processedAssets: number;
	readonly totalAssets: number;
}

export class TextCorpusScanError extends Schema.TaggedErrorClass<TextCorpusScanError>()(
	"TextCorpusScanError",
	{
		code: Schema.Literals(["invalid_project", "scan_limit_exceeded"]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export const TextCorpusScanOptions = Schema.Struct({
	concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	maximumAssets: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	projectRoot: Schema.String
});
export type TextCorpusScanOptions = Schema.Schema.Type<typeof TextCorpusScanOptions>;

const decodeScanOptions = Schema.decodeUnknownEffect(TextCorpusScanOptions);

export const STRING_TABLE_CLASS = "/Script/Engine.StringTable";

/**
 * Tagged property serialization writes each property's type as a name-table entry, so a package
 * holding any `FText` names `TextProperty` in its header.
 */
export const TEXT_PROPERTY_NAME = "TextProperty";

/** Maps a reader failure onto the corpus scan's typed failure, preserving recovery guidance. */
function textCorpusScanFailure(error: AssetReaderError): TextCorpusScanError {
	if (error.kind === "resource_limit") {
		return new TextCorpusScanError({
			code: "scan_limit_exceeded",
			message: error.message,
			recovery: "Narrow the project or raise the explicit maximum asset limit.",
			retrySafe: false
		});
	}
	return new TextCorpusScanError({
		code: "invalid_project",
		message: error.message,
		recovery: "Choose an Unreal project directory containing a Content folder.",
		retrySafe: error.retrySafe
	});
}

/** @deprecated Prefer TextCorpusScanOptions */
export type ScanTextCorpusOptions = TextCorpusScanOptions;

export type TextPackageOutcome =
	| {
			readonly status: "inspected";
			readonly packageFile: string;
			readonly inspection: SavedAssetInspection;
	  }
	| { readonly status: "failed"; readonly packageFile: string; readonly message: string };

interface UnsupportedTextProperty {
	readonly objectPath: string;
	readonly propertyPath: string;
}

function identityForText(
	value: Extract<SavedPropertyValue, { readonly value_kind: "text" }>
): TextIdentity {
	if (value.history === "base" && value.key.length > 0) {
		return { status: "resolved", namespace: value.namespace, key: value.key };
	}
	return {
		status: "unresolved",
		reason: value.history === "none" ? "culture_invariant" : "missing_key"
	};
}

function occurrenceId(packageFile: string, location: TextLocation): string {
	const suffix =
		location.kind === "string_table_entry"
			? `entry:${location.entryKey}`
			: location.kind === "data_table_cell"
				? `row:${location.row}:property:${location.propertyPath}`
				: `property:${location.propertyPath}`;
	return `occurrence:${location.objectPath}:${suffix}:${packageFile}`;
}

function addTextOccurrence(options: {
	readonly output: TextOccurrence[];
	readonly packageFile: string;
	readonly value: Extract<SavedPropertyValue, { readonly value_kind: "text" }>;
	readonly location: TextLocation;
	readonly editCapability: TextOccurrence["editCapability"];
}): void {
	options.output.push({
		id: makeOccurrenceId(occurrenceId(options.packageFile, options.location)),
		packageFile: options.packageFile,
		source: options.value.value,
		identity: identityForText(options.value),
		location: options.location,
		editCapability: options.editCapability
	});
}

function textOccurrenceFromExtraction(options: {
	readonly occurrence: SavedAssetTextOccurrence;
	readonly packageFile: string;
}): TextOccurrence {
	const identity: TextIdentity =
		options.occurrence.identity.status === "resolved" &&
		options.occurrence.identity.key.length > 0
			? {
					status: "resolved",
					namespace: options.occurrence.identity.namespace,
					key: options.occurrence.identity.key
				}
			: {
					status: "unresolved",
					reason:
						options.occurrence.identity.status === "unresolved"
							? options.occurrence.identity.reason
							: "missing_key"
				};
	const location: TextLocation =
		options.occurrence.location.kind === "string_table_entry"
			? {
					kind: "string_table_entry",
					objectPath: options.occurrence.location.object_path,
					entryKey: options.occurrence.location.entry_key
				}
			: options.occurrence.location.kind === "data_table_cell"
				? {
						kind: "data_table_cell",
						objectPath: options.occurrence.location.object_path,
						row: options.occurrence.location.row,
						propertyPath: options.occurrence.location.property_path
					}
				: {
						kind: "asset_property",
						objectPath: options.occurrence.location.object_path,
						classPath: options.occurrence.location.class_path,
						propertyPath: options.occurrence.location.property_path
					};
	return {
		id: makeOccurrenceId(occurrenceId(options.packageFile, location)),
		packageFile: options.packageFile,
		source: options.occurrence.source,
		identity,
		location,
		editCapability: options.occurrence.edit_capability
	};
}

function visitValue(options: {
	readonly output: TextOccurrence[];
	readonly packageFile: string;
	readonly value: SavedPropertyValue;
	readonly path: string;
	readonly location: (path: string) => TextLocation;
	readonly editCapability: TextOccurrence["editCapability"];
}): void {
	const { value } = options;
	if (value.value_kind === "text") {
		addTextOccurrence({
			output: options.output,
			packageFile: options.packageFile,
			value,
			location: options.location(options.path),
			editCapability: options.editCapability
		});
		return;
	}
	if (value.value_kind === "array" || value.value_kind === "set") {
		value.values.forEach((item, index) =>
			visitValue({ ...options, value: item, path: `${options.path}[${index}]` })
		);
		return;
	}
	if (value.value_kind === "map") {
		value.entries.forEach((entry, index) => {
			visitValue({ ...options, value: entry.key, path: `${options.path}{${index}}.key` });
			visitValue({ ...options, value: entry.value, path: `${options.path}{${index}}.value` });
		});
		return;
	}
	if (value.value_kind === "struct") {
		visitProperties({ ...options, properties: value.properties });
	}
}

function visitProperties(options: {
	readonly output: TextOccurrence[];
	readonly packageFile: string;
	readonly properties: readonly SavedProperty[];
	readonly path: string;
	readonly location: (path: string) => TextLocation;
	readonly editCapability: TextOccurrence["editCapability"];
}): void {
	for (const property of options.properties) {
		const path = options.path ? `${options.path}.${property.name}` : property.name;
		visitValue({ ...options, value: property, path });
	}
}

function unsupportedTextProperties(
	inspection: SavedAssetInspection
): readonly UnsupportedTextProperty[] {
	const gaps: UnsupportedTextProperty[] = [];
	const visit = (
		objectPath: string,
		properties: readonly SavedProperty[],
		prefix: string
	): void => {
		for (const property of properties) {
			const propertyPath = prefix ? `${prefix}.${property.name}` : property.name;
			if (property.type === "TextProperty" && property.value_kind === "raw") {
				gaps.push({ objectPath, propertyPath });
			}
			if (property.value_kind === "struct") {
				visit(objectPath, property.properties, propertyPath);
			}
		}
	};
	for (const asset of inspection.assets) {
		if (isPropertyBearingAsset(asset)) visit(asset.object_path, asset.properties, "");
		if (asset.kind === "DataTable" || asset.kind === "CompositeDataTable") {
			for (const row of asset.rows)
				visit(asset.object_path, row.properties, `row:${row.name}`);
		}
	}
	return gaps;
}

type PropertyBearingAsset = Extract<
	SavedAssetInspection["assets"][number],
	{
		readonly kind:
			| "UObject"
			| "DataAsset"
			| "PrimaryDataAsset"
			| "CurveTable"
			| "Skeleton"
			| "Struct";
	}
>;

function isPropertyBearingAsset(
	asset: SavedAssetInspection["assets"][number]
): asset is PropertyBearingAsset {
	return (
		asset.kind === "UObject" ||
		asset.kind === "DataAsset" ||
		asset.kind === "PrimaryDataAsset" ||
		asset.kind === "CurveTable" ||
		asset.kind === "Skeleton" ||
		asset.kind === "Struct"
	);
}

export function textOccurrencesFromInspection(options: {
	readonly inspection: SavedAssetInspection;
	readonly packageFile: string;
}): readonly TextOccurrence[] {
	const output: TextOccurrence[] = [];
	for (const asset of options.inspection.assets) {
		if (asset.kind === "StringTable") {
			for (const entry of asset.string_table_entries) {
				const location: TextLocation = {
					kind: "string_table_entry",
					objectPath: asset.object_path,
					entryKey: entry.key
				};
				addTextOccurrence({
					output,
					packageFile: options.packageFile,
					value: {
						value_kind: "text",
						value: entry.source,
						history: "base",
						namespace: asset.string_table_namespace,
						key: entry.key
					},
					location,
					editCapability: "source_editable"
				});
			}
			continue;
		}
		if (asset.kind === "DataTable" || asset.kind === "CompositeDataTable") {
			for (const row of asset.rows) {
				visitProperties({
					output,
					packageFile: options.packageFile,
					properties: row.properties,
					path: "",
					location: (propertyPath) => ({
						kind: "data_table_cell",
						objectPath: asset.object_path,
						row: row.name,
						propertyPath
					}),
					editCapability: "source_editable"
				});
			}
			continue;
		}
		if (isPropertyBearingAsset(asset)) {
			visitProperties({
				output,
				packageFile: options.packageFile,
				properties: asset.properties,
				path: "",
				location: (propertyPath) => ({
					kind: "asset_property",
					objectPath: asset.object_path,
					classPath: asset.class_path,
					propertyPath
				}),
				editCapability: "read_only"
			});
		}
	}
	return output.sort((left, right) => left.id.localeCompare(right.id));
}

/** Paths whose existing header-index projection proves they may contribute game text. */
export function textPackagePathsFromProjectIndex(index: SavedAssetScan): readonly string[] {
	return [
		...new Set(
			index.assets
				.filter(isHeaderScanEntry)
				.filter(
					(entry) =>
						entry.header.matched_names?.includes(TEXT_PROPERTY_NAME) === true ||
						entry.header.exports.some(
							(exported) => exported.class_path === STRING_TABLE_CLASS
						)
				)
				.map((entry) => entry.header.path)
		)
	].sort((left, right) => left.localeCompare(right));
}

function unitKey(occurrence: TextOccurrence): string {
	return occurrence.identity.status === "resolved"
		? `unreal:${encodeURIComponent(occurrence.identity.namespace)}:${encodeURIComponent(occurrence.identity.key)}`
		: occurrence.id;
}

/**
 * Package counts from a batched scan. A filtered scan never reports packages the reader ruled out
 * from their headers, so discovered and inspected cannot be derived from `outcomes` alone.
 */
export interface TextPackageCounts {
	readonly discoveredPackages: number;
	readonly inspectedPackages: number;
}

export function buildTextCorpus(
	outcomes: readonly TextPackageOutcome[],
	counts?: TextPackageCounts
): TextCorpus {
	const occurrences = outcomes.flatMap((outcome) =>
		outcome.status === "inspected"
			? textOccurrencesFromInspection({
					inspection: outcome.inspection,
					packageFile: outcome.packageFile
				})
			: []
	);
	const grouped = new Map<string, TextOccurrence[]>();
	for (const occurrence of occurrences) {
		const key = unitKey(occurrence);
		grouped.set(key, [...(grouped.get(key) ?? []), occurrence]);
	}
	const units: TextUnit[] = [...grouped.entries()]
		.map(([id, groupedOccurrences]) => {
			const sources = [
				...new Set(groupedOccurrences.map((occurrence) => occurrence.source))
			].sort();
			return {
				id: makeUnitId(id),
				source:
					sources.length === 1
						? { status: "consistent" as const, value: sources[0] ?? "" }
						: { status: "conflicting" as const, values: sources },
				identity: groupedOccurrences[0]?.identity ?? {
					status: "unresolved",
					reason: "missing_key"
				},
				occurrences: groupedOccurrences
			};
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const inspected = outcomes.filter((outcome) => outcome.status === "inspected");
	const partialPackages = inspected.filter(
		(outcome) => outcome.inspection.status === "partial"
	).length;
	const failedPackages = outcomes.length - inspected.length;
	const unsupported = inspected.flatMap((outcome) =>
		unsupportedTextProperties(outcome.inspection).map((gap) => ({
			...gap,
			packageFile: outcome.packageFile
		}))
	);
	const diagnostics: TextCorpusDiagnostic[] = outcomes.flatMap<TextCorpusDiagnostic>(
		(outcome) => {
			if (outcome.status === "failed") {
				return [
					{
						code: "package_inspection_failed" as const,
						message: outcome.message,
						packageFile: outcome.packageFile
					}
				];
			}
			if (outcome.inspection.status === "partial") {
				return [
					{
						code: "package_partially_decoded" as const,
						message: `${outcome.inspection.decode_errors.length} decode error(s) limit this package's coverage.`,
						packageFile: outcome.packageFile
					}
				];
			}
			return [];
		}
	);
	diagnostics.push(
		...unsupported.map((gap) => ({
			code: "unsupported_text_history" as const,
			message: "This FText history is visible but not decoded by the saved-package reader.",
			packageFile: gap.packageFile,
			objectPath: gap.objectPath,
			propertyPath: gap.propertyPath
		}))
	);
	const resolvedOccurrences = occurrences.filter(
		(occurrence) => occurrence.identity.status === "resolved"
	).length;
	return {
		schemaVersion: 1,
		status:
			partialPackages > 0 || failedPackages > 0 || unsupported.length > 0
				? "partial"
				: "complete",
		coverage: {
			discoveredPackages: counts?.discoveredPackages ?? outcomes.length,
			inspectedPackages: counts?.inspectedPackages ?? inspected.length,
			partialPackages,
			failedPackages,
			textUnits: units.length,
			textOccurrences: occurrences.length,
			resolvedOccurrences,
			unresolvedOccurrences: occurrences.length - resolvedOccurrences,
			unsupportedTextProperties: unsupported.length
		},
		units,
		diagnostics
	};
}

interface TextExtractionAccumulator {
	readonly coverageGaps: Array<{
		readonly objectPath: string;
		readonly packageFile: string;
		readonly propertyPath: string;
	}>;
	readonly diagnostics: TextCorpusDiagnostic[];
	failedPackages: number;
	inspectedPackages: number;
	readonly occurrences: TextOccurrence[];
	partialPackages: number;
	summary?: Extract<SavedAssetTextExtractionEvent, { readonly event: "text_summary" }>;
}

function emptyTextExtractionAccumulator(): TextExtractionAccumulator {
	return {
		coverageGaps: [],
		diagnostics: [],
		failedPackages: 0,
		inspectedPackages: 0,
		occurrences: [],
		partialPackages: 0
	};
}

function foldTextExtractionEvent(
	projectRoot: string,
	accumulator: TextExtractionAccumulator,
	event: SavedAssetTextExtractionEvent
): TextExtractionAccumulator {
	if (event.event === "text_occurrence") {
		accumulator.occurrences.push(
			textOccurrenceFromExtraction({
				occurrence: event.occurrence,
				packageFile: relative(projectRoot, event.path)
			})
		);
		return accumulator;
	}
	if (event.event === "text_coverage_gap") {
		accumulator.coverageGaps.push({
			objectPath: event.coverage_gap.object_path,
			packageFile: relative(projectRoot, event.path),
			propertyPath: event.coverage_gap.property_path
		});
		return accumulator;
	}
	if (event.event === "text_package") {
		accumulator.inspectedPackages += 1;
		if (event.status === "partial") {
			accumulator.partialPackages += 1;
			accumulator.diagnostics.push({
				code: "package_partially_decoded",
				message: `${event.diagnostics.length} decode error(s) limit this package's coverage.`,
				packageFile: relative(projectRoot, event.path)
			});
		}
		return accumulator;
	}
	if (event.event === "error") {
		accumulator.failedPackages += 1;
		accumulator.diagnostics.push({
			code: "package_inspection_failed",
			message: event.message,
			packageFile: relative(projectRoot, event.path)
		});
		return accumulator;
	}
	accumulator.summary = event;
	return accumulator;
}

function buildTextCorpusFromExtraction(options: {
	readonly accumulator: TextExtractionAccumulator;
	readonly discoveredPackages: number;
}): TextCorpus {
	const { accumulator } = options;
	const grouped = new Map<string, TextOccurrence[]>();
	for (const occurrence of accumulator.occurrences) {
		const key = unitKey(occurrence);
		grouped.set(key, [...(grouped.get(key) ?? []), occurrence]);
	}
	const units: TextUnit[] = [...grouped.entries()]
		.map(([id, groupedOccurrences]) => {
			const sources = [
				...new Set(groupedOccurrences.map((occurrence) => occurrence.source))
			].sort();
			return {
				id: makeUnitId(id),
				source:
					sources.length === 1
						? { status: "consistent" as const, value: sources[0] ?? "" }
						: { status: "conflicting" as const, values: sources },
				identity: groupedOccurrences[0]?.identity ?? {
					status: "unresolved",
					reason: "missing_key"
				},
				occurrences: groupedOccurrences
			};
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const diagnostics = [
		...accumulator.diagnostics,
		...accumulator.coverageGaps.map(
			(gap): TextCorpusDiagnostic => ({
				code: "unsupported_text_history",
				message:
					"This FText history is visible but not decoded by the saved-package reader.",
				packageFile: gap.packageFile,
				objectPath: gap.objectPath,
				propertyPath: gap.propertyPath
			})
		)
	];
	const resolvedOccurrences = accumulator.occurrences.filter(
		(occurrence) => occurrence.identity.status === "resolved"
	).length;
	const summary = accumulator.summary;
	const inspectedPackages =
		summary === undefined
			? accumulator.inspectedPackages
			: summary.emittedAssets + summary.skippedAssets;
	const discoveredPackages =
		options.discoveredPackages > 0
			? options.discoveredPackages
			: (summary?.scannedAssets ?? options.discoveredPackages);
	return {
		schemaVersion: 1,
		status:
			accumulator.partialPackages > 0 ||
			accumulator.failedPackages > 0 ||
			accumulator.coverageGaps.length > 0
				? "partial"
				: "complete",
		coverage: {
			discoveredPackages,
			inspectedPackages,
			partialPackages: accumulator.partialPackages,
			failedPackages: accumulator.failedPackages,
			textUnits: units.length,
			textOccurrences: accumulator.occurrences.length,
			resolvedOccurrences,
			unresolvedOccurrences: accumulator.occurrences.length - resolvedOccurrences,
			unsupportedTextProperties: accumulator.coverageGaps.length
		},
		units,
		diagnostics
	};
}

function extractTextCorpusWith(
	reader: AssetReaderApi,
	options: {
		readonly concurrency?: number;
		readonly discoveredPackages: number;
		readonly maximumAssets?: number;
		readonly paths?: readonly string[];
		readonly projectRoot: string;
	},
	inheritedFailures: readonly TextCorpusDiagnostic[] = [],
	reportProgress: (progress: ExtractionProgress) => Effect.Effect<void> = () => Effect.void
): Effect.Effect<TextCorpus, TextCorpusScanError> {
	if (options.paths?.length === 0) {
		const accumulator = emptyTextExtractionAccumulator();
		accumulator.failedPackages = inheritedFailures.length;
		accumulator.diagnostics.push(...inheritedFailures);
		return reportProgress({ phase: "ready", processedAssets: 0, totalAssets: 0 }).pipe(
			Effect.as(
				buildTextCorpusFromExtraction({
					accumulator,
					discoveredPackages: options.discoveredPackages
				})
			)
		);
	}
	const totalAssets = options.paths?.length ?? 0;
	let processedAssets = 0;
	return reportProgress({ phase: "scanning", processedAssets: 0, totalAssets }).pipe(
		Effect.andThen(
			reader
				.extractProjectText({
					concurrency: Math.max(1, options.concurrency ?? 8),
					...(options.maximumAssets === undefined
						? undefined
						: { maximumAssets: options.maximumAssets }),
					...(options.paths === undefined ? undefined : { paths: options.paths }),
					projectRoot: options.projectRoot
				})
				.pipe(
					Stream.tap((event) => {
						if (event.event === "text_summary") {
							processedAssets =
								event.emittedAssets + event.failedAssets + event.skippedAssets;
							return reportProgress({
								phase: "scanning",
								processedAssets,
								totalAssets: totalAssets > 0 ? totalAssets : event.scannedAssets
							});
						}
						if (event.event !== "text_package" && event.event !== "error") {
							return Effect.void;
						}
						processedAssets += 1;
						return reportProgress({
							phase: "scanning",
							processedAssets,
							totalAssets
						});
					}),
					Stream.runFold(
						() => {
							const accumulator = emptyTextExtractionAccumulator();
							accumulator.failedPackages = inheritedFailures.length;
							accumulator.diagnostics.push(...inheritedFailures);
							return accumulator;
						},
						(current, event) =>
							foldTextExtractionEvent(options.projectRoot, current, event)
					),
					Effect.map((folded) =>
						buildTextCorpusFromExtraction({
							accumulator: folded,
							discoveredPackages: options.discoveredPackages
						})
					),
					Effect.mapError(textCorpusScanFailure),
					Effect.onExit((exit) =>
						reportProgress({
							phase: exit._tag === "Success" ? "ready" : "failed",
							processedAssets,
							totalAssets
						})
					)
				)
		)
	);
}

function scanTextCorpusWith(
	reader: AssetReaderApi,
	options: TextCorpusScanOptions,
	reportProgress: (progress: ExtractionProgress) => Effect.Effect<void>
): Effect.Effect<TextCorpus, TextCorpusScanError> {
	return extractTextCorpusWith(
		reader,
		{
			discoveredPackages: 0,
			...(options.concurrency === undefined
				? undefined
				: { concurrency: options.concurrency }),
			...(options.maximumAssets === undefined
				? undefined
				: { maximumAssets: options.maximumAssets }),
			projectRoot: options.projectRoot
		},
		[],
		reportProgress
	).pipe(Effect.withSpan("game-text.scan-corpus"));
}

function scanTextCorpusFromProjectIndexWith(
	reader: AssetReaderApi,
	index: SavedAssetScan,
	options: TextCorpusScanOptions,
	reportProgress: (progress: ExtractionProgress) => Effect.Effect<void>
): Effect.Effect<TextCorpus, TextCorpusScanError> {
	const paths = textPackagePathsFromProjectIndex(index);
	const inheritedFailures = index.failures.map(
		(failure): TextCorpusDiagnostic => ({
			code: "package_inspection_failed",
			message: failure.message,
			packageFile: relative(options.projectRoot, failure.path)
		})
	);
	return extractTextCorpusWith(
		reader,
		{
			discoveredPackages: index.summary.scannedAssets,
			...(options.concurrency === undefined
				? undefined
				: { concurrency: options.concurrency }),
			...(options.maximumAssets === undefined
				? undefined
				: { maximumAssets: options.maximumAssets }),
			paths,
			projectRoot: options.projectRoot
		},
		inheritedFailures,
		reportProgress
	).pipe(Effect.withSpan("game-text.scan-corpus-from-project-index"));
}

export interface TextCorpusServiceApi {
	readonly progress: () => Effect.Effect<ExtractionProgress>;
	readonly scan: (
		options: TextCorpusScanOptions
	) => Effect.Effect<TextCorpus, TextCorpusScanError>;
	readonly scanFromProjectIndex: (
		index: SavedAssetScan,
		options: TextCorpusScanOptions
	) => Effect.Effect<TextCorpus, TextCorpusScanError>;
}

/** @deprecated Use `TextCorpusServiceApi`. */
export type TextCorpusServiceShape = TextCorpusServiceApi;

/** Canonical TextCorpus domain service (plan name: TextCorpus.Service). */
export class TextCorpusService extends Context.Service<TextCorpusService, TextCorpusServiceApi>()(
	"@ue-shed/game-text/TextCorpus"
) {}

export const TextCorpusServiceLive = Layer.effect(
	TextCorpusService,
	Effect.gen(function* () {
		const reader = yield* AssetReader;
		const progressState = yield* Ref.make<ExtractionProgress>({
			phase: "idle",
			processedAssets: 0,
			totalAssets: 0
		});
		const reportProgress = (progress: ExtractionProgress) => Ref.set(progressState, progress);
		const progress = Effect.fn("TextCorpus.progress")(() => Ref.get(progressState));
		const scan = Effect.fn("TextCorpus.scan")(function* (options: TextCorpusScanOptions) {
			const validated = yield* decodeScanOptions(options).pipe(
				Effect.mapError(
					(cause) =>
						new TextCorpusScanError({
							code: "scan_limit_exceeded",
							message: `Invalid text corpus scan options: ${String(cause)}`,
							recovery: "Provide a project root and positive scan limits.",
							retrySafe: false
						})
				)
			);
			return yield* scanTextCorpusWith(reader, validated, reportProgress);
		});
		const scanFromProjectIndex = Effect.fn("TextCorpus.scanFromProjectIndex")(function* (
			index: SavedAssetScan,
			options: TextCorpusScanOptions
		) {
			const validated = yield* decodeScanOptions(options).pipe(
				Effect.mapError(
					(cause) =>
						new TextCorpusScanError({
							code: "scan_limit_exceeded",
							message: `Invalid text corpus scan options: ${String(cause)}`,
							recovery: "Provide a project root and positive scan limits.",
							retrySafe: false
						})
				)
			);
			return yield* scanTextCorpusFromProjectIndexWith(
				reader,
				index,
				validated,
				reportProgress
			);
		});
		return TextCorpusService.of({ progress, scan, scanFromProjectIndex });
	})
);

export type TextCorpusServiceTestApi = Omit<
	TextCorpusServiceApi,
	"progress" | "scanFromProjectIndex"
> &
	Partial<Pick<TextCorpusServiceApi, "progress" | "scanFromProjectIndex">>;

/** @deprecated Use `TextCorpusServiceTestApi`. */
export type TextCorpusServiceTestShape = TextCorpusServiceTestApi;

export function makeTextCorpusServiceTestLayer(
	service: TextCorpusServiceTestApi
): Layer.Layer<TextCorpusService> {
	return Layer.succeed(
		TextCorpusService,
		TextCorpusService.of({
			...service,
			progress:
				service.progress ??
				(() => Effect.succeed({ phase: "idle", processedAssets: 0, totalAssets: 0 })),
			scanFromProjectIndex:
				service.scanFromProjectIndex ?? ((_index, options) => service.scan(options))
		})
	);
}

/** Compatibility accessor until Plans 012–014 compose TextCorpusService layers directly. */
export function scanTextCorpus(
	options: TextCorpusScanOptions
): Effect.Effect<TextCorpus, TextCorpusScanError, AssetReader> {
	return Effect.flatMap(TextCorpusService, (service) => service.scan(options)).pipe(
		Effect.provide(TextCorpusServiceLive)
	);
}
