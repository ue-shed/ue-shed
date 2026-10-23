import { Schema } from "effect";
import {
	SavedAssetPackageTextRecord,
	SavedAssetTextOccurrence,
	type SavedAssetBlueprintClasses
} from "@ue-shed/unreal-assets";
import { TextCopyKind } from "./schema.js";
export { hasDifferingCopy, staleRuntimeCopy } from "./text-copies.js";
import {
	classifySavedTextAudience,
	lineTextAudience,
	type TextAudienceClassification
} from "./text-audience.js";

/**
 * A representation copy folded into the place it copies: the export Unreal saved it under, which
 * kind of copy that export is, and the text the copy holds. The game runs the compiled class, so
 * a copy whose text differs from its place's is what players see until the Blueprint compiles.
 */
export const SavedTextRepresentationCopy = Schema.Struct({
	object_path: Schema.String,
	kind: TextCopyKind,
	source: Schema.String,
	// The copy's own audience evidence: its saved class and the gather table's editor-only bit
	// for its text, which can differ from the place's when the texts differ.
	class_path: Schema.optionalKey(Schema.String),
	gather_editor_only: Schema.optionalKey(Schema.Boolean)
});
export type SavedTextRepresentationCopy = typeof SavedTextRepresentationCopy.Type;

/** A reader occurrence after folding: the place, with the copies that were merged into it. */
export const PackageTextOccurrence = SavedAssetTextOccurrence.pipe(
	Schema.fieldsAssign({
		copies: Schema.optionalKey(
			Schema.Array(SavedTextRepresentationCopy).check(Schema.isMinLength(1))
		)
	})
);
export type PackageTextOccurrence = typeof PackageTextOccurrence.Type;

/** A package text record whose representation copies are folded into their places. */
export const PackageTextRecord = SavedAssetPackageTextRecord.pipe(
	Schema.fieldsAssign({ occurrences: Schema.Array(PackageTextOccurrence) })
);
export type PackageTextRecord = typeof PackageTextRecord.Type;

type Prefix = {
	readonly path: string;
	readonly blueprint: string;
	readonly kind: TextCopyKind;
	/** Generated and skeleton classes rename UMG animations `Name_INST`; default objects do not. */
	readonly instances: boolean;
};

const RANK = { generated_class: 1, instance: 1, class_default: 2, skeleton: 3 } as const;

function copyPrefixes(classes: readonly SavedAssetBlueprintClasses[]): Prefix[] {
	return classes.flatMap((item) =>
		(
			[
				[item.generatedClass, "generated_class", true],
				[item.classDefault, "class_default", false],
				[item.skeletonClass, "skeleton", true],
				[item.skeletonClassDefault, "skeleton", false]
			] as const
		).flatMap(([path, kind, instances]) =>
			path === undefined || path === "" || path === item.blueprint
				? []
				: [{ path, blueprint: item.blueprint, kind, instances }]
		)
	);
}

/**
 * The authored site an object path copies, and the kind of copy, or undefined for a path outside
 * every class and default object the reader reported. `Pkg.X_C.WidgetTree.Title` copies
 * `Pkg.X.WidgetTree.Title`; a UMG animation `Pkg.X_C.FadeIn_INST.FadeIn.Track` copies
 * `Pkg.X.FadeIn.FadeIn.Track`; `Pkg.Default__X_C.Prompt` maps to `Pkg.X.Prompt`. The reader joins
 * outers with `.`; Unreal's `Pkg.X_C:WidgetTree.Title` spelling maps the same way, keeping `:`.
 */
export function representationSite(
	objectPath: string,
	prefixes: readonly Prefix[]
): { readonly site: string; readonly kind: TextCopyKind } | undefined {
	for (const prefix of prefixes) {
		if (objectPath === prefix.path) return { site: prefix.blueprint, kind: prefix.kind };
		const separator = objectPath[prefix.path.length];
		if ((separator !== "." && separator !== ":") || !objectPath.startsWith(prefix.path))
			continue;
		const rest = objectPath.slice(prefix.path.length + 1);
		const dot = rest.indexOf("."),
			first = dot < 0 ? rest : rest.slice(0, dot);
		if (prefix.instances && first.length > 5 && first.endsWith("_INST"))
			return {
				site: `${prefix.blueprint}${separator}${first.slice(0, -5)}${dot < 0 ? "" : rest.slice(dot)}`,
				kind: prefix.kind === "generated_class" ? "instance" : prefix.kind
			};
		return { site: `${prefix.blueprint}${separator}${rest}`, kind: prefix.kind };
	}
	return undefined;
}

function identityKey(occurrence: SavedAssetTextOccurrence): string {
	const identity = occurrence.identity;
	return identity.status === "resolved"
		? `r\0${identity.namespace}\0${identity.key}`
		: identity.status === "string_table"
			? `s\0${identity.table_id}\0${identity.key}`
			: `u\0${identity.reason}`;
}

function siteKey(occurrence: SavedAssetTextOccurrence, objectPath: string): string {
	const location = occurrence.location;
	const field =
		location.kind === "string_table_entry"
			? location.entry_key
			: location.kind === "data_table_cell"
				? `${location.row}\0${location.property_path}`
				: location.property_path;
	return `${location.kind}\0${objectPath}\0${field}\0${identityKey(occurrence)}`;
}

function withinObject(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}:`);
}

/**
 * Fold the representation copies of a package's Blueprints into the sites they copy.
 *
 * A Blueprint's compile saves its authored subobjects again under the generated class
 * (`X_C`, with UMG animations as `Name_INST`), its default object (`Default__X_C`) and, when one
 * was saved, the skeleton class (`SKEL_X_C`). Which exports those are comes from the reader's
 * `blueprintClasses` (the Blueprint's saved `GeneratedClass` and the export table), not from
 * names, so a record without it is returned unchanged. A copy folds into the occurrence at its
 * authored site with the same property and the same key: two properties of one object that share
 * a key stay two places. When no authored site was saved, the copies of one site fold into the
 * generated class's (then the default object's, then the skeleton's), which keeps its own path.
 *
 * The place keeps its own text; the copies keep theirs, with their raw paths, as provenance.
 * Folding is idempotent: a folded record folds to itself.
 */
/** A record type whose occurrences may carry folded copies. */
export type Folded<R> = Omit<R, "occurrences"> & {
	readonly occurrences: readonly PackageTextOccurrence[];
};

export function foldRepresentationCopies<
	R extends {
		readonly occurrences: readonly PackageTextOccurrence[];
		readonly blueprintClasses?: readonly SavedAssetBlueprintClasses[];
	}
>(record: R): Folded<R> {
	const classes = record.blueprintClasses;
	if (classes === undefined || classes.length === 0 || record.occurrences.length < 2)
		return record;
	const prefixes = copyPrefixes(classes);
	const sites = record.occurrences.map((occurrence) =>
		representationSite(occurrence.location.object_path, prefixes)
	);
	if (sites.every((site) => site === undefined)) return record;
	// A compiled literal has a function/bytecode offset rather than its pin's property path.
	// Only a unique saved pin of this Blueprint and identity proves which place it copies.
	const pins = new Map<string, number | null>();
	record.occurrences.forEach((occurrence, index) => {
		const location = occurrence.location;
		if (
			sites[index] !== undefined ||
			location.kind !== "asset_property" ||
			!/^Pins\[\d+\]\.DefaultTextValue$/u.test(location.property_path) ||
			occurrence.identity.status !== "resolved" ||
			!occurrence.identity.key
		)
			return;
		const blueprint = classes.find((item) =>
			withinObject(location.object_path, item.blueprint)
		);
		if (!blueprint) return;
		const key = `${blueprint.blueprint}\0${identityKey(occurrence)}`;
		pins.set(key, pins.has(key) ? null : index);
	});
	const groups = new Map<string, number[]>();
	record.occurrences.forEach((occurrence, index) => {
		const location = occurrence.location;
		const blueprint =
			sites[index]?.kind === "generated_class" &&
			location.kind === "asset_property" &&
			location.property_path.startsWith("ScriptBytecode[")
				? classes.find((item) => withinObject(location.object_path, item.generatedClass))
				: undefined;
		const pin = blueprint
			? pins.get(`${blueprint.blueprint}\0${identityKey(occurrence)}`)
			: undefined;
		const place = pin == null ? occurrence : record.occurrences[pin]!;
		const key = siteKey(
			place,
			pin == null ? (sites[index]?.site ?? location.object_path) : place.location.object_path
		);
		const group = groups.get(key);
		if (group) group.push(index);
		else groups.set(key, [index]);
	});
	const placeOf = new Map<number, number[]>();
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		const rank = (index: number) => {
			const kind = sites[index]?.kind;
			return kind === undefined ? 0 : RANK[kind];
		};
		// Stable: among equal ranks the reader's first occurrence stays the place.
		const place = members.reduce((best, index) => (rank(index) < rank(best) ? index : best));
		placeOf.set(
			place,
			members.filter((index) => index !== place)
		);
	}
	if (placeOf.size === 0) return record;
	const folded = new Set([...placeOf.values()].flat());
	const occurrences: PackageTextOccurrence[] = [];
	record.occurrences.forEach((occurrence, index) => {
		if (folded.has(index)) return;
		const members = placeOf.get(index);
		if (members === undefined) {
			occurrences.push(occurrence);
			return;
		}
		const copies: SavedTextRepresentationCopy[] = [...(occurrence.copies ?? [])];
		for (const member of members) {
			const copy = record.occurrences[member]!;
			copies.push({
				object_path: copy.location.object_path,
				kind: sites[member]!.kind,
				source: copy.source,
				...(copy.location.kind === "asset_property"
					? { class_path: copy.location.class_path }
					: undefined),
				...(copy.gather_editor_only === undefined
					? undefined
					: { gather_editor_only: copy.gather_editor_only })
			});
			copies.push(...(copy.copies ?? []));
		}
		occurrences.push({ ...occurrence, copies });
	});
	return { ...record, occurrences };
}

/**
 * The audience of a folded place: the line rollup (player, else unknown, else editor) over the
 * place and its copies, each classified from its own evidence: its path, its class and the gather
 * table's bit for its text. A runtime compiled copy of a place the table calls editor-only keeps
 * the line player text. The place's own classification wins ties, so a place without copies is
 * classified exactly as before.
 */
export function classifyFoldedTextAudience(
	occurrence: PackageTextOccurrence
): TextAudienceClassification {
	const own = classifySavedTextAudience(occurrence);
	if (occurrence.copies === undefined) return own;
	const { gather_editor_only: _place, copies, ...place } = occurrence;
	const all = [
		own,
		...copies.map((copy) =>
			classifySavedTextAudience({
				...place,
				location:
					place.location.kind === "asset_property"
						? {
								...place.location,
								object_path: copy.object_path,
								class_path: copy.class_path ?? place.location.class_path
							}
						: { ...place.location, object_path: copy.object_path },
				...(copy.gather_editor_only === undefined
					? undefined
					: { gather_editor_only: copy.gather_editor_only })
			})
		)
	];
	const audience = lineTextAudience(all.map((item) => item.audience));
	return all.find((item) => item.audience === audience)!;
}
