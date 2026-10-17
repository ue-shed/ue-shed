import { Schema } from "effect";

/** Portable loaded-actor identity. A GUID is authoritative; its path is diagnostic, never a fallback. */
export const CameraActorReference = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("actor_path"),
		actorPath: Schema.String.check(Schema.isStartingWith("/Game/"), Schema.isMaxLength(4096))
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_guid"),
		actorGuid: Schema.String.check(
			Schema.isPattern(
				/^(?!00000000-00000000-00000000-00000000$)[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{8}){3}$/u
			)
		),
		lastKnownActorPath: Schema.String.check(Schema.isMaxLength(4096))
	})
]);
export type CameraActorReference = typeof CameraActorReference.Type;
/**
 * Actor locator and bounded display label for visibility policy. Labels are presentation;
 * locator identity, preferably authored GUID, determines which actor is targeted.
 */
export const CameraActorEntry = Schema.Struct({
	locator: CameraActorReference,
	label: Schema.String.check(Schema.isMaxLength(256))
});
export type CameraActorEntry = typeof CameraActorEntry.Type;
/**
 * Bounded hide/protect actor lists for authored visibility. Merge/resolution logic handles
 * precedence and diagnostics; a syntactically valid list does not prove actors are loaded.
 */
export const CameraVisibilityList = Schema.Struct({
	hide: Schema.Array(CameraActorEntry).check(Schema.isMaxLength(256)),
	protect: Schema.Array(CameraActorEntry).check(Schema.isMaxLength(256))
});
export type CameraVisibilityList = typeof CameraVisibilityList.Type;
/**
 * Natural-only, authored-only or paired natural/authored output policy. Authored visibility
 * is distinct evidence and must not be presented as an unchanged natural frame.
 */
export const CameraVisibilityOutput = Schema.Literals([
	"natural_only",
	"authored_only",
	"natural_and_authored"
]);
/**
 * Version-1 explicit visibility output and actor policy. Temporary editor hiding must be
 * scoped/restored by capture rather than persisted into the map.
 */
export const CameraAuthoredVisibility = Schema.Struct({
	version: Schema.Literal(1),
	output: CameraVisibilityOutput,
	actors: CameraVisibilityList
});
export type CameraAuthoredVisibility = typeof CameraAuthoredVisibility.Type;
/**
 * Per-locator resolved, missing/unloaded, ambiguous or unsupported outcome with observed
 * path. Preserve failures when reporting capture fidelity.
 */
export const CameraVisibilityDiagnostic = Schema.Struct({
	locator: CameraActorReference,
	status: Schema.Literals(["resolved", "missing_or_unloaded", "ambiguous", "unsupported"]),
	actorPath: Schema.String,
	message: Schema.String
});
/**
 * Returns a stable comparison key, lowercasing GUID identity while preserving path spelling.
 * This pure helper does not resolve an actor or establish loaded-world ownership.
 */
export function cameraActorIdentity(locator: CameraActorReference): string {
	return locator.kind === "actor_guid"
		? `guid:${locator.actorGuid.toLowerCase()}`
		: `path:${locator.actorPath}`;
}
/** Protection wins at every level. Native resolution deduplicates path/GUID aliases by live actor. */
export function mergeCameraVisibility(
	...lists: readonly (CameraVisibilityList | undefined)[]
): CameraVisibilityList {
	const hide = new Map<string, CameraActorEntry>(),
		protect = new Map<string, CameraActorEntry>();
	for (const list of lists) {
		for (const entry of list?.hide ?? []) hide.set(cameraActorIdentity(entry.locator), entry);
		for (const entry of list?.protect ?? [])
			protect.set(cameraActorIdentity(entry.locator), entry);
	}
	for (const id of protect.keys()) hide.delete(id);
	return CameraVisibilityList.make({ hide: [...hide.values()], protect: [...protect.values()] });
}

/** Map-specific exclusions are separate from actor-free framing recipes. */
export const CameraVisibilityPreset = Schema.Struct({
	version: Schema.Literal(1),
	id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u)),
	name: Schema.NonEmptyString,
	projectName: Schema.NonEmptyString,
	mapPath: Schema.String.check(Schema.isStartingWith("/Game/")),
	actors: CameraVisibilityList
});
export type CameraVisibilityPreset = typeof CameraVisibilityPreset.Type;
