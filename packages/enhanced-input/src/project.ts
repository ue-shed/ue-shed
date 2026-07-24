import { relative } from "node:path";
import {
	AssetReader,
	type AssetReaderShape,
	type SavedAssetInspection,
	type SavedProperty,
	type SavedPropertyValue
} from "@ue-shed/unreal-assets";
import { Context, Effect, Layer, Schema } from "effect";
import {
	EnhancedInputPublicError,
	makeInputObjectPath,
	type EnhancedInputDiagnostic,
	type EnhancedInputReport,
	type InputActionRecord,
	type InputInstancedObjectRef,
	type InputMappingContextRecord,
	type InputMappingRecord,
	type InputMappingsProperty
} from "./schema.js";

export const INPUT_ACTION_CLASS = "/Script/EnhancedInput.InputAction";
export const INPUT_MAPPING_CONTEXT_CLASS = "/Script/EnhancedInput.InputMappingContext";

export class EnhancedInputScanError extends Schema.TaggedErrorClass<EnhancedInputScanError>()(
	"EnhancedInputScanError",
	EnhancedInputPublicError.fields
) {}

export const EnhancedInputScanOptions = Schema.Struct({
	concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	maximumAssets: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	projectRoot: Schema.String
});
export type EnhancedInputScanOptions = Schema.Schema.Type<typeof EnhancedInputScanOptions>;

const decodeScanOptions = Schema.decodeUnknownEffect(EnhancedInputScanOptions);

const unavailable = (
	reason: "not_serialized" | "wrong_value_kind" | "not_an_input_action" | "not_a_mapping_context"
) => ({
	status: "unavailable" as const,
	reason
});

function rootProperty(
	properties: readonly SavedProperty[],
	name: string
): SavedProperty | undefined {
	return properties.find((property) => property.name === name);
}

function stringEvidence(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	if (
		property.value_kind !== "string" &&
		property.value_kind !== "name" &&
		property.value_kind !== "enum" &&
		property.value_kind !== "text"
	) {
		return unavailable("wrong_value_kind");
	}
	return {
		status: "available" as const,
		source: "serialized" as const,
		value: property.value
	};
}

function booleanEvidence(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "bool") return unavailable("wrong_value_kind");
	return {
		status: "available" as const,
		source: "serialized" as const,
		value: property.value
	};
}

function objectRefPath(value: SavedPropertyValue): string | null {
	return value.value_kind === "object_ref" ? value.value : null;
}

function instancedRefs(
	values: readonly SavedPropertyValue[],
	exportsByPath: ReadonlyMap<string, string>
): readonly InputInstancedObjectRef[] {
	return values.flatMap((value) => {
		const objectPath = objectRefPath(value);
		if (!objectPath) return [];
		const classPath = exportsByPath.get(objectPath);
		return classPath === undefined ? [{ objectPath }] : [{ objectPath, classPath }];
	});
}

function keyNameEvidence(mapping: SavedPropertyValue) {
	if (mapping.value_kind !== "struct") return unavailable("wrong_value_kind");
	const key = rootProperty(mapping.properties, "Key");
	if (!key) return unavailable("not_serialized");
	if (key.value_kind !== "struct") return unavailable("wrong_value_kind");
	const keyName = rootProperty(key.properties, "KeyName");
	if (!keyName) return unavailable("not_serialized");
	if (keyName.value_kind !== "name" && keyName.value_kind !== "string") {
		return unavailable("wrong_value_kind");
	}
	return {
		status: "available" as const,
		source: "serialized" as const,
		value: keyName.value
	};
}

function projectMapping(
	mapping: SavedPropertyValue,
	exportsByPath: ReadonlyMap<string, string>
): InputMappingRecord | undefined {
	if (mapping.value_kind !== "struct") return undefined;
	const action = rootProperty(mapping.properties, "Action");
	const triggers = rootProperty(mapping.properties, "Triggers");
	const modifiers = rootProperty(mapping.properties, "Modifiers");
	return {
		action: action?.value_kind === "object_ref" ? action.value : null,
		keyName: keyNameEvidence(mapping),
		triggers:
			triggers?.value_kind === "array" ? instancedRefs(triggers.values, exportsByPath) : [],
		modifiers:
			modifiers?.value_kind === "array" ? instancedRefs(modifiers.values, exportsByPath) : []
	};
}

function mappingsFromProperties(
	properties: readonly SavedProperty[],
	exportsByPath: ReadonlyMap<string, string>
): {
	readonly mappingsProperty: InputMappingsProperty | null;
	readonly mappings: readonly InputMappingRecord[];
} {
	const defaultKeyMappings = rootProperty(properties, "DefaultKeyMappings");
	if (defaultKeyMappings?.value_kind === "struct") {
		const nested = rootProperty(defaultKeyMappings.properties, "Mappings");
		if (nested?.value_kind === "array") {
			return {
				mappingsProperty: "DefaultKeyMappings",
				mappings: nested.values.flatMap((value) => {
					const mapping = projectMapping(value, exportsByPath);
					return mapping ? [mapping] : [];
				})
			};
		}
	}

	const legacy = rootProperty(properties, "Mappings");
	if (legacy?.value_kind === "array") {
		return {
			mappingsProperty: "Mappings",
			mappings: legacy.values.flatMap((value) => {
				const mapping = projectMapping(value, exportsByPath);
				return mapping ? [mapping] : [];
			})
		};
	}

	return { mappingsProperty: null, mappings: [] };
}

export function inputActionFromInspection(options: {
	readonly inspection: SavedAssetInspection;
	readonly packageFile: string;
}): InputActionRecord | undefined {
	const asset = options.inspection.assets.find(
		(candidate) => candidate.kind === "UObject" && candidate.class_path === INPUT_ACTION_CLASS
	);
	if (!asset || asset.kind !== "UObject") return undefined;
	return {
		objectPath: makeInputObjectPath(asset.object_path),
		classPath: INPUT_ACTION_CLASS,
		packageFile: options.packageFile,
		actionDescription: stringEvidence(asset.properties, "ActionDescription"),
		valueType: stringEvidence(asset.properties, "ValueType"),
		consumeInput: booleanEvidence(asset.properties, "bConsumeInput")
	};
}

export function mappingContextFromInspection(options: {
	readonly inspection: SavedAssetInspection;
	readonly packageFile: string;
}): InputMappingContextRecord | undefined {
	const context = options.inspection.assets.find(
		(candidate) =>
			candidate.kind === "UObject" && candidate.class_path === INPUT_MAPPING_CONTEXT_CLASS
	);
	if (!context || context.kind !== "UObject") return undefined;
	const exportsByPath = new Map(
		options.inspection.assets.flatMap((asset) =>
			asset.kind === "UObject" ? [[asset.object_path, asset.class_path] as const] : []
		)
	);
	const { mappingsProperty, mappings } = mappingsFromProperties(
		context.properties,
		exportsByPath
	);
	return {
		objectPath: makeInputObjectPath(context.object_path),
		classPath: INPUT_MAPPING_CONTEXT_CLASS,
		packageFile: options.packageFile,
		contextDescription: stringEvidence(context.properties, "ContextDescription"),
		mappingsProperty,
		mappings,
		exports: options.inspection.assets.flatMap((asset) =>
			asset.kind === "UObject" &&
			asset.object_path !== context.object_path &&
			asset.class_path.startsWith("/Script/EnhancedInput.")
				? [{ objectPath: asset.object_path, classPath: asset.class_path }]
				: []
		)
	};
}

export type EnhancedInputPackageOutcome =
	| {
			readonly status: "inspected";
			readonly packageFile: string;
			readonly inspection: SavedAssetInspection;
	  }
	| { readonly status: "failed"; readonly packageFile: string; readonly message: string };

export function buildEnhancedInputReport(
	outcomes: readonly EnhancedInputPackageOutcome[]
): EnhancedInputReport {
	const actions: InputActionRecord[] = [];
	const mappingContexts: InputMappingContextRecord[] = [];
	const diagnostics: EnhancedInputDiagnostic[] = [];

	for (const outcome of outcomes) {
		if (outcome.status === "failed") {
			diagnostics.push({
				code: "package_inspection_failed",
				message: outcome.message,
				packageFile: outcome.packageFile
			});
			continue;
		}
		if (outcome.inspection.status === "partial") {
			diagnostics.push({
				code: "package_partially_decoded",
				message: `${outcome.inspection.decode_errors.length} decode error(s) limit this package's coverage.`,
				packageFile: outcome.packageFile
			});
		}
		const action = inputActionFromInspection(outcome);
		if (action) actions.push(action);
		const mappingContext = mappingContextFromInspection(outcome);
		if (mappingContext) mappingContexts.push(mappingContext);
		const relevant = outcome.inspection.assets.some(
			(asset) =>
				asset.kind === "UObject" &&
				(asset.class_path === INPUT_ACTION_CLASS ||
					asset.class_path === INPUT_MAPPING_CONTEXT_CLASS)
		);
		if (!relevant && outcome.inspection.assets.length > 0) {
			diagnostics.push({
				code: "unsupported_asset",
				message: "Package contains no Enhanced Input action or mapping context export.",
				packageFile: outcome.packageFile
			});
		}
	}

	actions.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
	mappingContexts.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
	const inspected = outcomes.filter((outcome) => outcome.status === "inspected");
	const partialPackages = inspected.filter(
		(outcome) => outcome.inspection.status === "partial"
	).length;
	const failedPackages = outcomes.length - inspected.length;
	return {
		schemaVersion: 1,
		status:
			partialPackages > 0 || failedPackages > 0 || diagnostics.length > 0
				? "partial"
				: "complete",
		coverage: {
			discoveredPackages: outcomes.length,
			inspectedPackages: inspected.length,
			partialPackages,
			failedPackages,
			inputActions: actions.length,
			mappingContexts: mappingContexts.length
		},
		actions,
		mappingContexts,
		diagnostics
	};
}

function scanEnhancedInputWith(
	reader: AssetReaderShape,
	options: EnhancedInputScanOptions
): Effect.Effect<EnhancedInputReport, EnhancedInputScanError> {
	return Effect.gen(function* () {
		const assets = yield* reader.discoverAssets(options.projectRoot).pipe(
			Effect.mapError(
				(error) =>
					new EnhancedInputScanError({
						code: "invalid_project",
						message: error.message,
						recovery: "Choose an Unreal project directory containing a Content folder.",
						retrySafe: true
					})
			)
		);
		const maximumAssets = options.maximumAssets ?? 10_000;
		if (assets.length > maximumAssets) {
			return yield* new EnhancedInputScanError({
				code: "scan_limit_exceeded",
				message: `Scan found ${assets.length} packages, above the limit of ${maximumAssets}.`,
				recovery: "Narrow the project or raise the explicit maximum asset limit.",
				retrySafe: false
			});
		}
		const outcomes = yield* Effect.forEach(
			assets,
			(assetPath) =>
				reader.readAsset(assetPath).pipe(
					Effect.map(
						(inspection): EnhancedInputPackageOutcome => ({
							status: "inspected",
							packageFile: relative(options.projectRoot, assetPath),
							inspection
						})
					),
					Effect.catch((error) =>
						Effect.succeed<EnhancedInputPackageOutcome>({
							status: "failed",
							packageFile: relative(options.projectRoot, assetPath),
							message: error.message
						})
					)
				),
			{ concurrency: Math.max(1, options.concurrency ?? 4) }
		);
		return buildEnhancedInputReport(outcomes);
	}).pipe(Effect.withSpan("enhanced-input.scan"));
}

function inspectEnhancedInputPathWith(
	reader: AssetReaderShape,
	path: string
): Effect.Effect<EnhancedInputReport, EnhancedInputScanError> {
	return Effect.gen(function* () {
		const inspection = yield* reader.readAsset(path).pipe(
			Effect.mapError(
				(error) =>
					new EnhancedInputScanError({
						code: "invalid_path",
						message: error.message,
						recovery: "Provide a readable .uasset path or Unreal project root.",
						retrySafe: true
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

export interface EnhancedInputServiceShape {
	readonly inspectPath: (
		path: string
	) => Effect.Effect<EnhancedInputReport, EnhancedInputScanError>;
	readonly scan: (
		options: EnhancedInputScanOptions
	) => Effect.Effect<EnhancedInputReport, EnhancedInputScanError>;
}

export class EnhancedInputService extends Context.Service<
	EnhancedInputService,
	EnhancedInputServiceShape
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
							message: `Invalid Enhanced Input scan options: ${String(cause)}`,
							recovery: "Provide a project root and positive scan limits.",
							retrySafe: false
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
					retrySafe: false
				});
			}
			return yield* inspectEnhancedInputPathWith(reader, path);
		});
		return EnhancedInputService.of({ inspectPath, scan });
	})
);
