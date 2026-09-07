import { Effect, Schema } from "effect";
import type { ActorExplorerFilters, ActorExplorerItem } from "./actor-explorer-core.js";

const Preset = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
	query: Schema.String.check(Schema.isMaxLength(4096)),
	classPaths: Schema.optionalKey(Schema.Array(Schema.String))
});
const Presets = Schema.Struct({ version: Schema.Literal(1), presets: Schema.Array(Preset) });
export type ActorFilterPreset = typeof Preset.Type;
export const actorFilterStorageKey = "ue-shed.actor-filter-presets.v1";

export class ActorUtilityError extends Schema.TaggedErrorClass<ActorUtilityError>()(
	"ActorUtilityError",
	{ message: Schema.String }
) {}

export const readActorFilterPresets = Effect.fn("ActorFilters.read")(function* (
	storage: Pick<Storage, "getItem">
) {
	const text = yield* Effect.try({
		try: () => storage.getItem(actorFilterStorageKey),
		catch: () => new ActorUtilityError({ message: "Preset storage is unavailable." })
	});
	if (text === null) return [];
	return (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Presets))(text).pipe(
		Effect.mapError(
			() =>
				new ActorUtilityError({
					message: "Saved presets could not be read. Existing data has been preserved."
				})
		)
	)).presets;
});

export const writeActorFilterPreset = Effect.fn("ActorFilters.write")(function* (
	storage: Pick<Storage, "getItem" | "setItem">,
	name: string,
	filters: ActorExplorerFilters | undefined
) {
	const current = yield* readActorFilterPresets(storage);
	const base = { name: name.trim(), query: filters?.query ?? "" };
	const presetInput =
		filters?.classPaths === undefined ? base : { ...base, classPaths: filters.classPaths };
	const retained = current.filter((preset) => preset.name !== name.trim());
	const presets =
		filters === undefined
			? retained
			: [
					...retained,
					yield* Schema.decodeUnknownEffect(Preset)(presetInput).pipe(
						Effect.mapError(
							() =>
								new ActorUtilityError({
									message:
										"Use a preset name of 1–80 characters and a search of at most 4096 characters."
								})
						)
					)
				];
	yield* Effect.try({
		try: () => storage.setItem(actorFilterStorageKey, JSON.stringify({ version: 1, presets })),
		catch: () =>
			new ActorUtilityError({
				message: "Could not save presets. Check available browser storage."
			})
	});
	return presets;
});

export function actorCopyDetails(
	item: ActorExplorerItem
): readonly { label: string; value: string }[] {
	const location = item.location;
	return [
		...(item.path ? [{ label: "path", value: item.path }] : []),
		...(item.actorGuid ? [{ label: "GUID", value: item.actorGuid }] : []),
		...(location && [location.x, location.y, location.z].every(Number.isFinite)
			? [{ label: "coordinates", value: `X=${location.x} Y=${location.y} Z=${location.z}` }]
			: [])
	];
}

export const copyActorText = Effect.fn("ActorDetails.copy")((text: string) =>
	Effect.tryPromise({
		try: () => navigator.clipboard.writeText(text),
		catch: () =>
			new ActorUtilityError({
				message: "Clipboard unavailable. Select and copy the displayed value."
			})
	})
);

export const actorPresetStorage = Effect.try({
	try: () => window.localStorage,
	catch: () => new ActorUtilityError({ message: "Preset storage is unavailable." })
});
