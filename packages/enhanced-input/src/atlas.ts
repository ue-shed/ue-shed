// Derives a key-centred view from the package-centred scan report. Enhanced Input serializes
// bindings per mapping context; a person reading a control scheme wants the inverse — one key,
// every context that claims it. Everything here is derivation over serialized evidence: no
// CDO defaults, no invented priorities.

import type {
	EnhancedInputReport,
	InputInstancedObjectRef,
	InputMappingContextRecord,
	InputMappingRecord,
	InputObjectParameter
} from "./schema.js";

export type AtlasDevice = "gamepad" | "keyboard" | "mouse";

/** A trigger or modifier on a claim, with the saved parameter overrides that make it specific. */
export interface AtlasInstancedDetail {
	readonly label: string;
	readonly objectPath: string;
	readonly classPath: string | null;
	/** `null` when the subobject was not resolved or the report predates schema 2. */
	readonly parameters: readonly InputObjectParameter[] | null;
}

/** One context's claim on a key. A key with more than one claim is contested. */
export interface AtlasClaim {
	readonly contextPath: string;
	readonly contextName: string;
	readonly actionPath: string | null;
	readonly actionName: string | null;
	/** The action's serialized `ActionDescription`, when the asset carried one. */
	readonly actionDescription: string | null;
	readonly triggers: readonly string[];
	readonly modifiers: readonly string[];
	/** The same triggers as `triggers`, in order, with class paths and saved parameters. */
	readonly triggerDetails: readonly AtlasInstancedDetail[];
	readonly modifierDetails: readonly AtlasInstancedDetail[];
}

export interface AtlasKey {
	/** The serialized `FKey` name, which is this key's identity. */
	readonly key: string;
	readonly device: AtlasDevice;
	readonly claims: readonly AtlasClaim[];
	readonly contested: boolean;
}

export interface AtlasContextSummary {
	readonly objectPath: string;
	readonly name: string;
	readonly description: string | null;
	readonly mappings: number;
	/** Mappings whose `Key` never made it into the package, so no key can be drawn for them. */
	readonly unreadableMappings: number;
}

export interface InputAtlas {
	readonly contexts: readonly AtlasContextSummary[];
	readonly keys: readonly AtlasKey[];
	readonly contestedKeys: readonly string[];
	readonly actions: number;
	readonly unreadableMappings: number;
}

/** `/Game/Fixture/Input/IMC_Fixture.IMC_Fixture` → `IMC_Fixture`. */
export function objectName(objectPath: string): string {
	const tail = objectPath.split("/").at(-1) ?? objectPath;
	return tail.split(/[.:]/).at(-1) ?? tail;
}

const ENHANCED_INPUT_PREFIX = "/Script/EnhancedInput.";

/** `InputTriggerChordAction` → `chord action`; unknown or Blueprint classes keep their name. */
function humanizeClass(classPath: string, kind: "InputTrigger" | "InputModifier"): string {
	if (!classPath.startsWith(ENHANCED_INPUT_PREFIX)) return objectName(classPath);
	const name = classPath.slice(ENHANCED_INPUT_PREFIX.length);
	if (!name.startsWith(kind)) return name;
	const remainder = name.slice(kind.length);
	if (remainder.length === 0) return kind.toLowerCase();
	return remainder
		.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.trim();
}

export function triggerLabel(classPath: string): string {
	return humanizeClass(classPath, "InputTrigger");
}

export function modifierLabel(classPath: string): string {
	return humanizeClass(classPath, "InputModifier");
}

export function deviceOf(key: string): AtlasDevice {
	if (key.startsWith("Gamepad_")) return "gamepad";
	if (key.endsWith("MouseButton") || key.startsWith("Mouse")) return "mouse";
	return "keyboard";
}

function instancedDetail(
	reference: InputInstancedObjectRef,
	label: (classPath: string) => string
): AtlasInstancedDetail {
	return {
		label:
			reference.classPath === undefined
				? objectName(reference.objectPath)
				: label(reference.classPath),
		objectPath: reference.objectPath,
		classPath: reference.classPath ?? null,
		parameters: reference.parameters ?? null
	};
}

function numberText(value: number | null): string {
	return value === null ? "non-finite" : String(value);
}

/** `ActuationThreshold 0.3`, `ChordAction IA_Aim`, `Scalar (2, 1, 1)`. */
export function parameterLabel(parameter: InputObjectParameter): string {
	switch (parameter.kind) {
		case "bool":
			return `${parameter.name} ${parameter.value ? "true" : "false"}`;
		case "number":
			return `${parameter.name} ${numberText(parameter.value)}`;
		case "string":
			return `${parameter.name} ${parameter.value}`;
		case "object":
			return `${parameter.name} ${parameter.value === null ? "None" : objectName(parameter.value)}`;
		case "vector":
			return `${parameter.name} (${[parameter.x, parameter.y, parameter.z].map(numberText).join(", ")})`;
		case "unsupported":
			return `${parameter.name} (${parameter.valueKind}, not decoded)`;
	}
}

function claimOf(options: {
	readonly context: InputMappingContextRecord;
	readonly mapping: InputMappingRecord;
	readonly actionNames: ReadonlyMap<string, string | null>;
}): AtlasClaim {
	const actionPath = options.mapping.action;
	return {
		contextPath: options.context.objectPath,
		contextName: objectName(options.context.objectPath),
		actionPath,
		actionName: actionPath === null ? null : objectName(actionPath),
		actionDescription:
			actionPath === null ? null : (options.actionNames.get(actionPath) ?? null),
		triggers: options.mapping.triggers.map((trigger) =>
			trigger.classPath === undefined
				? objectName(trigger.objectPath)
				: triggerLabel(trigger.classPath)
		),
		modifiers: options.mapping.modifiers.map((modifier) =>
			modifier.classPath === undefined
				? objectName(modifier.objectPath)
				: modifierLabel(modifier.classPath)
		),
		triggerDetails: options.mapping.triggers.map((trigger) =>
			instancedDetail(trigger, triggerLabel)
		),
		modifierDetails: options.mapping.modifiers.map((modifier) =>
			instancedDetail(modifier, modifierLabel)
		)
	};
}

/**
 * Inverts a scan report onto its keys. `contexts` narrows the atlas to a subset of mapping
 * contexts by object path, which is how a host answers "what would this key do if only these
 * contexts were applied".
 */
export function buildInputAtlas(
	report: EnhancedInputReport,
	options?: { readonly contexts?: readonly string[] }
): InputAtlas {
	const selected =
		options?.contexts === undefined
			? report.mappingContexts
			: report.mappingContexts.filter((context) =>
					options.contexts?.includes(context.objectPath)
				);
	const actionNames = new Map<string, string | null>(
		report.actions.map((action) => [
			String(action.objectPath),
			action.actionDescription.status === "available" ? action.actionDescription.value : null
		])
	);

	const byKey = new Map<string, AtlasClaim[]>();
	const contexts: AtlasContextSummary[] = [];
	let unreadableMappings = 0;

	for (const context of selected) {
		let unreadable = 0;
		for (const mapping of context.mappings) {
			if (mapping.keyName.status !== "available") {
				unreadable += 1;
				continue;
			}
			const claims = byKey.get(mapping.keyName.value) ?? [];
			claims.push(claimOf({ context, mapping, actionNames }));
			byKey.set(mapping.keyName.value, claims);
		}
		unreadableMappings += unreadable;
		contexts.push({
			objectPath: context.objectPath,
			name: objectName(context.objectPath),
			description:
				context.contextDescription.status === "available"
					? context.contextDescription.value
					: null,
			mappings: context.mappings.length,
			unreadableMappings: unreadable
		});
	}

	const keys: AtlasKey[] = [...byKey.entries()]
		.map(([key, claims]) => ({
			key,
			device: deviceOf(key),
			claims,
			// Two mappings inside one context are a deliberate alternative, not a conflict; only
			// claims from different contexts contest a key.
			contested: new Set(claims.map((claim) => claim.contextPath)).size > 1
		}))
		.sort((left, right) => left.key.localeCompare(right.key));

	return {
		contexts: contexts.sort((left, right) => left.name.localeCompare(right.name)),
		keys,
		contestedKeys: keys.filter((entry) => entry.contested).map((entry) => entry.key),
		actions: report.actions.length,
		unreadableMappings
	};
}

/**
 * An action-to-action edge a trigger saves: a chord names the action that must also be active, a
 * combo names its steps. `from` is the action the trigger guards; `to` is the saved reference.
 */
export interface InputActionEdge {
	readonly from: string;
	readonly to: string;
	readonly triggerClass: string | null;
	readonly parameter: string;
	/** The mapping context and key when the trigger is on a mapping; null for an action trigger. */
	readonly contextPath: string | null;
	readonly key: string | null;
}

/** `ComboActions[0].ComboStepAction` → `ComboStepAction`. */
function leafName(parameter: string): string {
	return (
		parameter
			.split(".")
			.at(-1)
			?.replace(/\[\d+\]$/, "") ?? parameter
	);
}

function edgesOf(
	from: string,
	triggers: readonly InputInstancedObjectRef[],
	actions: ReadonlySet<string>,
	where: { readonly contextPath: string | null; readonly key: string | null }
): InputActionEdge[] {
	return triggers.flatMap((trigger) =>
		(trigger.parameters ?? []).flatMap((parameter) =>
			parameter.kind === "object" &&
			parameter.value !== null &&
			// A reference to a scanned action, or a trigger property named for an action, which
			// keeps an edge to an action outside the scanned roots.
			(actions.has(parameter.value) || leafName(parameter.name).endsWith("Action"))
				? [
						{
							from,
							to: parameter.value,
							triggerClass: trigger.classPath ?? null,
							parameter: parameter.name,
							...where
						}
					]
				: []
		)
	);
}

/** Every action-to-action edge saved in trigger parameters, on mappings and on actions. */
export function inputActionEdges(report: EnhancedInputReport): readonly InputActionEdge[] {
	const actions = new Set(report.actions.map((action) => String(action.objectPath)));
	const edges: InputActionEdge[] = [];
	for (const action of report.actions) {
		edges.push(
			...edgesOf(action.objectPath, action.triggers ?? [], actions, {
				contextPath: null,
				key: null
			})
		);
	}
	for (const context of report.mappingContexts) {
		for (const mapping of context.mappings) {
			if (mapping.action === null) continue;
			edges.push(
				...edgesOf(mapping.action, mapping.triggers, actions, {
					contextPath: context.objectPath,
					key: mapping.keyName.status === "available" ? mapping.keyName.value : null
				})
			);
		}
	}
	return edges;
}

export function findAtlasKey(atlas: InputAtlas, key: string | null): AtlasKey | undefined {
	return key === null ? undefined : atlas.keys.find((entry) => entry.key === key);
}
