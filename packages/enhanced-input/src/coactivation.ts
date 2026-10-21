// Co-activation is policy. Mapping contexts carry no priority and no "active together" fact; both
// are runtime arguments. These resolvers turn three optional evidence sources into one shape, so a
// host can use any of them, combine them, or replace them with its own.

import { Schema } from "effect";
import type { EnhancedInputReport } from "./schema.js";

export const CoActivationSource = Schema.Literals([
	"project_default_contexts",
	"config_asset",
	"host_document"
]);
export type CoActivationSource = Schema.Schema.Type<typeof CoActivationSource>;

/** One mapping context in a set, by object or package path, with the priority it is added at. */
export const CoActivationMember = Schema.Struct({
	context: Schema.String,
	/** `null` when the source does not state one. Never filled with an engine default. */
	priority: Schema.NullOr(Schema.Int)
});
export type CoActivationMember = Schema.Schema.Type<typeof CoActivationMember>;

/** Contexts a source says can be active at the same time. */
export const CoActivationSet = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	source: CoActivationSource,
	/** The config section and key, the config asset's object path, or the document's path. */
	origin: Schema.String,
	/** Platforms this set applies to. Absent means the source did not restrict it. */
	platforms: Schema.optionalKey(Schema.Array(Schema.String)),
	contexts: Schema.Array(CoActivationMember)
});
export type CoActivationSet = Schema.Schema.Type<typeof CoActivationSet>;

/** Whether a source produced sets, had nothing to say, or could not be read. */
export const CoActivationSourceStatus = Schema.Union([
	Schema.Struct({
		source: CoActivationSource,
		status: Schema.Literal("resolved"),
		sets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		detail: Schema.String
	}),
	Schema.Struct({
		source: CoActivationSource,
		status: Schema.Literal("absent"),
		detail: Schema.String
	}),
	Schema.Struct({
		source: CoActivationSource,
		status: Schema.Literal("unavailable"),
		detail: Schema.String,
		recovery: Schema.String
	})
]);
export type CoActivationSourceStatus = Schema.Schema.Type<typeof CoActivationSourceStatus>;

/**
 * The host-authored co-activation document. Each set lists contexts that can be active together;
 * priorities are optional and, when given, follow Unreal: a higher number wins.
 */
export const CoActivationDocument = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	kind: Schema.Literal("enhanced_input_co_activation"),
	sets: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			label: Schema.optionalKey(Schema.String),
			platforms: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
			contexts: Schema.Array(
				Schema.Struct({
					context: Schema.NonEmptyString,
					priority: Schema.optionalKey(Schema.Int)
				})
			).check(Schema.isMinLength(1))
		})
	)
});
export type CoActivationDocument = Schema.Schema.Type<typeof CoActivationDocument>;

export const decodeCoActivationDocument = Schema.decodeUnknownEffect(CoActivationDocument);

/**
 * The identity a context is matched by: its package path. `/Game/Input/IMC_A.IMC_A`,
 * `/Game/Input/IMC_A` and the `Class'/Game/Input/IMC_A.IMC_A'` text form all name one asset.
 */
export function contextIdentity(reference: string): string {
	const quoted = /^[^']*'([^']*)'$/.exec(reference.trim());
	const path = (quoted?.[1] ?? reference).trim().replace(/^"|"$/g, "");
	return path.split(/[.:]/, 1)[0] ?? path;
}

/** One set per config asset, from its `Contexts` map. A config without readable contexts adds none. */
export function coActivationFromConfigAssets(
	report: EnhancedInputReport
): readonly CoActivationSet[] {
	return (report.playerMappableConfigs ?? []).flatMap((config) => {
		if (config.contexts.status !== "available") return [];
		const contexts = config.contexts.value.flatMap((entry) =>
			entry.context === null ? [] : [{ context: entry.context, priority: entry.priority }]
		);
		if (contexts.length === 0) return [];
		const name =
			config.configName.status === "available" && config.configName.value.length > 0
				? config.configName.value
				: (config.objectPath.split(/[/.]/).at(-1) ?? config.objectPath);
		return [
			{
				id: `config_asset:${config.objectPath}`,
				label: name,
				source: "config_asset" as const,
				origin: config.objectPath,
				contexts
			}
		];
	});
}

/** One `FDefaultContextSetting` entry as written in config text. */
export interface DefaultContextSetting {
	readonly context: string | null;
	/** `null` when the line does not write it. */
	readonly priority: number | null;
	readonly addImmediately: boolean | null;
	readonly registerWithUserSettings: boolean | null;
	readonly text: string;
}

/** Splits Unreal struct text `(A=1,B="x,y",C=(D=2))` into top-level `key=value` pairs. */
export function parseUnrealStructText(text: string): ReadonlyMap<string, string> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return undefined;
	const body = trimmed.slice(1, -1);
	const pairs = new Map<string, string>();
	let depth = 0;
	let quoted = false;
	let start = 0;
	const flush = (end: number) => {
		const part = body.slice(start, end).trim();
		if (part.length === 0) return;
		const separator = part.indexOf("=");
		if (separator > 0)
			pairs.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
	};
	for (let index = 0; index < body.length; index += 1) {
		const character = body[index];
		if (character === "\\" && quoted) {
			index += 1;
			continue;
		}
		if (character === '"') quoted = !quoted;
		else if (!quoted && character === "(") depth += 1;
		else if (!quoted && character === ")") depth -= 1;
		else if (!quoted && depth === 0 && character === ",") {
			flush(index);
			start = index + 1;
		}
	}
	flush(body.length);
	return pairs;
}

function unquote(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1).replaceAll('\\"', '"')
		: value;
}

function booleanText(value: string | undefined): boolean | null {
	if (value === undefined) return null;
	const normalized = value.toLowerCase();
	if (normalized === "true" || normalized === "1") return true;
	if (normalized === "false" || normalized === "0") return false;
	return null;
}

/** Parses the config array values of `DefaultMappingContexts`. Unparseable lines are skipped. */
export function parseDefaultContextSettings(
	values: readonly string[]
): readonly DefaultContextSetting[] {
	return values.flatMap((text) => {
		const pairs = parseUnrealStructText(text);
		if (pairs === undefined) return [];
		const context = pairs.get("InputMappingContext");
		const priority = pairs.get("Priority");
		const parsedPriority = priority === undefined ? Number.NaN : Number(priority);
		const contextText = context === undefined ? "" : unquote(context);
		return [
			{
				context:
					contextText.length === 0 || contextText === "None"
						? null
						: contextIdentity(contextText),
				priority: Number.isInteger(parsedPriority) ? parsedPriority : null,
				addImmediately: booleanText(pairs.get("bAddImmediately")),
				registerWithUserSettings: booleanText(pairs.get("bRegisterWithUserSettings")),
				text
			}
		];
	});
}

/**
 * The project's default contexts as one set. A context written with `bAddImmediately=False` is not
 * applied when the subsystem starts, so it is left out; one that does not write the flag stays in.
 */
export function coActivationFromDefaultContexts(
	settings: readonly DefaultContextSetting[],
	options: {
		readonly origin: string;
		readonly platform?: string;
		readonly id?: string;
		readonly label?: string;
	}
): readonly CoActivationSet[] {
	const contexts = settings.flatMap((setting) =>
		setting.context === null || setting.addImmediately === false
			? []
			: [{ context: setting.context, priority: setting.priority }]
	);
	if (contexts.length === 0) return [];
	return [
		{
			id:
				options.id ??
				`project_default_contexts${options.platform ? `:${options.platform}` : ""}`,
			label: options.label ?? "Project default contexts",
			source: "project_default_contexts",
			origin: options.origin,
			...(options.platform === undefined ? undefined : { platforms: [options.platform] }),
			contexts
		}
	];
}

/** The sets a host document declares, unchanged apart from its source and origin. */
export function coActivationFromDocument(
	document: CoActivationDocument,
	origin: string
): readonly CoActivationSet[] {
	return document.sets.map((set) => ({
		id: `host_document:${set.id}`,
		label: set.label ?? set.id,
		source: "host_document" as const,
		origin,
		...(set.platforms === undefined ? undefined : { platforms: [...set.platforms] }),
		contexts: set.contexts.map((member) => ({
			context: member.context,
			priority: member.priority ?? null
		}))
	}));
}

/** Keeps the sets that apply on a platform: those for it and those with no platform restriction. */
export function coActivationForPlatform(
	sets: readonly CoActivationSet[],
	platform: string | undefined
): readonly CoActivationSet[] {
	return platform === undefined
		? sets
		: sets.filter((set) => set.platforms === undefined || set.platforms.includes(platform));
}
