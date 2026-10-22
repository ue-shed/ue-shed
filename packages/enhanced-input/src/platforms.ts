// Per-platform and per-device views. Three sources, each separately usable: platform data classes
// whose context redirects swap one mapping context for another, key-profile overrides saved on a
// context, and per-action device coverage against host-chosen device sets.

import type { SavedAssetInspection } from "@ue-shed/unreal-assets";
import { Schema } from "effect";
import { deviceOf, objectName, type AtlasDevice } from "./atlas.js";
import { contextIdentity, type CoActivationSet } from "./coactivation.js";
import type { EnhancedInputReport, InputMappingContextRecord } from "./schema.js";

/** One `MappingContextRedirects` entry of a platform data class. */
export const InputContextRedirect = Schema.Struct({
	from: Schema.String,
	to: Schema.String,
	/** The platform data class that saved the redirect. */
	inputData: Schema.String
});
export type InputContextRedirect = Schema.Schema.Type<typeof InputContextRedirect>;

/**
 * One platform's Enhanced Input view: the platform data classes its config lists and the context
 * redirects they save. `partial` keeps what was read when a class could not be decoded.
 */
export const InputPlatformView = Schema.Struct({
	platform: Schema.String,
	status: Schema.Literals(["resolved", "partial", "unavailable"]),
	inputData: Schema.Array(Schema.String),
	redirects: Schema.Array(InputContextRedirect),
	diagnostics: Schema.Array(Schema.String)
});
export type InputPlatformView = Schema.Schema.Type<typeof InputPlatformView>;

/**
 * Reads `MappingContextRedirects` from the class default object a platform data Blueprint saves.
 * Only saved entries appear; a class that redirects nothing yields none.
 */
export function platformDataRedirectsFromInspection(
	inspection: SavedAssetInspection,
	inputData: string
): readonly InputContextRedirect[] {
	return inspection.assets.flatMap((asset) => {
		if (asset.kind !== "UObject") return [];
		if (!(asset.object_path.split(/[.:]/).at(-1) ?? "").startsWith("Default__")) return [];
		const redirects = asset.properties.find(
			(property) => property.name === "MappingContextRedirects"
		);
		if (redirects?.value_kind !== "map") return [];
		return redirects.entries.flatMap((entry) =>
			entry.key.value_kind === "object_ref" &&
			entry.key.value !== null &&
			entry.value.value_kind === "object_ref" &&
			entry.value.value !== null
				? [{ from: entry.key.value, to: entry.value.value, inputData }]
				: []
		);
	});
}

/** Parses the config values of `InputData`, a list of soft class paths. */
export function parsePlatformInputData(values: readonly string[]): readonly string[] {
	return values.flatMap((value) => {
		const trimmed = value.trim().replace(/^"|"$/g, "");
		const quoted = /^[^']*'([^']*)'$/.exec(trimmed);
		const path = quoted?.[1] ?? trimmed;
		return path.length === 0 || path === "None" ? [] : [path];
	});
}

/** The config section a platform's `UEnhancedInputPlatformSettings` object reads, per object. */
export function platformSettingsSection(platform: string): string {
	return `EnhancedInputPlatformSettings_${platform} EnhancedInputPlatformSettings`;
}

/** Applies redirects to a list of contexts the way the subsystem does when it adds them. */
export function redirectContexts(
	contexts: readonly string[],
	redirects: readonly InputContextRedirect[]
): readonly string[] {
	const byIdentity = new Map(
		redirects.map((redirect) => [contextIdentity(redirect.from), redirect.to])
	);
	return [
		...new Set(contexts.map((context) => byIdentity.get(contextIdentity(context)) ?? context))
	];
}

/** Rewrites each set's members through the platform's redirects, keeping their priorities. */
export function redirectCoActivationSets(
	sets: readonly CoActivationSet[],
	redirects: readonly InputContextRedirect[]
): readonly CoActivationSet[] {
	if (redirects.length === 0) return sets;
	const byIdentity = new Map(
		redirects.map((redirect) => [contextIdentity(redirect.from), redirect.to])
	);
	return sets.map((set) => ({
		...set,
		contexts: set.contexts.map((member) => ({
			...member,
			context: byIdentity.get(contextIdentity(member.context)) ?? member.context
		}))
	}));
}

/**
 * The report's context paths as a platform sees them: a redirected context is replaced by its
 * target when the target was scanned, and dropped from view otherwise.
 */
export function platformContextPaths(
	report: EnhancedInputReport,
	redirects: readonly InputContextRedirect[]
): readonly string[] {
	const scanned = new Map(
		report.mappingContexts.map((context) => [
			contextIdentity(context.objectPath),
			context.objectPath
		])
	);
	return redirectContexts(
		report.mappingContexts.map((context) => context.objectPath),
		redirects
	).flatMap((context) => {
		const path = scanned.get(contextIdentity(context));
		return path === undefined ? [] : [path];
	});
}

/** Key profiles any context saves overrides for. */
export function inputKeyProfiles(report: EnhancedInputReport): readonly string[] {
	return [
		...new Set(
			report.mappingContexts.flatMap((context) =>
				(context.profileOverrides ?? []).map((entry) => entry.profileId)
			)
		)
	].sort((left, right) => left.localeCompare(right));
}

/**
 * The report as a key profile sees it: each context with an override for the profile uses those
 * mappings instead of its defaults, as `UInputMappingContext::GetMappingsForProfile` does.
 */
export function reportForKeyProfile(
	report: EnhancedInputReport,
	profileId: string
): EnhancedInputReport {
	return {
		...report,
		mappingContexts: report.mappingContexts.map((context): InputMappingContextRecord => {
			const override = context.profileOverrides?.find(
				(entry) => entry.profileId === profileId
			);
			return override === undefined ? context : { ...context, mappings: override.mappings };
		})
	};
}

/** A host-chosen group of devices, such as keyboard and mouse together. */
export interface InputDeviceSet {
	readonly id: string;
	readonly label: string;
	readonly devices: readonly AtlasDevice[];
}

/** A host-authored list of device sets, replacing `defaultInputDeviceSets`. */
export const InputDeviceSetsDocument = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	kind: Schema.Literal("enhanced_input_device_sets"),
	sets: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			label: Schema.String,
			devices: Schema.Array(Schema.Literals(["gamepad", "keyboard", "mouse"])).check(
				Schema.isMinLength(1)
			)
		})
	).check(Schema.isMinLength(1))
});
export type InputDeviceSetsDocument = Schema.Schema.Type<typeof InputDeviceSetsDocument>;

/** A starting point a host can replace: keyboard with mouse, and gamepad. */
export const defaultInputDeviceSets: readonly InputDeviceSet[] = [
	{ id: "keyboard_mouse", label: "Keyboard and mouse", devices: ["keyboard", "mouse"] },
	{ id: "gamepad", label: "Gamepad", devices: ["gamepad"] }
];

export interface InputActionDeviceCoverage {
	readonly action: string;
	readonly name: string;
	readonly sets: readonly {
		readonly id: string;
		readonly keys: readonly string[];
		readonly covered: boolean;
	}[];
}

/** For each mapped action, which keys each device set offers. Unmapped actions are left out. */
export function inputDeviceCoverage(
	report: EnhancedInputReport,
	deviceSets: readonly InputDeviceSet[],
	options?: { readonly contexts?: readonly string[] }
): readonly InputActionDeviceCoverage[] {
	const keysByAction = new Map<string, Set<string>>();
	for (const context of report.mappingContexts) {
		if (options?.contexts !== undefined && !options.contexts.includes(context.objectPath))
			continue;
		for (const mapping of context.mappings) {
			if (mapping.action === null || mapping.keyName.status !== "available") continue;
			const keys = keysByAction.get(mapping.action) ?? new Set<string>();
			keys.add(mapping.keyName.value);
			keysByAction.set(mapping.action, keys);
		}
	}
	return [...keysByAction.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([action, keys]) => ({
			action,
			name: objectName(action),
			sets: deviceSets.map((set) => {
				const matching = [...keys]
					.filter((key) => set.devices.includes(deviceOf(key)))
					.sort((left, right) => left.localeCompare(right));
				return { id: set.id, keys: matching, covered: matching.length > 0 };
			})
		}));
}
