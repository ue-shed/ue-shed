import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import {
	AssetReader,
	isHeaderScanEntry,
	type AssetReaderError,
	type AssetReaderApi,
	type SavedAssetInspection,
	type SavedAssetScan,
	type SavedAssetTextureExtractionEvent,
	type SavedAssetTextureRecord,
	type SavedProperty
} from "@ue-shed/unreal-assets";
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect";
import { maximumDimensionKey } from "./report.js";
import {
	AuditRuleId,
	TextureObjectPath,
	TextureAuditPublicError,
	decodeTextureAuditRuleSet,
	type DistributionBucket,
	type TextureAuditFinding,
	type TextureAuditReport,
	type TextureAuditRule,
	type TextureAuditRuleSet,
	type TextureDistributions,
	type TextureRecord
} from "./schema.js";

const makeTextureObjectPath = TextureObjectPath.make;
const makeAuditRuleId = AuditRuleId.make;

interface ExtractionProgress {
	readonly phase: "idle" | "scanning" | "ready" | "failed";
	readonly processedAssets: number;
	readonly totalAssets: number;
}

export class TextureAuditScanError extends Schema.TaggedErrorClass<TextureAuditScanError>()(
	"TextureAuditScanError",
	TextureAuditPublicError.fields
) {}

export const TextureAuditScanOptions = Schema.Struct({
	concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	maximumAssets: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	projectRoot: Schema.String,
	ruleFile: Schema.String
});
export type TextureAuditScanOptions = Schema.Schema.Type<typeof TextureAuditScanOptions>;

const decodeScanOptions = Schema.decodeUnknownEffect(TextureAuditScanOptions);

/** Maps a reader failure onto the audit's typed failure, preserving recovery guidance. */
function textureScanFailure(error: AssetReaderError): TextureAuditScanError {
	if (error.kind === "resource_limit") {
		return new TextureAuditScanError({
			code: "scan_failed",
			message: error.message,
			recovery: "Narrow the project or raise the explicit maximum asset limit.",
			retrySafe: false
		});
	}
	if (error.kind === "discovery") {
		return new TextureAuditScanError({
			code: "invalid_project",
			message: error.message,
			recovery: "Choose an Unreal project directory containing a Content folder.",
			retrySafe: true
		});
	}
	return new TextureAuditScanError({
		code: "scan_failed",
		message: error.message,
		recovery: "Retry the scan, then verify the saved-asset reader is installed.",
		retrySafe: error.retrySafe
	});
}

const unavailable = (reason: "not_serialized" | "wrong_value_kind" | "missing_source") => ({
	status: "unavailable" as const,
	reason
});

function rootProperty(
	properties: readonly SavedProperty[],
	name: string
): SavedProperty | undefined {
	return properties.find((property) => property.name === name);
}

function serializedString(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "enum" && property.value_kind !== "name") {
		return unavailable("wrong_value_kind");
	}
	return { status: "available" as const, source: "serialized" as const, value: property.value };
}

function serializedBoolean(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "bool") return unavailable("wrong_value_kind");
	return { status: "available" as const, source: "serialized" as const, value: property.value };
}

function sourceProperties(
	properties: readonly SavedProperty[]
): readonly SavedProperty[] | undefined {
	const source = rootProperty(properties, "Source");
	return source?.value_kind === "struct" ? source.properties : undefined;
}

function sourceInteger(properties: readonly SavedProperty[], name: string) {
	const source = sourceProperties(properties);
	if (!source) return unavailable("missing_source");
	const property = rootProperty(source, name);
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "int" || !Number.isInteger(property.value) || property.value < 0) {
		return unavailable("wrong_value_kind");
	}
	return { status: "available" as const, source: "serialized" as const, value: property.value };
}

export const TEXTURE_CLASS = "/Script/Engine.Texture2D";

/** Paths whose existing header-index projection proves they export a Texture2D. */
export function texturePackagePathsFromProjectIndex(index: SavedAssetScan): readonly string[] {
	return [
		...new Set(
			index.assets
				.filter(isHeaderScanEntry)
				.filter((entry) =>
					entry.header.exports.some((exported) => exported.class_path === TEXTURE_CLASS)
				)
				.map((entry) => entry.header.path)
		)
	].sort((left, right) => left.localeCompare(right));
}

export function findTextureExports(inspection: SavedAssetInspection) {
	type SavedAsset = SavedAssetInspection["assets"][number];
	type UObjectAsset = Extract<SavedAsset, { readonly kind: "UObject" }>;
	return inspection.assets.filter(
		(asset): asset is UObjectAsset =>
			asset.kind === "UObject" && asset.class_path === TEXTURE_CLASS
	);
}

export function textureRecordsFromInspection(options: {
	readonly inspection: SavedAssetInspection;
	readonly filePath: string;
	readonly packageFileBytes: number;
}): readonly TextureRecord[] {
	return findTextureExports(options.inspection)
		.map((asset): TextureRecord => {
			const width = sourceInteger(asset.properties, "SizeX");
			const height = sourceInteger(asset.properties, "SizeY");
			const format = sourceProperties(asset.properties);
			const sourceFormat = format
				? serializedString(format, "Format")
				: unavailable("missing_source");
			return {
				objectPath: makeTextureObjectPath(asset.object_path),
				filePath: options.filePath,
				packageFileBytes: {
					status: "available",
					source: "file",
					value: options.packageFileBytes
				},
				dimensions:
					width.status === "available" && height.status === "available"
						? {
								status: "available",
								source: "serialized",
								value: { width: width.value, height: height.value }
							}
						: unavailable(
								width.status === "unavailable" ? width.reason : "wrong_value_kind"
							),
				sourceFormat,
				sourceMips: sourceInteger(asset.properties, "NumMips"),
				compression: serializedString(asset.properties, "CompressionSettings"),
				sRGB: serializedBoolean(asset.properties, "SRGB"),
				textureGroup: serializedString(asset.properties, "LODGroup"),
				mipGeneration: serializedString(asset.properties, "MipGenSettings")
			};
		})
		.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
}

function textureRecordFromExtraction(options: {
	readonly filePath: string;
	readonly record: SavedAssetTextureRecord;
}): TextureRecord {
	return {
		objectPath: makeTextureObjectPath(options.record.object_path),
		filePath: options.filePath,
		packageFileBytes: options.record.package_file_bytes,
		dimensions: options.record.dimensions,
		sourceFormat: options.record.source_format,
		sourceMips: options.record.source_mips,
		compression: options.record.compression,
		sRGB: options.record.s_rgb,
		textureGroup: options.record.texture_group,
		mipGeneration: options.record.mip_generation
	};
}

export function isPowerOfTwo(value: number): boolean {
	return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export function evaluateTextureRule(
	record: TextureRecord,
	rule: TextureAuditRule
): TextureAuditFinding | undefined {
	if (record.dimensions.status !== "available") return undefined;
	const { width, height } = record.dimensions.value;
	if (rule.kind === "dimensions_power_of_two") {
		if (isPowerOfTwo(width) && isPowerOfTwo(height)) return undefined;
		return {
			ruleId: makeAuditRuleId(rule.id),
			severity: rule.severity,
			objectPath: record.objectPath,
			explanation: `${width}×${height} is not power-of-two on both axes.`,
			actual: [{ label: "Source dimensions", value: `${width} × ${height}` }],
			expected: [{ label: "Dimensions", value: "Each axis is a power of two" }]
		};
	}
	if (
		record.textureGroup.status !== "available" ||
		record.textureGroup.value !== rule.textureGroup
	) {
		return undefined;
	}
	const largest = Math.max(width, height);
	if (largest <= rule.maximum) return undefined;
	return {
		ruleId: makeAuditRuleId(rule.id),
		severity: rule.severity,
		objectPath: record.objectPath,
		explanation: `${rule.textureGroup} texture exceeds its ${rule.maximum}px source limit.`,
		actual: [
			{ label: "Largest axis", value: `${largest}px` },
			{ label: "Texture group", value: rule.textureGroup }
		],
		expected: [{ label: "Maximum axis", value: `${rule.maximum}px` }]
	};
}

function stringDistribution(
	records: readonly TextureRecord[],
	select: (record: TextureRecord) => TextureRecord["compression"] | TextureRecord["sRGB"]
): readonly DistributionBucket[] {
	const counts = new Map<string, number>();
	for (const record of records) {
		const evidence = select(record);
		const value = evidence.status === "available" ? String(evidence.value) : "Unavailable";
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, count]) => ({ key, label: key, count }));
}

export function foldTextureDistributions(records: readonly TextureRecord[]): TextureDistributions {
	const dimensionOrder = ["le-256", "257-512", "513-1024", "gt-1024", "unavailable"];
	interface DimensionLabels {
		readonly [dimension: string]: string;
	}
	const dimensionLabels: DimensionLabels = {
		"le-256": "≤ 256 px",
		"257-512": "257–512 px",
		"513-1024": "513–1,024 px",
		"gt-1024": "> 1,024 px",
		unavailable: "Unavailable"
	};
	const counts = new Map<string, number>();
	for (const record of records) {
		const key = maximumDimensionKey(record);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return {
		maximumDimension: dimensionOrder
			.filter((key) => counts.has(key))
			.map((key) => ({
				key,
				label: dimensionLabels[key] ?? key,
				count: counts.get(key) ?? 0
			})),
		textureGroup: stringDistribution(records, (record) => record.textureGroup),
		compression: stringDistribution(records, (record) => record.compression),
		sRGB: stringDistribution(records, (record) => record.sRGB).map((bucket) => ({
			...bucket,
			label: bucket.key === "true" ? "sRGB" : bucket.key === "false" ? "Linear" : bucket.label
		}))
	};
}

function findingOrder(left: TextureAuditFinding, right: TextureAuditFinding): number {
	const severity = { error: 0, warning: 1 } as const;
	return (
		severity[left.severity] - severity[right.severity] ||
		left.ruleId.localeCompare(right.ruleId) ||
		left.objectPath.localeCompare(right.objectPath)
	);
}

function readRuleSet(path: string): Effect.Effect<TextureAuditRuleSet, TextureAuditScanError> {
	return Effect.tryPromise({
		try: () => readFile(path, "utf8"),
		catch: (cause) =>
			new TextureAuditScanError({
				code: "invalid_rules",
				message: `Could not read texture audit rules: ${String(cause)}`,
				recovery: "Choose a readable schema-version-1 JSON rule file.",
				retrySafe: true
			})
	}).pipe(
		Effect.flatMap((json) =>
			Effect.try({
				try: () => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(json)),
				catch: (cause) =>
					new TextureAuditScanError({
						code: "invalid_rules",
						message: `Texture audit rules are invalid: ${String(cause)}`,
						recovery: "Choose a schema-version-1 rule file with supported rule kinds.",
						retrySafe: false
					})
			}).pipe(
				Effect.flatMap((input) =>
					decodeTextureAuditRuleSet(input).pipe(
						Effect.mapError(
							(cause) =>
								new TextureAuditScanError({
									code: "invalid_rules",
									message: `Texture audit rules are invalid: ${String(cause)}`,
									recovery:
										"Choose a schema-version-1 rule file with supported rule kinds.",
									retrySafe: false
								})
						)
					)
				)
			)
		)
	);
}

interface TextureExtractionAccumulator {
	readonly diagnostics: Array<{
		readonly code: string;
		readonly filePath?: string;
		readonly message: string;
	}>;
	failedPackages: number;
	inspectedPackages: number;
	partialPackages: number;
	readonly records: TextureRecord[];
	summary?: Extract<SavedAssetTextureExtractionEvent, { readonly event: "texture_summary" }>;
}

function emptyTextureExtractionAccumulator(): TextureExtractionAccumulator {
	return {
		diagnostics: [],
		failedPackages: 0,
		inspectedPackages: 0,
		partialPackages: 0,
		records: []
	};
}

function foldTextureExtractionEvent(
	projectRoot: string,
	accumulator: TextureExtractionAccumulator,
	event: SavedAssetTextureExtractionEvent
): TextureExtractionAccumulator {
	if (event.event === "texture_record") {
		accumulator.records.push(
			textureRecordFromExtraction({
				filePath: relative(projectRoot, event.path),
				record: event.record
			})
		);
		return accumulator;
	}
	if (event.event === "texture_package") {
		accumulator.inspectedPackages += 1;
		if (event.status === "partial") accumulator.partialPackages += 1;
		for (const diagnostic of event.diagnostics) {
			accumulator.diagnostics.push({
				code: diagnostic.code,
				message: diagnostic.message,
				filePath: relative(projectRoot, event.path)
			});
		}
		return accumulator;
	}
	if (event.event === "error") {
		accumulator.failedPackages += 1;
		accumulator.diagnostics.push({
			code: "package_inspection_failed",
			message: event.message,
			filePath: relative(projectRoot, event.path)
		});
		return accumulator;
	}
	accumulator.summary = event;
	return accumulator;
}

function textureAuditFromExtraction(options: {
	readonly accumulator: TextureExtractionAccumulator;
	readonly discoveredPackages: number;
	readonly rules: TextureAuditRuleSet;
}): TextureAuditReport {
	const records = [...options.accumulator.records].sort((left, right) =>
		left.objectPath.localeCompare(right.objectPath)
	);
	const findings = records
		.flatMap((record) => options.rules.rules.map((rule) => evaluateTextureRule(record, rule)))
		.filter((finding): finding is TextureAuditFinding => finding !== undefined)
		.sort(findingOrder);
	const summary = options.accumulator.summary;
	return {
		schemaVersion: 1,
		status:
			options.accumulator.partialPackages > 0 || options.accumulator.failedPackages > 0
				? "partial"
				: "complete",
		ruleSetName: options.rules.name,
		coverage: {
			discoveredPackages:
				options.discoveredPackages > 0
					? options.discoveredPackages
					: (summary?.scannedAssets ?? options.discoveredPackages),
			inspectedPackages:
				summary === undefined
					? options.accumulator.inspectedPackages
					: summary.emittedAssets + summary.skippedAssets,
			textureAssets: records.length,
			partialPackages: options.accumulator.partialPackages,
			failedPackages: options.accumulator.failedPackages
		},
		records,
		findings,
		distributions: foldTextureDistributions(records),
		diagnostics: options.accumulator.diagnostics.slice(0, 100)
	};
}

function extractTextureAuditWith(
	reader: AssetReaderApi,
	options: {
		readonly concurrency?: number;
		readonly discoveredPackages: number;
		readonly maximumAssets?: number;
		readonly paths?: readonly string[];
		readonly projectRoot: string;
		readonly rules: TextureAuditRuleSet;
	},
	inheritedFailures: readonly {
		readonly code: string;
		readonly filePath?: string;
		readonly message: string;
	}[] = [],
	reportProgress: (progress: ExtractionProgress) => Effect.Effect<void> = () => Effect.void
): Effect.Effect<TextureAuditReport, TextureAuditScanError> {
	if (options.paths?.length === 0) {
		const accumulator = emptyTextureExtractionAccumulator();
		accumulator.failedPackages = inheritedFailures.length;
		accumulator.diagnostics.push(...inheritedFailures);
		return reportProgress({ phase: "ready", processedAssets: 0, totalAssets: 0 }).pipe(
			Effect.as(
				textureAuditFromExtraction({
					accumulator,
					discoveredPackages: options.discoveredPackages,
					rules: options.rules
				})
			)
		);
	}
	const totalAssets = options.paths?.length ?? 0;
	let processedAssets = 0;
	return reportProgress({ phase: "scanning", processedAssets: 0, totalAssets }).pipe(
		Effect.andThen(
			reader
				.extractProjectTextures({
					concurrency: Math.max(1, options.concurrency ?? 8),
					...(options.maximumAssets === undefined
						? undefined
						: { maximumAssets: options.maximumAssets }),
					...(options.paths === undefined ? undefined : { paths: options.paths }),
					projectRoot: options.projectRoot
				})
				.pipe(
					Stream.tap((event) => {
						if (event.event === "texture_summary") {
							processedAssets =
								event.emittedAssets + event.failedAssets + event.skippedAssets;
							return reportProgress({
								phase: "scanning",
								processedAssets,
								totalAssets: totalAssets > 0 ? totalAssets : event.scannedAssets
							});
						}
						if (event.event !== "texture_package" && event.event !== "error")
							return Effect.void;
						processedAssets += 1;
						return reportProgress({
							phase: "scanning",
							processedAssets,
							totalAssets
						});
					}),
					Stream.runFold(
						() => {
							const accumulator = emptyTextureExtractionAccumulator();
							accumulator.failedPackages = inheritedFailures.length;
							accumulator.diagnostics.push(...inheritedFailures);
							return accumulator;
						},
						(current, event) =>
							foldTextureExtractionEvent(options.projectRoot, current, event)
					),
					Effect.map((accumulator) =>
						textureAuditFromExtraction({
							accumulator,
							discoveredPackages: options.discoveredPackages,
							rules: options.rules
						})
					),
					Effect.mapError(textureScanFailure),
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

function scanTextureAuditWith(
	reader: AssetReaderApi,
	options: TextureAuditScanOptions,
	reportProgress: (progress: ExtractionProgress) => Effect.Effect<void>
): Effect.Effect<TextureAuditReport, TextureAuditScanError> {
	return Effect.gen(function* () {
		const rules = yield* readRuleSet(options.ruleFile);
		return yield* extractTextureAuditWith(
			reader,
			{
				discoveredPackages: 0,
				...(options.concurrency === undefined
					? undefined
					: { concurrency: options.concurrency }),
				...(options.maximumAssets === undefined
					? undefined
					: { maximumAssets: options.maximumAssets }),
				projectRoot: options.projectRoot,
				rules
			},
			[],
			reportProgress
		);
	}).pipe(Effect.withSpan("asset-audits.scan-textures"));
}

function scanTextureAuditFromProjectIndexWith(
	reader: AssetReaderApi,
	index: SavedAssetScan,
	options: TextureAuditScanOptions,
	reportProgress: (progress: ExtractionProgress) => Effect.Effect<void>
): Effect.Effect<TextureAuditReport, TextureAuditScanError> {
	return Effect.gen(function* () {
		const rules = yield* readRuleSet(options.ruleFile);
		const paths = texturePackagePathsFromProjectIndex(index);
		return yield* extractTextureAuditWith(
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
				projectRoot: options.projectRoot,
				rules
			},
			index.failures.map((failure) => ({
				code: "package_inspection_failed",
				message: failure.message,
				filePath: relative(options.projectRoot, failure.path)
			})),
			reportProgress
		);
	}).pipe(Effect.withSpan("asset-audits.scan-textures-from-project-index"));
}

export interface TextureAuditApi {
	readonly progress: () => Effect.Effect<ExtractionProgress>;
	readonly scan: (
		options: TextureAuditScanOptions
	) => Effect.Effect<TextureAuditReport, TextureAuditScanError>;
	readonly scanFromProjectIndex: (
		index: SavedAssetScan,
		options: TextureAuditScanOptions
	) => Effect.Effect<TextureAuditReport, TextureAuditScanError>;
}

export class TextureAudit extends Context.Service<TextureAudit, TextureAuditApi>()(
	"@ue-shed/asset-audits/TextureAudit"
) {}

export const TextureAuditLive = Layer.effect(
	TextureAudit,
	Effect.gen(function* () {
		const reader = yield* AssetReader;
		const progressState = yield* Ref.make<ExtractionProgress>({
			phase: "idle",
			processedAssets: 0,
			totalAssets: 0
		});
		const reportProgress = (progress: ExtractionProgress) => Ref.set(progressState, progress);
		const progress = Effect.fn("TextureAudit.progress")(() => Ref.get(progressState));
		const scan = Effect.fn("TextureAudit.scan")(function* (options: TextureAuditScanOptions) {
			const validated = yield* decodeScanOptions(options).pipe(
				Effect.mapError(
					(cause) =>
						new TextureAuditScanError({
							code: "scan_failed",
							message: `Invalid texture audit scan options: ${String(cause)}`,
							recovery:
								"Provide a project root, rule file, and positive scan limits.",
							retrySafe: false
						})
				)
			);
			return yield* scanTextureAuditWith(reader, validated, reportProgress);
		});
		const scanFromProjectIndex = Effect.fn("TextureAudit.scanFromProjectIndex")(function* (
			index: SavedAssetScan,
			options: TextureAuditScanOptions
		) {
			const validated = yield* decodeScanOptions(options).pipe(
				Effect.mapError(
					(cause) =>
						new TextureAuditScanError({
							code: "scan_failed",
							message: `Invalid texture audit scan options: ${String(cause)}`,
							recovery:
								"Provide a project root, rule file, and positive scan limits.",
							retrySafe: false
						})
				)
			);
			return yield* scanTextureAuditFromProjectIndexWith(
				reader,
				index,
				validated,
				reportProgress
			);
		});
		return TextureAudit.of({ progress, scan, scanFromProjectIndex });
	})
);

export type TextureAuditTestApi = Omit<TextureAuditApi, "progress" | "scanFromProjectIndex"> &
	Partial<Pick<TextureAuditApi, "progress" | "scanFromProjectIndex">>;

export function makeTextureAuditTestLayer(service: TextureAuditTestApi): Layer.Layer<TextureAudit> {
	return Layer.succeed(
		TextureAudit,
		TextureAudit.of({
			...service,
			progress:
				service.progress ??
				(() => Effect.succeed({ phase: "idle", processedAssets: 0, totalAssets: 0 })),
			scanFromProjectIndex:
				service.scanFromProjectIndex ?? ((_index, options) => service.scan(options))
		})
	);
}

/** Compatibility accessor until Plans 012–014 compose TextureAudit layers directly. */
export function scanTextureAudit(
	options: TextureAuditScanOptions
): Effect.Effect<TextureAuditReport, TextureAuditScanError, AssetReader> {
	return Effect.flatMap(TextureAudit, (service) => service.scan(options)).pipe(
		Effect.provide(TextureAuditLive)
	);
}
