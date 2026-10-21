import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { sharedIndexNodeLayer, SharedIndex } from "./shared-index.js";
import { refreshPackageTextLayer, type PackageTextInventoryEntry } from "./package-text-layer.js";
import { decodePackageTextColumns } from "./package-text-columns.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { foldRepresentationCopies } from "./representation-copies.js";
import { encodeWtf8 } from "./wtf8.js";

/** Every fifth package is a Widget Blueprint whose compile saved its widgets again. */
function record(path: string, row: number, version = ""): SavedAssetPackageTextRecord {
	if (row % 5 !== 0) return emptyPackageTextRecord(path);
	const name = `WBP_${row}`,
		pkg = `/Game/UI/${name}`;
	const text = (object: string, property: string, source: string) => ({
		source,
		dev_notes: "",
		identity: { status: "resolved" as const, namespace: "UI", key: `${name}_${property}` },
		location: {
			kind: "asset_property" as const,
			object_path: `${pkg}.${object}`,
			class_path: "/Script/UMG.TextBlock",
			property_path: property
		},
		edit_capability: "read_only" as const
	});
	return {
		...emptyPackageTextRecord(path),
		occurrences: [
			// Each copy keeps its own audience evidence through storage: gather bit and class.
			{ ...text(`${name}_C.WidgetTree.Title`, "Text", "Play"), gather_editor_only: false },
			{
				...text(`${name}.WidgetTree.Title`, "Text", `Play${version}`),
				gather_editor_only: true
			},
			text(`${name}_C.SimpleConstructionScript_0.SCS_Node_0`, "CategoryName", "Default"),
			text(`${name}.WidgetTree.Hint`, "ToolTipText", "Press A"),
			{
				...text(`${name}_C.WidgetTree.Hint`, "ToolTipText", "Press A"),
				location: {
					kind: "asset_property" as const,
					object_path: `${pkg}.${name}_C.WidgetTree.Hint`,
					class_path: "/Script/UMG.Border",
					property_path: "ToolTipText"
				}
			}
		],
		blueprintClasses: [
			{
				blueprint: `${pkg}.${name}`,
				generatedClass: `${pkg}.${name}_C`,
				classDefault: `${pkg}.Default__${name}_C`
			}
		]
	};
}

describe("package text copies", () => {
	it("stores folded copies and Blueprint classes through cold and warm refreshes", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-package-copies-"));
		const inventory: PackageTextInventoryEntry[] = Array.from({ length: 32 }, (_, row) => ({
			path: `Content/UI/Package${row}.uasset`,
			signature: `signature-${row}`,
			headerData: {
				packageFlags: 0x40000,
				gatherableTextDataCount: 0,
				gatherableTextDataOffset: 0,
				hasTextProperty: false
			}
		}));
		inventory.sort((a, b) => Buffer.compare(encodeWtf8(a.path), encodeWtf8(b.path)));
		const rowOf = (path: string) => Number(/Package(\d+)/u.exec(path)![1]);
		let version = "";
		const read = (paths: readonly string[]) =>
			Stream.fromIterable(paths.map((path) => record(path, rowOf(path), version)));
		const stored = Effect.gen(function* () {
			const reader = yield* (yield* SharedIndex).open();
			const records = [];
			for (const name of Object.keys(reader.manifest.active))
				if (name.startsWith("package-text."))
					records.push(...(yield* decodePackageTextColumns(yield* reader.layer(name))));
			return new Map(records.map((item) => [item.path, item.evidence]));
		});
		const expected = (path: string) =>
			foldRepresentationCopies(record(path, rowOf(path), version));
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						// More than eight changed shards on an empty index: the cold worker path.
						yield* Effect.scoped(
							refreshPackageTextLayer({ inventory, read, coldMinimumPackages: 24 })
						);
						let records = yield* stored;
						expect(records.size).toBe(32);
						for (const entry of inventory)
							expect(records.get(entry.path)).toEqual(expected(entry.path));
						const blueprint = records.get("Content/UI/Package5.uasset")!;
						if (blueprint.event !== "text_package_record") throw new Error("Record");
						expect(
							blueprint.occurrences.map((item) => [
								item.location.object_path,
								item.copies?.map((copy) => [copy.kind, copy.source])
							])
						).toEqual([
							[
								"/Game/UI/WBP_5.WBP_5.WidgetTree.Title",
								[["generated_class", "Play"]]
							],
							[
								"/Game/UI/WBP_5.WBP_5_C.SimpleConstructionScript_0.SCS_Node_0",
								undefined
							],
							[
								"/Game/UI/WBP_5.WBP_5.WidgetTree.Hint",
								[["generated_class", "Press A"]]
							]
						]);

						// One edited Blueprint: the warm path re-encodes its shard from stored
						// folded records and the newly read one.
						version = " now";
						const edited = inventory.map((entry) =>
							entry.path === "Content/UI/Package5.uasset"
								? { ...entry, signature: "edited" }
								: entry
						);
						const warm = yield* Effect.scoped(
							refreshPackageTextLayer({ inventory: edited, read })
						);
						expect(warm.readPackages).toBe(1);
						records = yield* stored;
						expect(records.get("Content/UI/Package5.uasset")).toEqual(
							expected("Content/UI/Package5.uasset")
						);
						version = "";
						expect(records.get("Content/UI/Package10.uasset")).toEqual(
							expected("Content/UI/Package10.uasset")
						);
					})
				).pipe(
					Effect.provide(
						sharedIndexNodeLayer({
							cacheRoot: root,
							projectKey: root,
							targetKey: "copies"
						})
					)
				)
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30000);
});
