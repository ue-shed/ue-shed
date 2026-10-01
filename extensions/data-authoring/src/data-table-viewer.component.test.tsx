// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider, MAX_ASSET_FILE_BYTES } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataTableViewer } from "./data-table-viewer.js";
import { FileDataTableOpener } from "./file-data-table-opener.js";
import { AuthoringTableGrid } from "./authoring-table-grid.js";
import type { AuthoringColumn } from "./authoring-view.js";
import { viewerRead } from "./viewer-fixture.test-support.js";

const editableCountColumn: AuthoringColumn = {
	name: "Count",
	typeName: "IntProperty",
	descriptor: {
		id: "field:Count",
		name: "Count",
		typeName: "IntProperty",
		presence: "required",
		type: { kind: "scalar", valueKind: "int" },
		annotations: { deprecated: false, readOnly: false },
		defaultValue: { status: "unknown" },
		editability: { kind: "editable" }
	}
};

const runtime = ManagedRuntime.make(Layer.empty);
beforeEach(() => {
	// jsdom supplies no layout. Give the real spreadsheet virtualizers a measurable viewport.
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
		new DOMRect(0, 0, 800, 480)
	);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(480);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
afterAll(() => runtime.dispose());

function mount(read = viewerRead) {
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<DataTableViewer
				initialRead={Effect.succeed(read)}
				opener={(controls) => (
					<FileDataTableOpener
						controls={controls}
						readFile={() => Effect.succeed(viewerRead)}
					/>
				)}
			/>
		</EffectRuntimeProvider>
	));
}

describe("read-only Data Tables shell", () => {
	it("renders compact summary, filters rows, selects a value, and toggles Patterns", async () => {
		mount();
		const summary = await screen.findByRole("region", { name: "Table summary" });
		await screen.findByRole("heading", { name: "DT_Scalars" });
		expect(summary.textContent).toContain("2 rows · 2 fields");
		expect(summary.textContent).toContain("Fully decoded");
		expect(within(summary).getByText("DataTable")).toBeTruthy();
		expect(screen.getByText("Read-only · no Unreal required")).toBeTruthy();
		const grid = screen.getByRole("region", { name: "Table grid" });
		expect(within(grid).getByRole("rowheader", { name: "Scalar_Alpha" })).toBeTruthy();
		expect(within(grid).getByRole("rowheader", { name: "Scalar_Beta" })).toBeTruthy();
		const user = userEvent.setup();
		const rowName = within(grid).getByRole("gridcell", { name: "Scalar_Alpha" });
		expect(rowName.getAttribute("aria-readonly")).toBe("true");
		await user.click(within(grid).getByRole("rowheader", { name: "Scalar_Alpha" }));
		expect(screen.getByRole("region", { name: "Cell inspector" }).textContent).toContain(
			"row:Scalar_Alpha"
		);
		const firstCell = await screen.findByRole("gridcell", { name: "12" });
		expect(firstCell.getAttribute("aria-readonly")).toBe("true");
		await user.click(firstCell);
		const inspector = screen.getByRole("region", { name: "Cell inspector" });
		expect(inspector.textContent).toContain("Count");
		expect(inspector.textContent).toContain("Scalar_Alpha");
		expect(within(inspector).getByText("12")).toBeTruthy();
		expect(within(inspector).getByText("row:Scalar_Alpha")).toBeTruthy();
		expect(within(inspector).getByText("IntProperty")).toBeTruthy();
		expect(within(inspector).queryByText("Saved package")).toBeNull();
		expect(
			screen.getByRole("searchbox", { name: "Filter rows" }).getAttribute("placeholder")
		).toBe("Filter rows…");
		await user.type(screen.getByRole("searchbox", { name: "Filter rows" }), "Beta");
		expect(screen.queryByRole("gridcell", { name: "12" })).toBeNull();
		expect(within(grid).queryByRole("rowheader", { name: "Scalar_Alpha" })).toBeNull();
		expect(within(grid).getByRole("rowheader", { name: "Scalar_Beta" })).toBeTruthy();
		expect(screen.getByRole("gridcell", { name: "24" })).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Charts" }));
		expect(screen.getByRole("heading", { name: "Patterns in DT_Scalars" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "Table grid" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Grid" }));
		expect(screen.getByRole("region", { name: "Table grid" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Add row|Delete row|Apply|Save/ })).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("shows partial/composite evidence and unresolved row handles as quiet values", async () => {
		mount({
			...viewerRead,
			outcome: "partial",
			diagnostics: [
				{ code: "asset_resource_limit", message: "Partial", severity: "warning" }
			],
			snapshot: {
				...viewerRead.snapshot,
				completeness: "partial",
				table: {
					...viewerRead.snapshot.table,
					kind: "composite_data_table",
					parentTables: ["/Game/Fixture/DT_Parent.DT_Parent"],
					rows: [
						{
							id: "row:Link",
							name: "Link",
							fields: [
								{
									name: "Target",
									typeName: "StructProperty",
									value: {
										kind: "row_reference",
										rowName: "Alpha",
										tableObjectPath: "/Game/Fixture/DT_Target.DT_Target"
									}
								}
							]
						}
					]
				}
			}
		});
		await screen.findByRole("gridcell", { name: /DT_Target.*Alpha/ });
		expect(screen.getByText("Composite DataTable")).toBeTruthy();
		expect(screen.getByText("DT_Parent").getAttribute("title")).toBe(
			"/Game/Fixture/DT_Parent.DT_Parent"
		);
		expect(screen.getByText("Partial · 1")).toBeTruthy();
		await userEvent.setup().click(screen.getByRole("gridcell", { name: /DT_Target.*Alpha/ }));
		expect(screen.getByText("Referenced table not loaded")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("opens samples and drops, rejects oversized files, and exposes typed failure actions", async () => {
		const readFile = vi.fn(() => Effect.succeed(viewerRead));
		const sample = vi.fn(() => Effect.succeed(viewerRead));
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<DataTableViewer
					opener={(controls) => (
						<FileDataTableOpener
							controls={controls}
							readFile={readFile}
							sample={{ label: "Try the sample DataTable", load: sample }}
						/>
					)}
				/>
			</EffectRuntimeProvider>
		));
		const file = new File(["bytes"], "TooLarge.uasset");
		Object.defineProperty(file, "size", { value: MAX_ASSET_FILE_BYTES + 1 });
		fireEvent.change(screen.getByLabelText("Choose a DataTable .uasset"), {
			target: { files: [file] }
		});
		expect(screen.getByRole("alert").textContent).toContain("64 MiB");
		expect(readFile).not.toHaveBeenCalled();
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Try the sample DataTable" }));
		await screen.findByRole("heading", { name: "DT_Scalars" });
		expect(sample).toHaveBeenCalledOnce();
		const dropped = new File(["bytes"], "DT_Dropped.uasset");
		fireEvent.drop(screen.getByRole("main"), {
			dataTransfer: { files: [dropped], types: ["Files"] }
		});
		expect(readFile).toHaveBeenCalledWith(dropped);
		await screen.findByRole("heading", { name: "DT_Scalars" });
		cleanup();
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<DataTableViewer
					opener={() => <span>Opener</span>}
					initialRead={Effect.succeed({
						status: "failed",
						reason: "unsupported_asset",
						message: "No DataTable",
						recovery: "Choose a DataTable"
					})}
					failureActions={() => <a href="/inspect">Inspect this file instead</a>}
				/>
			</EffectRuntimeProvider>
		));
		const alert = await screen.findByRole("alert");
		expect(within(alert).getByRole("link", { name: "Inspect this file instead" })).toBeTruthy();
	});

	it("marks cells read-only even when reflection says a column is editable", async () => {
		render(() => (
			<AuthoringTableGrid
				readOnly
				rows={viewerRead.snapshot.table.rows}
				columns={[editableCountColumn]}
			/>
		));
		const firstCell = await screen.findByRole("gridcell", { name: "12" });
		expect(firstCell.getAttribute("aria-readonly")).toBe("true");
	});

	it("renders read-only row names and maps field selection to the inspector", async () => {
		const onSelection = vi.fn();
		render(() => (
			<AuthoringTableGrid
				rows={viewerRead.snapshot.table.rows}
				columns={[editableCountColumn]}
				onSelectionChange={onSelection}
			/>
		));
		const user = userEvent.setup();
		const name = await screen.findByRole("rowheader", { name: "Scalar_Alpha" });
		expect(name.getAttribute("aria-readonly")).toBe("true");
		await user.click(name);
		expect(onSelection).toHaveBeenLastCalledWith({
			fieldName: "Count",
			rowId: "row:Scalar_Alpha"
		});
		const count = screen.getByRole("gridcell", { name: "12" });
		expect(count.getAttribute("aria-readonly")).toBe("false");
		await user.click(count);
		expect(onSelection).toHaveBeenLastCalledWith({
			fieldName: "Count",
			rowId: "row:Scalar_Alpha"
		});
	});

	it("renders a visible edited marker only on dirty row names", async () => {
		render(() => (
			<AuthoringTableGrid
				rows={viewerRead.snapshot.table.rows}
				columns={[editableCountColumn]}
				dirtyRowIds={["row:Scalar_Alpha"]}
				dirtyCells={[{ fieldName: "Count", rowId: "row:Scalar_Alpha" }]}
			/>
		));
		const alpha = await screen.findByRole("rowheader", { name: "Scalar_Alpha" });
		expect(within(alpha).getByText("edited")).toBeTruthy();
		const beta = screen.getByRole("rowheader", { name: "Scalar_Beta" });
		expect(within(beta).queryByText("edited")).toBeNull();
	});
});
