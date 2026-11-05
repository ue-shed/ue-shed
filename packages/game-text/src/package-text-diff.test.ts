import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { SavedAssetPackageTextRecord, SavedAssetTextOccurrence } from "@ue-shed/unreal-assets";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { PackageTextDiff, diffPackageText, packageTextPlace } from "./package-text-diff.js";

const decodeDiff = Schema.decodeUnknownSync(PackageTextDiff);

const PACKAGE = "/Game/UI/W_Menu";

function property(
	propertyPath: string,
	source: string,
	key: string,
	options: { objectPath?: string; namespace?: string; notes?: string } = {}
): SavedAssetTextOccurrence {
	return {
		source,
		dev_notes: options.notes ?? "",
		identity: { status: "resolved", namespace: options.namespace ?? "", key },
		location: {
			kind: "asset_property",
			object_path: options.objectPath ?? `${PACKAGE}.W_Menu_C:WidgetTree.Title`,
			class_path: "/Script/UMG.TextBlock",
			property_path: propertyPath
		},
		edit_capability: "source_editable"
	};
}

function packageText(
	occurrences: readonly SavedAssetTextOccurrence[],
	status: SavedAssetPackageTextRecord["status"] = "complete"
): SavedAssetPackageTextRecord {
	return { ...emptyPackageTextRecord("Content/UI/W_Menu.uasset"), status, occurrences };
}

describe("package text diff", () => {
	it("reports nothing for identical copies", () => {
		const text = [property("Text", "Play", "A1"), property("ToolTip", "Start a game", "A2")];
		const diff = diffPackageText(packageText(text), packageText([...text]));
		expect(diff.changes).toEqual([]);
		expect(diff.counts).toEqual({ added: 0, removed: 0, rekeyed: 0, edited: 0, unchanged: 2 });
		expect(diff.complete).toBe(true);
	});

	it("reports added, removed, re-keyed and edited text place by place", () => {
		const before = packageText([
			property("Text", "Play", "A1"),
			property("ToolTip", "Start a game", "A2"),
			property("Hint", "Press any key", "A3"),
			property("Footer", "v1", "A4", { notes: "Version" })
		]);
		const after = packageText([
			property("Text", "Play", "B1"),
			property("ToolTip", "Start a new game", "A2"),
			property("Footer", "v1", "A4", { notes: "Build version" }),
			property("Credits", "Credits", "A5")
		]);
		const diff = diffPackageText(before, after);
		expect(diff.changes.map((change) => [change.kind, change.place.propertyPath])).toEqual([
			["rekeyed", "Text"],
			["edited", "ToolTip"],
			["edited", "Footer"],
			["added", "Credits"],
			["removed", "Hint"]
		]);
		expect(diff.changes[0]).toMatchObject({ kind: "rekeyed", sourceChanged: false });
		expect(diff.changes[1]).toMatchObject({
			kind: "edited",
			sourceChanged: true,
			notesChanged: false
		});
		expect(diff.changes[2]).toMatchObject({
			kind: "edited",
			sourceChanged: false,
			notesChanged: true
		});
		expect(diff.counts).toEqual({ added: 1, removed: 1, rekeyed: 1, edited: 2, unchanged: 0 });
		expect(decodeDiff(diff)).toEqual(diff);
	});

	it("treats a new namespace, a String Table reference or a lost key as a re-key", () => {
		const place = "Text";
		const before = packageText([property(place, "Play", "A1")]);
		const cases: SavedAssetTextOccurrence[] = [
			property(place, "Play", "A1", { namespace: "Menu" }),
			{
				...property(place, "Play", "A1"),
				identity: { status: "string_table", table_id: "/Game/ST_Menu.ST_Menu", key: "A1" }
			},
			{
				...property(place, "Play!", "A1"),
				identity: { status: "unresolved", reason: "culture_invariant" }
			}
		];
		for (const occurrence of cases) {
			const [change] = diffPackageText(before, packageText([occurrence])).changes;
			expect(change).toMatchObject({
				kind: "rekeyed",
				sourceChanged: occurrence.source !== "Play"
			});
		}
	});

	it("lines up places by their position in the package, not the package's saved name", () => {
		const relative = property("Text", "Play", "A1", {
			objectPath: "W_Menu_C:WidgetTree.Title"
		});
		const mounted = property("Text", "Play", "A1");
		const branched = property("Text", "Play", "A1", {
			objectPath: "/Game/Branched/UI/W_Menu.W_Menu_C:WidgetTree.Title"
		});
		expect(packageTextPlace(relative)).toEqual(packageTextPlace(mounted));
		expect(diffPackageText(packageText([relative]), packageText([branched])).changes).toEqual(
			[]
		);
	});

	it("keeps DataTable cells, String Table entries and properties apart", () => {
		const cell: SavedAssetTextOccurrence = {
			...property("Name", "Sword", "Sword"),
			location: {
				kind: "data_table_cell",
				object_path: "/Game/Data/DT_Items.DT_Items",
				row: "Sword",
				property_path: "Name"
			}
		};
		const entry: SavedAssetTextOccurrence = {
			...property("", "Sword", "Sword"),
			location: {
				kind: "string_table_entry",
				object_path: "/Game/Data/DT_Items.DT_Items",
				entry_key: "Sword"
			}
		};
		const renamedRow: SavedAssetTextOccurrence = {
			...cell,
			location: {
				kind: "data_table_cell",
				object_path: "/Game/Data/DT_Items.DT_Items",
				row: "Blade",
				property_path: "Name"
			}
		};
		const diff = diffPackageText(packageText([cell, entry]), packageText([renamedRow, entry]));
		expect(diff.changes.map((change) => [change.kind, change.place.entry])).toEqual([
			["added", "Blade"],
			["removed", "Sword"]
		]);
		expect(diff.counts.unchanged).toBe(1);
	});

	it("pairs identical texts first when one place holds several", () => {
		const first = property("Lines", "Hello", "L1");
		const second = property("Lines", "Goodbye", "L2");
		const third = property("Lines", "See you", "L3");
		const diff = diffPackageText(
			packageText([first, second, third]),
			packageText([second, property("Lines", "Hi", "L1")])
		);
		expect(diff.changes).toEqual([
			expect.objectContaining({ kind: "edited", sourceChanged: true }),
			expect.objectContaining({ kind: "removed", before: third })
		]);
		expect(diff.counts.unchanged).toBe(1);
	});

	it("says a diff is incomplete when either copy was read in part", () => {
		const text = [property("Text", "Play", "A1")];
		expect(diffPackageText(packageText(text, "partial"), packageText(text)).complete).toBe(
			false
		);
		expect(diffPackageText(packageText(text), packageText(text, "partial")).complete).toBe(
			false
		);
	});
});
