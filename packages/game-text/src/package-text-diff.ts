import { Schema } from "effect";
import { SavedAssetTextOccurrence, type SavedAssetPackageTextRecord } from "@ue-shed/protocol";

/**
 * Where one text lives inside its package, independent of the package's own name: the object path
 * with the package name removed (`/Game/UI/W_Menu.W_Menu:Title` and `W_Menu:Title` are the same
 * place), then the DataTable row, String Table entry key or property chain.
 */
export const PackageTextPlace = Schema.Struct({
	kind: Schema.Literals(["data_table_cell", "string_table_entry", "asset_property"]),
	objectPath: Schema.String,
	/** DataTable row, String Table entry key, or empty for an asset property. */
	entry: Schema.String,
	/** Property chain; empty for a String Table entry. */
	propertyPath: Schema.String
}).annotate({ identifier: "PackageTextPlace" });
export type PackageTextPlace = typeof PackageTextPlace.Type;

/**
 * One difference between two copies of a package's text, place by place:
 *
 * - `added` / `removed`: a place only one copy has text at;
 * - `rekeyed`: the same place with a different identity (namespace and key, String Table
 *   reference, or a key that became or stopped being culture invariant); `sourceChanged` says
 *   whether its text changed too;
 * - `edited`: the same place and identity with different source text or translator notes.
 *
 * Text that moved to another place is reported as removed and added; pairing moves is a policy
 * the caller owns (see `localization-key-changes.ts`).
 */
export const PackageTextChange = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("added"),
		place: PackageTextPlace,
		after: SavedAssetTextOccurrence
	}),
	Schema.Struct({
		kind: Schema.Literal("removed"),
		place: PackageTextPlace,
		before: SavedAssetTextOccurrence
	}),
	Schema.Struct({
		kind: Schema.Literal("rekeyed"),
		place: PackageTextPlace,
		before: SavedAssetTextOccurrence,
		after: SavedAssetTextOccurrence,
		sourceChanged: Schema.Boolean
	}),
	Schema.Struct({
		kind: Schema.Literal("edited"),
		place: PackageTextPlace,
		before: SavedAssetTextOccurrence,
		after: SavedAssetTextOccurrence,
		sourceChanged: Schema.Boolean,
		notesChanged: Schema.Boolean
	})
]).annotate({ identifier: "PackageTextChange" });
export type PackageTextChange = typeof PackageTextChange.Type;

/**
 * Saved text comparison result with changes and inspection/coverage evidence. Unsupported or
 * failed reads cannot establish that a package's text is unchanged.
 */
export const PackageTextDiff = Schema.Struct({
	changes: Schema.Array(PackageTextChange),
	counts: Schema.Struct({
		added: Schema.Number,
		removed: Schema.Number,
		rekeyed: Schema.Number,
		edited: Schema.Number,
		unchanged: Schema.Number
	}),
	/**
	 * False when either copy was read only in part (`status: "partial"`): text the reader could
	 * not decode is missing from that side, so an added or removed change may not be real.
	 */
	complete: Schema.Boolean
}).annotate({ identifier: "PackageTextDiff" });
export type PackageTextDiff = typeof PackageTextDiff.Type;

type Occurrence = SavedAssetTextOccurrence;

/** The object path below the package: everything after the package name's first `.`. */
function packageRelativeObjectPath(objectPath: string): string {
	if (!objectPath.startsWith("/")) return objectPath;
	const dot = objectPath.indexOf(".");
	return dot < 0 ? "" : objectPath.slice(dot + 1);
}

/** The place an occurrence names inside its package. */
export function packageTextPlace(occurrence: Occurrence): PackageTextPlace {
	const location = occurrence.location;
	const objectPath = packageRelativeObjectPath(location.object_path);
	switch (location.kind) {
		case "data_table_cell":
			return {
				kind: location.kind,
				objectPath,
				entry: location.row,
				propertyPath: location.property_path
			};
		case "string_table_entry":
			return { kind: location.kind, objectPath, entry: location.entry_key, propertyPath: "" };
		case "asset_property":
			return {
				kind: location.kind,
				objectPath,
				entry: "",
				propertyPath: location.property_path
			};
	}
}

function placeKey(place: PackageTextPlace): string {
	return JSON.stringify([place.kind, place.objectPath, place.entry, place.propertyPath]);
}

function identityKey(occurrence: Occurrence): string {
	const identity = occurrence.identity;
	switch (identity.status) {
		case "resolved":
			return JSON.stringify([identity.status, identity.namespace, identity.key]);
		case "string_table":
			return JSON.stringify([identity.status, identity.table_id, identity.key]);
		case "unresolved":
			return JSON.stringify([identity.status, identity.reason]);
	}
}

function sameText(before: Occurrence, after: Occurrence): boolean {
	return (
		identityKey(before) === identityKey(after) &&
		before.source === after.source &&
		before.dev_notes === after.dev_notes
	);
}

function changeAt(
	place: PackageTextPlace,
	before: Occurrence,
	after: Occurrence
): PackageTextChange {
	const sourceChanged = before.source !== after.source;
	return identityKey(before) === identityKey(after)
		? {
				kind: "edited",
				place,
				before,
				after,
				sourceChanged,
				notesChanged: before.dev_notes !== after.dev_notes
			}
		: { kind: "rekeyed", place, before, after, sourceChanged };
}

function placesOf(record: SavedAssetPackageTextRecord): Map<string, Occurrence[]> {
	const places = new Map<string, Occurrence[]>();
	for (const occurrence of record.occurrences) {
		const key = placeKey(packageTextPlace(occurrence));
		const list = places.get(key);
		if (list) list.push(occurrence);
		else places.set(key, [occurrence]);
	}
	return places;
}

/**
 * Compares the text of two copies of one package, for example the depot's head revision and the
 * local file, read by the same reader. Places match by their position inside the package, not by
 * the package's saved name, so a copy saved under another name still lines up.
 *
 * A place normally holds one text. When a copy holds several at one place, identical texts pair
 * first, then the rest pair in saved order, and any surplus is added or removed.
 *
 * Changes come in the `after` copy's order, then removed places in the `before` copy's order. The
 * function is pure; reading the two copies and getting the earlier revision stay with the caller.
 */
export function diffPackageText(
	before: SavedAssetPackageTextRecord,
	after: SavedAssetPackageTextRecord
): PackageTextDiff {
	const beforePlaces = placesOf(before);
	const changes: PackageTextChange[] = [];
	const counts = { added: 0, removed: 0, rekeyed: 0, edited: 0, unchanged: 0 };
	const push = (change: PackageTextChange) => {
		counts[change.kind] += 1;
		changes.push(change);
	};
	const afterPlaces = placesOf(after);
	for (const [key, afterTexts] of afterPlaces) {
		const [first] = afterTexts;
		if (first === undefined) continue;
		const place = packageTextPlace(first);
		const beforeTexts = [...(beforePlaces.get(key) ?? [])];
		const unmatched: Occurrence[] = [];
		for (const text of afterTexts) {
			const same = beforeTexts.findIndex((candidate) => sameText(candidate, text));
			if (same < 0) unmatched.push(text);
			else {
				beforeTexts.splice(same, 1);
				counts.unchanged += 1;
			}
		}
		for (const [index, text] of unmatched.entries()) {
			const earlier = beforeTexts[index];
			push(
				earlier === undefined
					? { kind: "added", place, after: text }
					: changeAt(place, earlier, text)
			);
		}
		for (const earlier of beforeTexts.slice(unmatched.length)) {
			push({ kind: "removed", place, before: earlier });
		}
	}
	for (const [key, beforeTexts] of beforePlaces) {
		if (afterPlaces.has(key)) continue;
		for (const earlier of beforeTexts) {
			push({ kind: "removed", place: packageTextPlace(earlier), before: earlier });
		}
	}
	return {
		changes,
		counts,
		complete: before.status === "complete" && after.status === "complete"
	};
}
