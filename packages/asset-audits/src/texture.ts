import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import {
	discoverSavedAssets,
	readSavedAsset,
	type SavedAssetInspection,
	type SavedProperty
} from "@ue-shed/unreal-assets";
import { Data, Effect, Schema } from "effect";
import {
	AuditRuleId,
	TextureObjectPath,
	decodeTextureAuditRuleSet,
	type DistributionBucket,
	type TextureAuditFinding,
	type TextureAuditPublicError,
	type TextureAuditReport,
	type TextureAuditRule,
	type TextureAuditRuleSet,
	type TextureDistributions,
	type TextureRecord
} from "./schema.js";
import { maximumDimensionKey } from "./report.js";

const decodeTextureObjectPath = Schema.decodeUnknownSync(TextureObjectPath);
const decodeAuditRuleId = Schema.decodeUnknownSync(AuditRuleId);

export class TextureAuditScanError extends Data.TaggedError(
	"TextureAuditScanError"
)<TextureAuditPublicError> {}

export interface ScanTextureAuditOptions {
	readonly projectRoot: string;
	readonly ruleFile: string;
	readonly readerExecutable?: string;
	readonly concurrency?: number;
	readonly maximumAssets?: number;
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

export function findTextureExports(inspection: SavedAssetInspection) {
	type SavedAsset = SavedAssetInspection["assets"][number];
	type UObjectAsset = Extract<SavedAsset, { readonly kind: "UObject" }>;
	return inspection.assets.filter(
		(asset): asset is UObjectAsset =>
			asset.kind === "UObject" && asset.class_path === "/Script/Engine.Texture2D"
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
				objectPath: decodeTextureObjectPath(asset.object_path),
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
			ruleId: decodeAuditRuleId(rule.id),
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
		ruleId: decodeAuditRuleId(rule.id),
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
	const dimensionLabels: Record<string, string> = {
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
				try: () => decodeTextureAuditRuleSet(JSON.parse(json)),
				catch: (cause) =>
					new TextureAuditScanError({
						code: "invalid_rules",
						message: `Texture audit rules are invalid: ${String(cause)}`,
						recovery: "Choose a schema-version-1 rule file with supported rule kinds.",
						retrySafe: false
					})
			})
		)
	);
}

export function scanTextureAudit(
	options: ScanTextureAuditOptions
): Effect.Effect<TextureAuditReport, TextureAuditScanError> {
	return Effect.gen(function* () {
		const rules = yield* readRuleSet(options.ruleFile);
		const assets = yield* discoverSavedAssets(options.projectRoot).pipe(
			Effect.mapError(
				(error) =>
					new TextureAuditScanError({
						code: "invalid_project",
						message: error.message,
						recovery: "Choose an Unreal project directory containing a Content folder.",
						retrySafe: true
					})
			)
		);
		const maximumAssets = options.maximumAssets ?? 10_000;
		if (assets.length > maximumAssets) {
			return yield* new TextureAuditScanError({
				code: "scan_failed",
				message: `Scan found ${assets.length} packages, above the limit of ${maximumAssets}.`,
				recovery: "Narrow the project or raise the explicit maximum asset limit.",
				retrySafe: false
			});
		}
		const outcomes = yield* Effect.forEach(
			assets,
			(assetPath) =>
				Effect.all({
					inspection: readSavedAsset({
						assetPath,
						...(options.readerExecutable
							? { executable: options.readerExecutable }
							: {})
					}),
					file: Effect.tryPromise(() => stat(assetPath))
				}).pipe(
					Effect.map(({ inspection, file }) => ({
						status: "inspected" as const,
						inspection,
						filePath: relative(options.projectRoot, assetPath),
						fileBytes: file.size
					})),
					Effect.catchAll((error) =>
						Effect.succeed({
							status: "failed" as const,
							filePath: relative(options.projectRoot, assetPath),
							message: String(error)
						})
					)
				),
			{ concurrency: Math.max(1, options.concurrency ?? 4) }
		);
		const records = outcomes
			.flatMap((outcome) =>
				outcome.status === "inspected"
					? textureRecordsFromInspection({
							inspection: outcome.inspection,
							filePath: outcome.filePath,
							packageFileBytes: outcome.fileBytes
						})
					: []
			)
			.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
		const diagnostics = outcomes
			.filter((outcome) => outcome.status === "failed")
			.slice(0, 100)
			.map((outcome) => ({
				code: "package_inspection_failed",
				message: outcome.message,
				filePath: outcome.filePath
			}));
		const findings = records
			.flatMap((record) => rules.rules.map((rule) => evaluateTextureRule(record, rule)))
			.filter((finding): finding is TextureAuditFinding => finding !== undefined)
			.sort(findingOrder);
		const partialPackages = outcomes.filter(
			(outcome) => outcome.status === "inspected" && outcome.inspection.status === "partial"
		).length;
		const failedPackages = outcomes.filter((outcome) => outcome.status === "failed").length;
		return {
			schemaVersion: 1 as const,
			status:
				partialPackages > 0 || failedPackages > 0
					? ("partial" as const)
					: ("complete" as const),
			ruleSetName: rules.name,
			coverage: {
				discoveredPackages: assets.length,
				inspectedPackages: outcomes.length - failedPackages,
				textureAssets: records.length,
				partialPackages,
				failedPackages
			},
			records,
			findings,
			distributions: foldTextureDistributions(records),
			diagnostics
		};
	}).pipe(Effect.withSpan("asset-audits.scan-textures"));
}
