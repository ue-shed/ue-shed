import {
	makeInputObjectPath,
	type EnhancedInputReport,
	type InputActionRecord,
	type InputInstancedObjectRef,
	type InputMappingContextRecord,
	type InputMappingRecord,
	type PlayerMappableConfigRecord
} from "./schema.js";

export const available = <A>(value: A) =>
	({ status: "available", source: "serialized", value }) as const;
export const notSerialized = { status: "unavailable", reason: "not_serialized" } as const;

export const path = (name: string) => `/Game/Input/${name}.${name}`;

export function action(
	name: string,
	options?: {
		readonly consumeInput?: boolean;
		readonly triggers?: readonly InputInstancedObjectRef[];
	}
): InputActionRecord {
	return {
		objectPath: makeInputObjectPath(path(name)),
		classPath: "/Script/EnhancedInput.InputAction",
		packageFile: `Content/Input/${name}.uasset`,
		actionDescription: available(name),
		valueType: notSerialized,
		consumeInput:
			options?.consumeInput === undefined ? notSerialized : available(options.consumeInput),
		...(options?.triggers === undefined ? undefined : { triggers: options.triggers })
	};
}

export const trigger = (
	className: string,
	parameters: InputInstancedObjectRef["parameters"] = []
): InputInstancedObjectRef => ({
	objectPath: `/Game/Input/Subobject.${className}_0`,
	classPath: `/Script/EnhancedInput.${className}`,
	...(parameters === undefined ? undefined : { parameters })
});

export function mapping(
	actionName: string | null,
	key: string | null,
	triggers: readonly InputInstancedObjectRef[] = []
): InputMappingRecord {
	return {
		action: actionName === null ? null : path(actionName),
		keyName: key === null ? notSerialized : available(key),
		triggers,
		modifiers: []
	};
}

export function context(
	name: string,
	mappings: readonly InputMappingRecord[],
	extra?: Partial<InputMappingContextRecord>
): InputMappingContextRecord {
	return {
		objectPath: makeInputObjectPath(path(name)),
		classPath: "/Script/EnhancedInput.InputMappingContext",
		packageFile: `Content/Input/${name}.uasset`,
		contextDescription: available(name),
		mappingsProperty: "DefaultKeyMappings",
		mappings,
		exports: [],
		...extra
	};
}

export function config(
	name: string,
	contexts: readonly { readonly context: string; readonly priority: number }[]
): PlayerMappableConfigRecord {
	return {
		objectPath: makeInputObjectPath(path(name)),
		classPath: "/Script/EnhancedInput.PlayerMappableInputConfig",
		packageFile: `Content/Input/${name}.uasset`,
		configName: available(name),
		displayName: notSerialized,
		deprecated: notSerialized,
		contexts: available(contexts.map((entry) => ({ ...entry, context: path(entry.context) })))
	};
}

export function report(options: {
	readonly actions: readonly InputActionRecord[];
	readonly contexts: readonly InputMappingContextRecord[];
	readonly configs?: readonly PlayerMappableConfigRecord[];
}): EnhancedInputReport {
	return {
		schemaVersion: 2,
		status: "complete",
		coverage: {
			discoveredPackages: 0,
			inspectedPackages: 0,
			partialPackages: 0,
			failedPackages: 0,
			inputActions: options.actions.length,
			mappingContexts: options.contexts.length,
			playerMappableConfigs: options.configs?.length ?? 0
		},
		actions: options.actions,
		mappingContexts: options.contexts,
		playerMappableConfigs: options.configs ?? [],
		diagnostics: []
	};
}
