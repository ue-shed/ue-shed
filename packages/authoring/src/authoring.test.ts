import type { AuthoringTableSnapshot } from "@ue-shed/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	DraftFoldError,
	appendCommandGroup,
	decodeDraftSession,
	fingerprintTable,
	foldTable,
	invertCommand,
	redo,
	undo,
	type CommandEnvelope,
	type DraftSession
} from "./index.js";

function snapshot(authority: AuthoringTableSnapshot["authority"]): AuthoringTableSnapshot {
	return {
		contract: { name: "unreal-authoring", version: { major: 1, minor: 0 } },
		authority,
		completeness: "complete",
		diagnostics: [],
		table: {
			kind: "data_table",
			objectPath: "/Game/Fixture/DT_Test.DT_Test",
			parentTables: [],
			rowStruct: "/Script/Fixture.Row",
			rows: [
				{
					fields: [
						{
							name: "Count",
							typeName: "IntProperty",
							value: { kind: "int", value: "1" }
						}
					],
					id: "row:Alpha",
					name: "Alpha"
				}
			]
		}
	};
}

function envelope(id: string, groupId: string, body: CommandEnvelope["body"]): CommandEnvelope {
	return {
		authoredAt: "2026-07-14T00:00:00.000Z",
		baseFingerprint: "sha256-v1:base",
		body,
		groupId,
		id,
		tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
	};
}

describe("semantic fingerprints", () => {
	it("matches saved and live authorities with identical semantic state", () => {
		const saved = snapshot({ kind: "project_files", packageName: "/Game/Fixture/DT_Test" });
		const live = snapshot({
			kind: "live_editor",
			producerId: "producer",
			sessionId: "session"
		});
		expect(fingerprintTable(saved)).toBe(fingerprintTable(live));
	});
});

describe("draft command log", () => {
	it("folds rename then cell edit by stable row identity", () => {
		const base = snapshot({ kind: "project_files", packageName: "/Game/Fixture/DT_Test" });
		const commands = [
			envelope("1", "rename-and-edit", {
				kind: "rename_row",
				newName: "Beta",
				oldName: "Alpha",
				rowId: "row:Alpha"
			}),
			envelope("2", "rename-and-edit", {
				fieldName: "Count",
				kind: "set_cell",
				newValue: { kind: "int", value: "2" },
				oldValue: { kind: "int", value: "1" },
				rowId: "row:Alpha"
			})
		];
		const working = foldTable(base, commands);
		expect(working.table.rows[0]).toMatchObject({
			name: "Beta",
			fields: [{ value: { kind: "int", value: "2" } }]
		});
	});

	it("undoes and redoes one command group atomically", () => {
		const base = snapshot({ kind: "project_files", packageName: "/Game/Fixture/DT_Test" });
		const initial: DraftSession = {
			applyReceipts: [],
			awaitingSave: [],
			base: { [base.table.objectPath]: base },
			commands: [],
			fingerprints: { [base.table.objectPath]: fingerprintTable(base) },
			id: "draft",
			saveReceipts: [],
			undoPointer: 0,
			version: 2
		};
		const commands = [
			envelope("1", "gesture", {
				kind: "rename_row",
				newName: "Beta",
				oldName: "Alpha",
				rowId: "row:Alpha"
			}),
			envelope("2", "gesture", {
				fieldName: "Count",
				kind: "set_cell",
				newValue: { kind: "int", value: "2" },
				oldValue: { kind: "int", value: "1" },
				rowId: "row:Alpha"
			})
		];
		const appended = appendCommandGroup(initial, commands);
		expect(undo(appended).undoPointer).toBe(0);
		expect(redo(undo(appended)).undoPointer).toBe(2);
	});

	it("fails instead of silently skipping a structurally invalid command", () => {
		const base = snapshot({ kind: "project_files", packageName: "/Game/Fixture/DT_Test" });
		expect(() =>
			foldTable(base, [
				envelope("bad", "gesture", {
					fieldName: "Count",
					kind: "set_cell",
					newValue: { kind: "int", value: "2" },
					oldValue: { kind: "int", value: "1" },
					rowId: "row:Missing"
				})
			])
		).toThrow(DraftFoldError);
	});

	it("inverts all five canonical command kinds from captured data", () => {
		const row = snapshot({ kind: "project_files", packageName: "/Game/Fixture/DT_Test" }).table
			.rows[0]!;
		expect(
			invertCommand({
				fieldName: "Count",
				kind: "set_cell",
				newValue: { kind: "int", value: "2" },
				oldValue: { kind: "int", value: "1" },
				rowId: row.id
			})
		).toMatchObject({ newValue: { value: "1" }, oldValue: { value: "2" } });
		expect(invertCommand({ atIndex: 0, kind: "add_row", row }).kind).toBe("remove_row");
		expect(invertCommand({ atIndex: 0, kind: "remove_row", row }).kind).toBe("add_row");
		expect(
			invertCommand({ kind: "rename_row", newName: "B", oldName: "A", rowId: row.id })
		).toMatchObject({ newName: "A", oldName: "B" });
		expect(
			invertCommand({ kind: "reorder_rows", newOrder: ["b", "a"], oldOrder: ["a", "b"] })
		).toMatchObject({ newOrder: ["a", "b"], oldOrder: ["b", "a"] });
	});

	it("migrates version 1 sessions with an empty Save receipt history", () => {
		const base = snapshot({ kind: "project_files", packageName: "/Game/Fixture/DT_Test" });
		const migrated = Effect.runSync(
			decodeDraftSession({
				applyReceipts: [],
				awaitingSave: [],
				base: { [base.table.objectPath]: base },
				commands: [],
				fingerprints: { [base.table.objectPath]: fingerprintTable(base) },
				id: "legacy",
				undoPointer: 0,
				version: 1
			})
		);
		expect(migrated.version).toBe(2);
		expect(migrated.saveReceipts).toEqual([]);
	});
});
