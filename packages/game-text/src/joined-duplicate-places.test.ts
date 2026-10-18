import { expect, it } from "vitest";
import { duplicateOccurrencePlace } from "./duplicate-sources.js";
import { joinedDuplicatePlaces } from "./joined-duplicate-places.test-support.js";
import type { TextLocation, TextOccurrence } from "./schema.js";
import { encodeWtf8 } from "./wtf8.js";

type Place = Pick<TextOccurrence, "packageFile" | "location">;
const asset = (objectPath: string, propertyPath: string): TextLocation => ({
	kind: "asset_property",
	objectPath,
	propertyPath,
	classPath: "/Script/Engine.DataAsset"
});
const cell = (row: string, propertyPath = "Label"): TextLocation => ({
	kind: "data_table_cell",
	objectPath: "/Game/Text/Table.Table",
	row,
	propertyPath
});
const entry = (entryKey: string): TextLocation => ({
	kind: "string_table_entry",
	objectPath: "/Game/Text/Table.Table",
	entryKey
});
const place = (location: TextLocation, packageFile = "Content/Text/Table.uasset"): Place => ({
	location,
	packageFile
});

function columns(places: readonly Place[], order = Uint32Array.from(places, (_, row) => row)) {
	const ids = new Map<string, number>(),
		strings: string[] = [];
	const intern = (value: string) => {
		let id = ids.get(value);
		if (id === undefined) {
			id = strings.length;
			strings.push(value);
			ids.set(value, id);
		}
		return id;
	};
	return joinedDuplicatePlaces(
		{
			occurrence: {
				object: Uint32Array.from(places, ({ location }) => intern(location.objectPath)),
				property: Uint32Array.from(places, ({ location }) =>
					intern(location.kind === "string_table_entry" ? "" : location.propertyPath)
				),
				row: Uint32Array.from(places, ({ location }) =>
					intern(
						location.kind === "string_table_entry"
							? location.entryKey
							: location.kind === "data_table_cell"
								? location.row
								: ""
					)
				),
				location: Uint32Array.from(places, ({ location }) =>
					location.kind === "string_table_entry"
						? 2
						: location.kind === "data_table_cell"
							? 1
							: 0
				)
			},
			packageRow: Uint32Array.from(places, (_, row) => row),
			packageFile: (row) => places[row]!.packageFile,
			string: (id) => strings[id]!,
			bytes: (id) => encodeWtf8(strings[id]!)
		},
		order
	);
}

it("shares places across case, slash and array spelling while retaining table coordinates", () => {
	const places = [
		place(asset("/Game/Text/Table.Table", "Labels[0]")),
		place(asset("  \\GAME\\TEXT\\TABLE.TABLE", "labels(0)  "), "./content\\TEXT\\table.umap"),
		place(cell("First")),
		place(cell("Second")),
		place(cell("first")),
		place(asset("/Game/Text/Table.Table", "FIRST.LABEL")),
		place(entry("Entry")),
		place(entry("entry")),
		place({ ...entry("Entry"), objectPath: "  \\GAME\\TEXT\\TABLE.TABLE  " })
	];
	expect([...columns(places)]).toEqual([0, 0, 1, 2, 1, 1, 3, 4, 3]);
});

it("checks exact coordinates when distinct places have the same numeric hash", () => {
	const first = asset("/Game/Text/Table.Table", "fieldxkc8k9");
	const second = asset("/Game/Text/Table.Table", "field195kfpl");
	// Both canonical coordinates hash to 1841816063; revisits must follow the collision chain.
	expect([...columns([place(first), place(second), place(first), place(second)])]).toEqual([
		0, 1, 0, 1
	]);
});

it("matches legacy place IDs for precise, fallback and cross-location coordinates", () => {
	const objects = [
		"/Game/Text/Table.Table",
		" /GAME/Text/Table.Table",
		"/Game/Text/Table.Table:Part",
		"Table",
		"table",
		"Source/File.cpp:12",
		"",
		"/Game/Text/Table.Table\n",
		"/Game/Σ.Σ"
	];
	const fields = [
		"Label",
		"label",
		"Labels(0)",
		"Labels[0]",
		"Labels(12).Nested(0)",
		"Labels[12].Nested[0]",
		"Labels(0",
		"Label\t\r\n",
		"",
		"  ",
		"\nLabel",
		"Label\nTail",
		"ROW.Label",
		"(12)",
		"\\Label",
		"Σ",
		"ς",
		"σ",
		"\ud800"
	];
	const places: Place[] = [];
	for (const objectPath of objects)
		for (const propertyPath of fields) {
			places.push(place(asset(objectPath, propertyPath)));
			places.push(place({ ...cell("Row", propertyPath), objectPath }));
			places.push(place({ ...entry(propertyPath), objectPath }));
		}
	// Reverse traversal also pins the existing first-seen numeric ID assignment.
	const order = Uint32Array.from(places, (_, row) => places.length - row - 1);
	const expected = new Uint32Array(places.length),
		ids = new Map<string, number>();
	for (const row of order) {
		const key = duplicateOccurrencePlace(places[row]!);
		let id = ids.get(key);
		if (id === undefined) {
			id = ids.size;
			ids.set(key, id);
		}
		expected[row] = id;
	}
	expect(columns(places, order)).toEqual(expected);
});
