// Pure projections from one decoded saved package onto Enhanced Input records. Each projector is
// exported on its own so a host can run, replace or skip any of them. A value the package did not
// serialize stays `unavailable`; nothing here substitutes an engine class default. Every property
// is optional, because property names differ between engine releases.

import type {
	SavedAssetInspection,
	SavedProperty,
	SavedPropertyValue
} from "@ue-shed/unreal-assets";
import {
	ENHANCED_INPUT_REPORT_SCHEMA_VERSION,
	makeInputObjectPath,
	type EnhancedInputDiagnostic,
	type EnhancedInputReport,
	type EvidenceUnavailableReason,
	type InputActionRecord,
	type InputInstancedObjectRef,
	type InputMappingContextRecord,
	type InputMappingProfileOverride,
	type InputMappingRecord,
	type InputModeQuery,
	type InputObjectParameter,
	type PlayerMappableConfigContext,
	type PlayerMappableConfigRecord,
	type PlayerMappableKeySettingsRecord
} from "./schema.js";

export const ENHANCED_INPUT_CLASS_PREFIX = "/Script/EnhancedInput.";
export const INPUT_ACTION_CLASS = `${ENHANCED_INPUT_CLASS_PREFIX}InputAction`;
export const INPUT_MAPPING_CONTEXT_CLASS = `${ENHANCED_INPUT_CLASS_PREFIX}InputMappingContext`;
export const PLAYER_MAPPABLE_INPUT_CONFIG_CLASS = `${ENHANCED_INPUT_CLASS_PREFIX}PlayerMappableInputConfig`;
export const ENHANCED_INPUT_CLASS_NAME_SUFFIXES = [
	"InputAction",
	"InputMappingContext",
	"PlayerMappableInputConfig"
] as const;

function className(classPath: string): string | undefined {
	const separator = classPath.lastIndexOf(".");
	return separator === -1 ? undefined : classPath.slice(separator + 1);
}

/**
 * Saved package headers record a concrete class, not its Unreal inheritance chain. The suffix
 * convention admits native subclasses such as `M_InputMappingContext` while preserving their
 * serialized class path in the projected record.
 */
export function isInputActionClass(classPath: string): boolean {
	return (
		classPath === INPUT_ACTION_CLASS || className(classPath)?.endsWith("InputAction") === true
	);
}

export function isInputMappingContextClass(classPath: string): boolean {
	return (
		classPath === INPUT_MAPPING_CONTEXT_CLASS ||
		className(classPath)?.endsWith("InputMappingContext") === true
	);
}

export function isPlayerMappableInputConfigClass(classPath: string): boolean {
	return (
		classPath === PLAYER_MAPPABLE_INPUT_CONFIG_CLASS ||
		className(classPath)?.endsWith("PlayerMappableInputConfig") === true
	);
}

/** True for any class one of this package's projectors accepts. */
export function isEnhancedInputAssetClass(classPath: string): boolean {
	return (
		isInputActionClass(classPath) ||
		isInputMappingContextClass(classPath) ||
		isPlayerMappableInputConfigClass(classPath)
	);
}

const unavailable = (reason: EvidenceUnavailableReason) => ({
	status: "unavailable" as const,
	reason
});

const available = <A>(value: A) => ({
	status: "available" as const,
	source: "serialized" as const,
	value
});

type SavedObject = Extract<SavedAssetInspection["assets"][number], { readonly kind: "UObject" }>;
type ExportsByPath = ReadonlyMap<string, SavedObject>;

function exportsOf(inspection: SavedAssetInspection): ExportsByPath {
	return new Map(
		inspection.assets.flatMap((asset) =>
			asset.kind === "UObject" ? [[asset.object_path, asset] as const] : []
		)
	);
}

function rootProperty(
	properties: readonly SavedProperty[],
	name: string
): SavedProperty | undefined {
	return properties.find((property) => property.name === name);
}

function textValue(value: SavedPropertyValue): string | undefined {
	switch (value.value_kind) {
		case "string":
		case "name":
		case "enum":
		case "text":
			return value.value;
		default:
			return undefined;
	}
}

function stringEvidence(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	const value = textValue(property);
	return value === undefined ? unavailable("wrong_value_kind") : available(value);
}

function booleanEvidence(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "bool") return unavailable("wrong_value_kind");
	return available(property.value);
}

function integerEvidence(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "int" && property.value_kind !== "uint") {
		return unavailable("wrong_value_kind");
	}
	return available(property.value);
}

function objectRefPath(value: SavedPropertyValue): string | null {
	return value.value_kind === "object_ref" ? value.value : null;
}

/** Parameters stay bounded: a subobject saves a handful of overrides, never thousands. */
const MAXIMUM_PARAMETERS = 64;
const MAXIMUM_PARAMETER_DEPTH = 4;

function flattenValue(
	name: string,
	value: SavedPropertyValue,
	depth: number,
	into: InputObjectParameter[]
): void {
	if (into.length >= MAXIMUM_PARAMETERS) return;
	switch (value.value_kind) {
		case "bool":
			into.push({ name, kind: "bool", value: value.value });
			return;
		case "int":
		case "uint":
		case "float":
		case "double":
			into.push({ name, kind: "number", value: value.value });
			return;
		case "name":
		case "enum":
		case "string":
		case "guid":
		case "text":
			into.push({ name, kind: "string", value: value.value });
			return;
		case "object_ref":
		case "soft_object_path":
			into.push({ name, kind: "object", value: value.value });
			return;
		case "vector":
			into.push({ name, kind: "vector", x: value.x, y: value.y, z: value.z });
			return;
		case "struct":
			if (depth >= MAXIMUM_PARAMETER_DEPTH) break;
			for (const child of value.properties) {
				flattenValue(`${name}.${child.name}`, child, depth + 1, into);
			}
			return;
		case "native_struct":
			if (depth >= MAXIMUM_PARAMETER_DEPTH) break;
			for (const field of value.fields) {
				flattenValue(`${name}.${field.name}`, field.value, depth + 1, into);
			}
			return;
		case "array":
		case "set":
			if (depth >= MAXIMUM_PARAMETER_DEPTH) break;
			value.values.forEach((child, index) =>
				flattenValue(`${name}[${index}]`, child, depth + 1, into)
			);
			return;
		default:
			break;
	}
	into.push({ name, kind: "unsupported", valueKind: value.value_kind });
}

/** Flattens a subobject's saved properties. Exported so hosts can reuse it on their own exports. */
export function inputObjectParameters(
	properties: readonly SavedProperty[]
): readonly InputObjectParameter[] {
	const parameters: InputObjectParameter[] = [];
	for (const property of properties) flattenValue(property.name, property, 0, parameters);
	return parameters;
}

function instancedRefs(
	values: readonly SavedPropertyValue[],
	exportsByPath: ExportsByPath
): readonly InputInstancedObjectRef[] {
	return values.flatMap((value) => {
		const objectPath = objectRefPath(value);
		if (!objectPath) return [];
		const exported = exportsByPath.get(objectPath);
		return exported === undefined
			? [{ objectPath }]
			: [
					{
						objectPath,
						classPath: exported.class_path,
						parameters: inputObjectParameters(exported.properties)
					}
				];
	});
}

function instancedArray(
	properties: readonly SavedProperty[],
	name: string,
	exportsByPath: ExportsByPath
): readonly InputInstancedObjectRef[] {
	const property = rootProperty(properties, name);
	return property?.value_kind === "array" ? instancedRefs(property.values, exportsByPath) : [];
}

function stringArrayEvidence(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "array") return unavailable("wrong_value_kind");
	const values = property.values.flatMap((value) => {
		const text = textValue(value);
		return text === undefined ? [] : [text];
	});
	return values.length === property.values.length
		? available(values)
		: unavailable("wrong_value_kind");
}

/**
 * Projects the instanced `PlayerMappableKeySettings` subobject a property points to. Settings
 * live as exports of the owning package; a reference outside it is `unresolved_reference`.
 */
export function playerMappableKeySettingsEvidence(
	properties: readonly SavedProperty[],
	exportsByPath: ReadonlyMap<string, SavedObject>
) {
	const property = rootProperty(properties, "PlayerMappableKeySettings");
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "object_ref") return unavailable("wrong_value_kind");
	if (property.value === null) return unavailable("not_serialized");
	const settings = exportsByPath.get(property.value);
	if (!settings) return unavailable("unresolved_reference");
	const record: PlayerMappableKeySettingsRecord = {
		objectPath: settings.object_path,
		classPath: settings.class_path,
		name: stringEvidence(settings.properties, "Name"),
		displayName: stringEvidence(settings.properties, "DisplayName"),
		displayCategory: stringEvidence(settings.properties, "DisplayCategory"),
		supportedKeyProfileIds: stringArrayEvidence(settings.properties, "SupportedKeyProfileIds")
	};
	return available(record);
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
	return available(keyName.value);
}

function projectMapping(
	mapping: SavedPropertyValue,
	exportsByPath: ExportsByPath
): InputMappingRecord | undefined {
	if (mapping.value_kind !== "struct") return undefined;
	const action = rootProperty(mapping.properties, "Action");
	return {
		action: action?.value_kind === "object_ref" ? action.value : null,
		keyName: keyNameEvidence(mapping),
		triggers: instancedArray(mapping.properties, "Triggers", exportsByPath),
		modifiers: instancedArray(mapping.properties, "Modifiers", exportsByPath),
		settingBehavior: stringEvidence(mapping.properties, "SettingBehavior"),
		playerMappableKeySettings: playerMappableKeySettingsEvidence(
			mapping.properties,
			exportsByPath
		)
	};
}

function projectMappings(
	values: readonly SavedPropertyValue[],
	exportsByPath: ExportsByPath
): readonly InputMappingRecord[] {
	return values.flatMap((value) => {
		const mapping = projectMapping(value, exportsByPath);
		return mapping ? [mapping] : [];
	});
}

/** `FInputMappingContextMappingData` keeps its mappings in a nested `Mappings` array. */
function mappingDataMappings(
	value: SavedPropertyValue,
	exportsByPath: ExportsByPath
): readonly InputMappingRecord[] | undefined {
	if (value.value_kind !== "struct") return undefined;
	const nested = rootProperty(value.properties, "Mappings");
	return nested?.value_kind === "array"
		? projectMappings(nested.values, exportsByPath)
		: undefined;
}

function mappingsFromProperties(
	properties: readonly SavedProperty[],
	exportsByPath: ExportsByPath
) {
	const defaultKeyMappings = rootProperty(properties, "DefaultKeyMappings");
	if (defaultKeyMappings) {
		const mappings = mappingDataMappings(defaultKeyMappings, exportsByPath);
		if (mappings) return { mappingsProperty: "DefaultKeyMappings" as const, mappings };
	}

	const legacy = rootProperty(properties, "Mappings");
	if (legacy?.value_kind === "array") {
		return {
			mappingsProperty: "Mappings" as const,
			mappings: projectMappings(legacy.values, exportsByPath)
		};
	}

	return { mappingsProperty: null, mappings: [] };
}

function profileOverrides(
	properties: readonly SavedProperty[],
	exportsByPath: ExportsByPath
): readonly InputMappingProfileOverride[] {
	const overrides = rootProperty(properties, "MappingProfileOverrides");
	if (overrides?.value_kind !== "map") return [];
	return overrides.entries
		.flatMap((entry) => {
			const profileId = textValue(entry.key);
			const mappings = mappingDataMappings(entry.value, exportsByPath);
			return profileId === undefined || mappings === undefined
				? []
				: [{ profileId, mappings }];
		})
		.sort((left, right) => left.profileId.localeCompare(right.profileId));
}

function collectTagNames(value: SavedPropertyValue, into: Set<string>): void {
	switch (value.value_kind) {
		case "struct":
			for (const child of value.properties) {
				if (
					child.name === "TagName" &&
					(child.value_kind === "name" || child.value_kind === "string")
				) {
					into.add(child.value);
				} else collectTagNames(child, into);
			}
			return;
		case "native_struct":
			for (const field of value.fields) {
				if (
					field.name === "TagName" &&
					(field.value.value_kind === "name" || field.value.value_kind === "string")
				) {
					into.add(field.value.value);
				} else collectTagNames(field.value, into);
			}
			return;
		case "array":
		case "set":
			for (const child of value.values) collectTagNames(child, into);
			return;
		default:
			return;
	}
}

function inputModeQueryEvidence(properties: readonly SavedProperty[], name: string) {
	const property = rootProperty(properties, name);
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "struct" && property.value_kind !== "native_struct") {
		return unavailable("wrong_value_kind");
	}
	const tags = new Set<string>();
	collectTagNames(property, tags);
	const fields: readonly { readonly name: string; readonly value: SavedPropertyValue }[] =
		property.value_kind === "struct"
			? property.properties.map((child) => ({ name: child.name, value: child }))
			: property.fields;
	const description = (field: string) => {
		const value = fields.find((candidate) => candidate.name === field)?.value;
		const text = value === undefined ? undefined : textValue(value);
		return text === undefined || text.length === 0 ? undefined : text;
	};
	const userDescription = description("UserDescription");
	const autoDescription = description("AutoDescription");
	const query: InputModeQuery = {
		tags: [...tags].sort((left, right) => left.localeCompare(right)),
		...(userDescription === undefined ? undefined : { userDescription }),
		...(autoDescription === undefined ? undefined : { autoDescription })
	};
	return available(query);
}

export function inputActionFromInspection(options: {
	readonly inspection: SavedAssetInspection;
	readonly packageFile: string;
}): InputActionRecord | undefined {
	const asset = options.inspection.assets.find(
		(candidate) => candidate.kind === "UObject" && isInputActionClass(candidate.class_path)
	);
	if (!asset || asset.kind !== "UObject") return undefined;
	const exportsByPath = exportsOf(options.inspection);
	const properties = asset.properties;
	return {
		objectPath: makeInputObjectPath(asset.object_path),
		classPath: asset.class_path,
		packageFile: options.packageFile,
		actionDescription: stringEvidence(properties, "ActionDescription"),
		valueType: stringEvidence(properties, "ValueType"),
		consumeInput: booleanEvidence(properties, "bConsumeInput"),
		triggerWhenPaused: booleanEvidence(properties, "bTriggerWhenPaused"),
		consumesActionAndAxisMappings: booleanEvidence(
			properties,
			"bConsumesActionAndAxisMappings"
		),
		reserveAllMappings: booleanEvidence(properties, "bReserveAllMappings"),
		triggerEventsThatConsumeLegacyKeys: integerEvidence(
			properties,
			"TriggerEventsThatConsumeLegacyKeys"
		),
		accumulationBehavior: stringEvidence(properties, "AccumulationBehavior"),
		triggers: instancedArray(properties, "Triggers", exportsByPath),
		modifiers: instancedArray(properties, "Modifiers", exportsByPath),
		playerMappableKeySettings: playerMappableKeySettingsEvidence(properties, exportsByPath)
	};
}

export function mappingContextFromInspection(options: {
	readonly inspection: SavedAssetInspection;
	readonly packageFile: string;
}): InputMappingContextRecord | undefined {
	const context = options.inspection.assets.find(
		(candidate) =>
			candidate.kind === "UObject" && isInputMappingContextClass(candidate.class_path)
	);
	if (!context || context.kind !== "UObject") return undefined;
	const exportsByPath = exportsOf(options.inspection);
	const { mappingsProperty, mappings } = mappingsFromProperties(
		context.properties,
		exportsByPath
	);
	return {
		objectPath: makeInputObjectPath(context.object_path),
		classPath: context.class_path,
		packageFile: options.packageFile,
		contextDescription: stringEvidence(context.properties, "ContextDescription"),
		mappingsProperty,
		mappings,
		exports: options.inspection.assets.flatMap((asset) =>
			asset.kind === "UObject" &&
			asset.object_path !== context.object_path &&
			asset.class_path.startsWith(ENHANCED_INPUT_CLASS_PREFIX)
				? [{ objectPath: asset.object_path, classPath: asset.class_path }]
				: []
		),
		profileOverrides: profileOverrides(context.properties, exportsByPath),
		inputModeFilterOptions: stringEvidence(context.properties, "InputModeFilterOptions"),
		inputModeQueryOverride: inputModeQueryEvidence(
			context.properties,
			"InputModeQueryOverride"
		),
		registrationTrackingMode: stringEvidence(context.properties, "RegistrationTrackingMode")
	};
}

function configContextsEvidence(properties: readonly SavedProperty[]) {
	const property = rootProperty(properties, "Contexts");
	if (!property) return unavailable("not_serialized");
	if (property.value_kind !== "map") return unavailable("wrong_value_kind");
	const contexts: PlayerMappableConfigContext[] = [];
	for (const entry of property.entries) {
		if (entry.key.value_kind !== "object_ref") return unavailable("wrong_value_kind");
		if (entry.value.value_kind !== "int" && entry.value.value_kind !== "uint") {
			return unavailable("wrong_value_kind");
		}
		contexts.push({ context: entry.key.value, priority: entry.value.value });
	}
	return available(contexts);
}

/** Projects a `PlayerMappableInputConfig` asset: its name, flags and context priorities. */
export function playerMappableConfigFromInspection(options: {
	readonly inspection: SavedAssetInspection;
	readonly packageFile: string;
}): PlayerMappableConfigRecord | undefined {
	const config = options.inspection.assets.find(
		(candidate) =>
			candidate.kind === "UObject" && isPlayerMappableInputConfigClass(candidate.class_path)
	);
	if (!config || config.kind !== "UObject") return undefined;
	return {
		objectPath: makeInputObjectPath(config.object_path),
		classPath: config.class_path,
		packageFile: options.packageFile,
		configName: stringEvidence(config.properties, "ConfigName"),
		displayName: stringEvidence(config.properties, "ConfigDisplayName"),
		deprecated: booleanEvidence(config.properties, "bIsDeprecated"),
		contexts: configContextsEvidence(config.properties)
	};
}

export type EnhancedInputPackageOutcome =
	| {
			readonly status: "inspected";
			readonly packageFile: string;
			readonly inspection: SavedAssetInspection;
	  }
	| { readonly status: "failed"; readonly packageFile: string; readonly message: string };

/**
 * Package counts from a batched scan. A filtered scan never reports packages the reader ruled out
 * from their headers, so discovered and inspected cannot be derived from `outcomes` alone.
 */
export interface EnhancedInputPackageCounts {
	readonly discoveredPackages: number;
	readonly inspectedPackages: number;
}

export function buildEnhancedInputReport(
	outcomes: readonly EnhancedInputPackageOutcome[],
	counts?: EnhancedInputPackageCounts
): EnhancedInputReport {
	const actions: InputActionRecord[] = [];
	const mappingContexts: InputMappingContextRecord[] = [];
	const playerMappableConfigs: PlayerMappableConfigRecord[] = [];
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
		const config = playerMappableConfigFromInspection(outcome);
		if (config) playerMappableConfigs.push(config);
		const relevant = outcome.inspection.assets.some(
			(asset) => asset.kind === "UObject" && isEnhancedInputAssetClass(asset.class_path)
		);
		if (!relevant && outcome.inspection.assets.length > 0) {
			diagnostics.push({
				code: "unsupported_asset",
				message:
					"Package contains no Enhanced Input action, mapping context or player mappable config export.",
				packageFile: outcome.packageFile
			});
		}
	}

	actions.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
	mappingContexts.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
	playerMappableConfigs.sort((left, right) => left.objectPath.localeCompare(right.objectPath));
	const inspected = outcomes.filter((outcome) => outcome.status === "inspected");
	const partialPackages = inspected.filter(
		(outcome) => outcome.inspection.status === "partial"
	).length;
	const failedPackages = outcomes.length - inspected.length;
	return {
		schemaVersion: ENHANCED_INPUT_REPORT_SCHEMA_VERSION,
		status:
			partialPackages > 0 || failedPackages > 0 || diagnostics.length > 0
				? "partial"
				: "complete",
		coverage: {
			discoveredPackages: counts?.discoveredPackages ?? outcomes.length,
			inspectedPackages: counts?.inspectedPackages ?? inspected.length,
			partialPackages,
			failedPackages,
			inputActions: actions.length,
			mappingContexts: mappingContexts.length,
			playerMappableConfigs: playerMappableConfigs.length
		},
		actions,
		mappingContexts,
		playerMappableConfigs,
		diagnostics
	};
}
