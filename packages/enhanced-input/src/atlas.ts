// Derives a key-centred view from the package-centred scan report. Enhanced Input serializes
// bindings per mapping context; a person reading a control scheme wants the inverse — one key,
// every context that claims it. Everything here is derivation over serialized evidence: no
// CDO defaults, no invented priorities.

import type {
	EnhancedInputReport,
	InputMappingContextRecord,
	InputMappingRecord
} from "./schema.js";

export type AtlasDevice = "gamepad" | "keyboard" | "mouse";

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

export function findAtlasKey(atlas: InputAtlas, key: string | null): AtlasKey | undefined {
	return key === null ? undefined : atlas.keys.find((entry) => entry.key === key);
}
