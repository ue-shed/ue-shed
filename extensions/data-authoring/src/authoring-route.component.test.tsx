// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import type {
	AuthoringClientShape,
	AuthoringSessionIntent,
	AuthoringSessionView
} from "@ue-shed/authoring-sdk";
import type { AuthoringTableSnapshot } from "@ue-shed/protocol";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AuthoringRoute } from "./authoring-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

const snapshot: AuthoringTableSnapshot = {
	authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Test" },
	completeness: "complete",
	contract: { name: "unreal-authoring", version: { major: 2, minor: 0 } },
	diagnostics: [],
	fingerprint: { algorithm: "sha256", status: "available", value: "fixture", version: 1 },
	producer: { name: "fixture", version: "1" },
	table: {
		kind: "data_table",
		objectPath: "/Game/Fixture/DT_Test.DT_Test",
		packageName: "/Game/Fixture/DT_Test",
		parentTables: [],
		rowStruct: "/Script/Fixture.Row",
		rows: [
			{
				fields: [
					{ name: "Count", typeName: "IntProperty", value: { kind: "int", value: "2" } }
				],
				id: "row:Alpha",
				name: "Alpha"
			},
			{
				fields: [
					{ name: "Count", typeName: "IntProperty", value: { kind: "int", value: "3" } }
				],
				id: "row:Beta",
				name: "Beta"
			}
		],
		schema: {
			fields: [
				{
					annotations: { deprecated: false, readOnly: false },
					defaultValue: { status: "known", value: { kind: "int", value: "0" } },
					editability: { kind: "editable" },
					id: "field:Count",
					name: "Count",
					presence: "required",
					type: { kind: "scalar", valueKind: "int" },
					typeName: "IntProperty"
				}
			],
			source: "saved_package",
			status: "available"
		}
	}
};

const sessionView: AuthoringSessionView = {
	canRedo: false,
	canUndo: true,
	commandCount: 1,
	dirty: true,
	lifecycle: "open",
	pipeline: { canApply: true, kind: "draft" },
	review: {
		activeCommandCount: 1,
		canRedo: false,
		canUndo: true,
		commandGroups: [
			{
				active: true,
				authoredAt: "2026-07-16T00:00:00.000Z",
				commands: [],
				groupId: "gesture-1",
				tableObjectPaths: [snapshot.table.objectPath]
			}
		],
		createdAt: "2026-07-16T00:00:00.000Z",
		lifecycle: "open",
		pipeline: { canApply: true, kind: "draft" },
		project: { id: "fixture", root: "C:/Fixture" },
		sessionId: "session-1",
		tables: [
			{
				base: snapshot,
				changes: [
					{
						fieldName: "Count",
						kind: "cell_changed",
						newValue: { kind: "int", value: "2" },
						oldValue: { kind: "int", value: "1" },
						rowId: "row:Alpha",
						rowName: "Alpha"
					}
				],
				diagnostics: [],
				dirtyCells: [{ fieldName: "Count", rowId: "row:Alpha" }],
				dirtyRowIds: ["row:Alpha"],
				objectPath: snapshot.table.objectPath,
				valid: true,
				working: snapshot
			}
		],
		updatedAt: "2026-07-16T00:00:01.000Z",
		validation: { diagnostics: [], errorCount: 0, valid: true, warningCount: 0 }
	},
	sessionId: "session-1",
	snapshot,
	updatedAt: "2026-07-16T00:00:01.000Z"
};

describe("AuthoringRoute", () => {
	it("keeps the expandable route responsive when table selection is cancelled", async () => {
		let selections = 0;
		const client: AuthoringClientShape = {
			getCatalogProgress: () =>
				Effect.succeed({
					cacheHits: 0,
					phase: "idle" as const,
					processedAssets: 0,
					tablesFound: 0,
					totalAssets: 0
				}),
			applySession: () => Effect.die("unused"),
			beginSession: () => Effect.die("unused"),
			chooseTable: () =>
				Effect.sync(() => {
					selections += 1;
					return { status: "cancelled" as const };
				}),
			editSession: () => Effect.die("unused"),
			discardSession: () => Effect.die("unused"),
			listSessions: () =>
				Effect.succeed({ diagnostics: [], sessions: [], status: "ready" as const }),
			loadConfiguredCatalog: () => Effect.succeed({ status: "not_configured" as const }),
			loadConfiguredTable: () => Effect.succeed({ status: "not_configured" as const }),
			openCatalogTable: () => Effect.die("unused"),
			openSession: () => Effect.die("unused"),
			reconcileSession: () => Effect.die("unused"),
			redoSession: () => Effect.die("unused"),
			reviewSession: () => Effect.die("unused"),
			saveSession: () => Effect.die("unused"),
			undoSession: () => Effect.die("unused")
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<AuthoringRoute client={client} />
			</EffectRuntimeProvider>
		));
		expect(await screen.findByText("Select a project DataTable.")).toBeDefined();
		await userEvent.setup().click(screen.getByRole("button", { name: "Choose .uasset" }));
		expect(
			await screen.findByText("Selection cancelled. The current table was not replaced.")
		).toBeDefined();
		expect(selections).toBe(1);
	});

	it("shows truthful project indexing progress while catalog discovery is pending", async () => {
		const client: AuthoringClientShape = {
			applySession: () => Effect.die("unused"),
			beginSession: () => Effect.die("unused"),
			chooseTable: () => Effect.die("unused"),
			discardSession: () => Effect.die("unused"),
			editSession: () => Effect.die("unused"),
			getCatalogProgress: () =>
				Effect.succeed({
					cacheHits: 1500,
					phase: "scanning" as const,
					processedAssets: 2000,
					tablesFound: 12,
					totalAssets: 10000
				}),
			listSessions: () =>
				Effect.succeed({ diagnostics: [], sessions: [], status: "ready" as const }),
			loadConfiguredCatalog: () => Effect.never,
			loadConfiguredTable: () => Effect.succeed({ status: "not_configured" as const }),
			openCatalogTable: () => Effect.die("unused"),
			openSession: () => Effect.die("unused"),
			reconcileSession: () => Effect.die("unused"),
			redoSession: () => Effect.die("unused"),
			reviewSession: () => Effect.die("unused"),
			saveSession: () => Effect.die("unused"),
			undoSession: () => Effect.die("unused")
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<AuthoringRoute client={client} />
			</EffectRuntimeProvider>
		));

		expect(await screen.findByRole("progressbar")).toBeDefined();
		expect(await screen.findByText("2,000 / 10,000")).toBeDefined();
		expect(screen.getByText("1,500 cached · 12 tables found")).toBeDefined();
	});

	it("stages row intents and presents semantic Session Review", async () => {
		const intents: AuthoringSessionIntent[] = [];
		const client: AuthoringClientShape = {
			getCatalogProgress: () =>
				Effect.succeed({
					cacheHits: 0,
					phase: "ready" as const,
					processedAssets: 19,
					tablesFound: 12,
					totalAssets: 19
				}),
			applySession: () => Effect.succeed({ status: "ready" as const, view: sessionView }),
			beginSession: () => Effect.succeed({ status: "ready" as const, view: sessionView }),
			chooseTable: () => Effect.succeed({ snapshot, status: "ready" as const }),
			discardSession: () =>
				Effect.succeed({ diagnostics: [], sessions: [], status: "ready" as const }),
			editSession: (intent) =>
				Effect.sync(() => {
					intents.push(intent);
					return { status: "ready" as const, view: sessionView };
				}),
			listSessions: () =>
				Effect.succeed({
					diagnostics: [],
					sessions: [
						{
							commandCount: 1,
							createdAt: sessionView.review.createdAt,
							id: sessionView.sessionId,
							lifecycle: "open" as const,
							tableObjectPaths: [snapshot.table.objectPath],
							undoPointer: 1,
							updatedAt: sessionView.updatedAt
						}
					],
					status: "ready" as const
				}),
			loadConfiguredCatalog: () =>
				Effect.succeed({
					diagnostics: [],
					status: "ready" as const,
					tables: [
						{
							authorities: ["saved" as const],
							completeness: "complete" as const,
							divergence: [],
							kind: "data_table" as const,
							objectPath: snapshot.table.objectPath,
							parentTables: [],
							rowStruct: snapshot.table.rowStruct
						}
					]
				}),
			loadConfiguredTable: () => Effect.succeed({ snapshot, status: "ready" as const }),
			openCatalogTable: () => Effect.succeed({ snapshot, status: "ready" as const }),
			openSession: () => Effect.succeed({ status: "ready" as const, view: sessionView }),
			reconcileSession: () => Effect.succeed({ status: "ready" as const, view: sessionView }),
			redoSession: () => Effect.succeed({ status: "ready" as const, view: sessionView }),
			reviewSession: () =>
				Effect.succeed({ review: sessionView.review, status: "ready" as const }),
			saveSession: () => Effect.succeed({ status: "ready" as const, view: sessionView }),
			undoSession: () => Effect.succeed({ status: "ready" as const, view: sessionView })
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<AuthoringRoute client={client} />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "+ Row" }));
		const rowName = screen.getByRole("textbox", { name: "Unreal row name" });
		await user.clear(rowName);
		await user.type(rowName, "Bravo");
		await user.click(screen.getByRole("button", { name: "Stage row" }));
		expect(intents).toContainEqual({
			atIndex: 2,
			kind: "add_row",
			rowName: "Bravo",
			sessionId: "session-1",
			tableObjectPath: snapshot.table.objectPath
		});
		await user.click(screen.getByRole("button", { name: "Duplicate" }));
		await user.click(screen.getByRole("button", { name: "Stage row" }));
		expect(intents).toContainEqual({
			atIndex: 1,
			kind: "duplicate_row",
			rowName: "AlphaCopy",
			sessionId: "session-1",
			sourceRowId: "row:Alpha",
			tableObjectPath: snapshot.table.objectPath
		});
		await user.click(screen.getByRole("button", { name: "Rename" }));
		const renamed = screen.getByRole("textbox", { name: "Unreal row name" });
		await user.clear(renamed);
		await user.type(renamed, "AlphaRenamed");
		await user.click(screen.getByRole("button", { name: "Stage row" }));
		expect(intents).toContainEqual({
			kind: "rename_row",
			rowId: "row:Alpha",
			rowName: "AlphaRenamed",
			sessionId: "session-1",
			tableObjectPath: snapshot.table.objectPath
		});
		await user.click(screen.getByRole("button", { name: "Move selected row down" }));
		expect(intents).toContainEqual({
			kind: "reorder_rows",
			rowIds: ["row:Beta", "row:Alpha"],
			sessionId: "session-1",
			tableObjectPath: snapshot.table.objectPath
		});
		const deleteConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		expect(intents).toContainEqual({
			kind: "remove_row",
			rowId: "row:Alpha",
			sessionId: "session-1",
			tableObjectPath: snapshot.table.objectPath
		});
		deleteConfirm.mockRestore();
		await user.click(screen.getByRole("button", { name: "Review 1" }));
		expect(await screen.findByText("Alpha.Count")).toBeDefined();
		expect(screen.getByText("1 → 2")).toBeDefined();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		await user.click(screen.getByRole("button", { name: "Reload preset" }));
		expect(confirm).toHaveBeenCalled();
		expect(screen.getByText(snapshot.table.objectPath)).toBeDefined();
		confirm.mockRestore();
	});
});
