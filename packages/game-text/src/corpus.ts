import { relative } from "node:path";
import {
	discoverSavedAssets,
	readSavedAsset,
	type SavedAssetInspection,
	type SavedProperty,
	type SavedPropertyValue
} from "@ue-shed/unreal-assets";
import { Data, Effect, Schema } from "effect";
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

const decodeOccurrenceId = Schema.decodeUnknownSync(TextOccurrenceId);
const decodeUnitId = Schema.decodeUnknownSync(TextUnitId);

export class TextCorpusScanError extends Data.TaggedError("TextCorpusScanError")<{
	readonly code: "invalid_project" | "scan_limit_exceeded";
	readonly message: string;
	readonly recovery: string;
	readonly retrySafe: boolean;
}> {}

export interface ScanTextCorpusOptions {
	readonly projectRoot: string;
	readonly readerExecutable?: string;
	readonly concurrency?: number;
	readonly maximumAssets?: number;
}

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
		id: decodeOccurrenceId(occurrenceId(options.packageFile, options.location)),
		packageFile: options.packageFile,
		source: options.value.value,
		identity: identityForText(options.value),
		location: options.location,
		editCapability: options.editCapability
	});
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
		if (asset.kind === "UObject") visit(asset.object_path, asset.properties, "");
		if (asset.kind === "DataTable" || asset.kind === "CompositeDataTable") {
			for (const row of asset.rows)
				visit(asset.object_path, row.properties, `row:${row.name}`);
		}
	}
	return gaps;
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
		if (asset.kind === "UObject") {
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

function unitKey(occurrence: TextOccurrence): string {
	return occurrence.identity.status === "resolved"
		? `unreal:${encodeURIComponent(occurrence.identity.namespace)}:${encodeURIComponent(occurrence.identity.key)}`
		: occurrence.id;
}

export function buildTextCorpus(outcomes: readonly TextPackageOutcome[]): TextCorpus {
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
				id: decodeUnitId(id),
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
			discoveredPackages: outcomes.length,
			inspectedPackages: inspected.length,
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

export function scanTextCorpus(
	options: ScanTextCorpusOptions
): Effect.Effect<TextCorpus, TextCorpusScanError> {
	return Effect.gen(function* () {
		const assets = yield* discoverSavedAssets(options.projectRoot).pipe(
			Effect.mapError(
				(error) =>
					new TextCorpusScanError({
						code: "invalid_project",
						message: error.message,
						recovery: "Choose an Unreal project directory containing a Content folder.",
						retrySafe: true
					})
			)
		);
		const maximumAssets = options.maximumAssets ?? 10_000;
		if (assets.length > maximumAssets) {
			return yield* new TextCorpusScanError({
				code: "scan_limit_exceeded",
				message: `Scan found ${assets.length} packages, above the limit of ${maximumAssets}.`,
				recovery: "Narrow the project or raise the explicit maximum asset limit.",
				retrySafe: false
			});
		}
		const outcomes = yield* Effect.forEach(
			assets,
			(assetPath) =>
				readSavedAsset({
					assetPath,
					...(options.readerExecutable ? { executable: options.readerExecutable } : {})
				}).pipe(
					Effect.map(
						(inspection): TextPackageOutcome => ({
							status: "inspected",
							packageFile: relative(options.projectRoot, assetPath),
							inspection
						})
					),
					Effect.catchAll((error) =>
						Effect.succeed<TextPackageOutcome>({
							status: "failed",
							packageFile: relative(options.projectRoot, assetPath),
							message: error.message
						})
					)
				),
			{ concurrency: Math.max(1, options.concurrency ?? 4) }
		);
		return buildTextCorpus(outcomes);
	}).pipe(Effect.withSpan("game-text.scan-corpus"));
}
