import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { mountPackageTextEvent, mountedPackageName } from "./package-object-path.js";

// Absolute on every host: package files may be absolute or relative to the project.
const root = resolve("Projects", "Game");

describe("package object paths", () => {
	it("names a Content package as Unreal mounts it, and nothing else", () => {
		expect(mountedPackageName(root, "Content/Data/DT_Items.uasset")).toBe(
			"/Game/Data/DT_Items"
		);
		expect(mountedPackageName(root, join(root, "Content", "Maps", "L_Main.umap"))).toBe(
			"/Game/Maps/L_Main"
		);
		expect(mountedPackageName(root, "Plugins/Tool/Content/T.uasset")).toBeUndefined();
		expect(mountedPackageName(root, "Content/Data/DT_Items.uexp")).toBeUndefined();
	});

	it("completes package-relative paths in occurrences and gap samples, once", () => {
		const record: SavedAssetPackageTextRecord = {
			...emptyPackageTextRecord("Content/Data/DT_Items.uasset"),
			status: "partial",
			occurrences: [
				{
					source: "Sword",
					dev_notes: "",
					identity: { status: "resolved", namespace: "Items", key: "Sword" },
					location: {
						kind: "data_table_cell",
						object_path: "DT_Items",
						row: "Sword",
						property_path: "Name"
					},
					edit_capability: "source_editable"
				},
				{
					source: "Title",
					dev_notes: "",
					identity: { status: "unresolved", reason: "culture_invariant" },
					location: {
						kind: "asset_property",
						object_path: "DT_Items:Preview",
						class_path: "DT_Items_C",
						property_path: "Title"
					},
					edit_capability: "read_only"
				}
			],
			gapSamples: [
				{
					object_path: "DT_Items",
					property_path: "Notes",
					reason: "unsupported_text_history"
				}
			]
		};
		const mounted = mountPackageTextEvent(root, record);
		expect(mounted).toMatchObject({
			occurrences: [
				{ location: { object_path: "/Game/Data/DT_Items.DT_Items" } },
				{
					location: {
						object_path: "/Game/Data/DT_Items.DT_Items:Preview",
						class_path: "/Game/Data/DT_Items.DT_Items_C"
					}
				}
			],
			gapSamples: [{ object_path: "/Game/Data/DT_Items.DT_Items" }]
		});
		expect(mountPackageTextEvent(root, mounted)).toBe(mounted);
	});

	it("leaves saved full paths and files outside Content as they are", () => {
		const occurrence = {
			source: "Menu",
			dev_notes: "",
			identity: { status: "resolved", namespace: "UI", key: "Menu" },
			location: {
				kind: "asset_property",
				object_path: "/Game/UI/Menu.Menu",
				class_path: "/Script/Engine.DataAsset",
				property_path: "Label"
			},
			edit_capability: "read_only"
		} as const;
		const full = {
			...emptyPackageTextRecord("Content/UI/Menu.uasset"),
			occurrences: [occurrence]
		};
		expect(mountPackageTextEvent(root, full)).toBe(full);
		const outside = {
			...emptyPackageTextRecord("Plugins/Tool/Content/Menu.uasset"),
			occurrences: [
				{ ...occurrence, location: { ...occurrence.location, object_path: "Menu" } }
			]
		};
		expect(mountPackageTextEvent(root, outside)).toBe(outside);
	});

	it("completes streamed occurrences and coverage gaps", () => {
		expect(
			mountPackageTextEvent(root, {
				event: "text_occurrence",
				schema_version: 1,
				path: "Content/Text/ST_Menu.uasset",
				fileBytes: 0,
				occurrence: {
					source: "Play",
					dev_notes: "",
					identity: { status: "resolved", namespace: "Menu", key: "Play" },
					location: {
						kind: "string_table_entry",
						object_path: "ST_Menu",
						entry_key: "Play"
					},
					edit_capability: "source_editable"
				}
			})
		).toMatchObject({
			occurrence: { location: { object_path: "/Game/Text/ST_Menu.ST_Menu" } }
		});
		expect(
			mountPackageTextEvent(root, {
				event: "text_coverage_gap",
				schema_version: 1,
				path: "Content/Text/ST_Menu.uasset",
				coverage_gap: {
					object_path: "ST_Menu",
					property_path: "Entries",
					reason: "property_decoder_rejected"
				}
			})
		).toMatchObject({ coverage_gap: { object_path: "/Game/Text/ST_Menu.ST_Menu" } });
	});

	describe("a package moved or copied outside Unreal", () => {
		// The summary still names the folder the corpus generator saved the table in.
		const saved = "/Game/Developers/Ryzen/GameTextCorpus/DataTables/DT_Tutorial_040";
		const file = "Content/Moved/DT_Tutorial_040.uasset";
		const moved: SavedAssetPackageTextRecord = {
			...emptyPackageTextRecord(file),
			packageName: saved,
			occurrences: [
				{
					source: "Press jump",
					dev_notes: "",
					identity: { status: "resolved", namespace: "Tutorial", key: "Jump" },
					location: {
						kind: "data_table_cell",
						object_path: `${saved}.DT_Tutorial_040`,
						row: "Jump",
						property_path: "DisplayName_2_1F2E3D4C5B6A79808F9EADBCCBDAE9F8"
					},
					edit_capability: "source_editable"
				},
				{
					source: "Hint",
					dev_notes: "",
					identity: {
						status: "string_table",
						table_id: "/Game/Text/ST_Hints.ST_Hints",
						key: "Hint"
					},
					location: {
						kind: "asset_property",
						object_path: `${saved}.DT_Tutorial_040:Preview.Widget`,
						class_path: `${saved}.DT_Tutorial_040_C`,
						property_path: "Text"
					},
					edit_capability: "read_only"
				},
				{
					source: "Sign",
					dev_notes: "",
					identity: { status: "resolved", namespace: "World", key: "Sign" },
					location: {
						kind: "asset_property",
						// Another package's object: not this package's to move.
						object_path: "/Game/Maps/L_World.L_World:PersistentLevel.Sign",
						class_path: "/Script/Engine.TextRenderActor",
						property_path: "Text"
					},
					edit_capability: "read_only"
				}
			],
			gapSamples: [
				{
					object_path: `${saved}.DT_Tutorial_040`,
					property_path: "Notes",
					reason: "unsupported_text_history"
				}
			],
			blueprintClasses: [
				{
					blueprint: `${saved}.DT_Tutorial_040`,
					generatedClass: `${saved}.DT_Tutorial_040_C`,
					classDefault: `${saved}.Default__DT_Tutorial_040_C`
				}
			]
		};

		it("moves the package's own paths to the file's package and keeps the saved name", () => {
			const mounted = mountPackageTextEvent(root, moved);
			const at = "/Game/Moved/DT_Tutorial_040";
			expect(mounted).toEqual({
				...moved,
				occurrences: [
					{
						...moved.occurrences[0],
						location: {
							...moved.occurrences[0]!.location,
							object_path: `${at}.DT_Tutorial_040`
						}
					},
					{
						...moved.occurrences[1],
						location: {
							...moved.occurrences[1]!.location,
							object_path: `${at}.DT_Tutorial_040:Preview.Widget`,
							class_path: `${at}.DT_Tutorial_040_C`
						}
					},
					moved.occurrences[2]
				],
				gapSamples: [{ ...moved.gapSamples[0], object_path: `${at}.DT_Tutorial_040` }],
				blueprintClasses: [
					{
						blueprint: `${at}.DT_Tutorial_040`,
						generatedClass: `${at}.DT_Tutorial_040_C`,
						classDefault: `${at}.Default__DT_Tutorial_040_C`
					}
				]
			});
			expect(mounted).toMatchObject({ packageName: saved });
			expect(mountPackageTextEvent(root, mounted)).toBe(mounted);
		});

		it("completes UE 4.27 `None` packages under the file's package too", () => {
			const legacy: SavedAssetPackageTextRecord = {
				...emptyPackageTextRecord(file),
				packageName: "None",
				occurrences: [
					{
						...moved.occurrences[0]!,
						location: {
							kind: "data_table_cell",
							object_path: "DT_Tutorial_040",
							row: "Jump",
							property_path: "Text"
						}
					}
				]
			};
			expect(mountPackageTextEvent(root, legacy)).toMatchObject({
				packageName: "None",
				occurrences: [
					{ location: { object_path: "/Game/Moved/DT_Tutorial_040.DT_Tutorial_040" } }
				]
			});
		});

		it("leaves packages whose saved name matches, or is unknown, as read", () => {
			const inPlace = {
				...moved,
				path: "Content/Developers/Ryzen/GameTextCorpus/DataTables/DT_Tutorial_040.uasset"
			};
			expect(mountPackageTextEvent(root, inPlace)).toBe(inPlace);
			// Readers before uasset-io 1.17 omit the name; their paths cannot be told apart.
			const { packageName: _, ...older } = moved;
			expect(mountPackageTextEvent(root, older)).toBe(older);
		});
	});
});
