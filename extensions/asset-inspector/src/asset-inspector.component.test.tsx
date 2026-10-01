import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AssetInspector } from "./asset-inspector.js";
import { FileAssetOpener } from "./file-asset-opener.js";
import {
	dataTable,
	generic,
	readyInspection,
	skeleton,
	stringTable
} from "./inspection.test-support.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

function mount<Asset>(assets: readonly Asset[], link = false) {
	const read = readyInspection(assets);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<AssetInspector
				opener={(controls) => (
					<FileAssetOpener controls={controls} readFile={() => Effect.succeed(read)} />
				)}
				initialRead={Effect.succeed(read)}
				relatedViews={() =>
					link
						? [
								{
									kind: "action",
									label: "Open in Blueprint viewer",
									href: "/blueprints",
									description: "2 graphs · 6 nodes"
								}
							]
						: []
				}
			/>
		</EffectRuntimeProvider>
	));
}

describe("asset inspector", () => {
	it("renders string table namespace, entries, and header statistics", async () => {
		mount([stringTable]);
		const table = await screen.findByRole("table", { name: "String table entries" });
		expect(table.textContent).toContain("Greeting");
		expect(table.textContent).toContain("Hello fixture");
		expect(screen.getByText("Namespace: Fixture.Text")).toBeDefined();
		expect(screen.getByRole("region", { name: "Asset summary" }).textContent).toContain(
			"12 names"
		);
		expect(screen.queryByRole("link", { name: "Open in Blueprint viewer" })).toBeNull();
		const summary = screen.getByRole("region", { name: "Asset summary" });
		expect(summary.textContent).toContain("Fully decoded");
		expect(summary.textContent).toContain("1.0 KB");
		expect(summary.textContent).not.toContain("Licensee 0");
		expect(within(summary).getByRole("button", { name: "Open another .uasset" })).toBeDefined();
	});

	it("derives DataTable columns across rows and filters decoded values", async () => {
		mount([dataTable]);
		const table = await screen.findByRole("table", { name: "DataTable rows" });
		expect(
			within(table).getByRole("columnheader", { name: "Count IntProperty" })
		).toBeDefined();
		expect(
			within(table).getByRole("columnheader", { name: "Ratio FloatProperty" })
		).toBeDefined();
		expect(table.textContent).toContain("Alpha");
		fireEvent.input(screen.getByRole("searchbox"), { target: { value: "0.5" } });
		await waitFor(() => expect(table.textContent).not.toContain("Alpha"));
		expect(table.textContent).toContain("Beta");
	});

	it("renders the skeleton hierarchy with compact index suffixes", async () => {
		mount([skeleton]);
		const table = await screen.findByRole("table", { name: "Skeleton bones" });
		expect(table.textContent).toContain("Root");
		expect(table.textContent).toContain("Spine");
		expect(table.textContent).toContain("Root · 0");
		expect(table.textContent).toContain("Spine · 1");
		expect(within(table).getAllByRole("columnheader")).toHaveLength(1);
	});

	it("renders typed values and expands nested matching evidence without JSON", async () => {
		mount([generic]);
		await screen.findByRole("region", { name: "Asset summary" });
		expect(screen.getByText("Saved title (base · Fixture / Title)")).toBeDefined();
		expect(screen.getByText("/Game/Owner.Owner")).toBeDefined();
		expect(screen.getByText("12 opaque bytes · unsupported native layout")).toBeDefined();
		expect(screen.queryByText("NestedName")).toBeNull();
		fireEvent.input(screen.getByRole("searchbox"), { target: { value: "nestedname" } });
		await screen.findByText("NestedName");
		expect(screen.queryByText("Saved title (base · Fixture / Title)")).toBeNull();
		fireEvent.input(screen.getByRole("searchbox"), { target: { value: "mapkey" } });
		await screen.findByText("MapKey");
	});

	it("renders a Blueprint action in the summary with an exact accessible name", async () => {
		mount([generic], true);
		const link = await screen.findByRole("link", { name: "Open in Blueprint viewer" });
		expect(link.getAttribute("href")).toBe("/blueprints");
		expect(link.getAttribute("title")).toBe("2 graphs · 6 nodes");
		expect(link.textContent).toContain("→");
		expect(screen.getByRole("region", { name: "Asset summary" }).contains(link)).toBe(true);
	});

	it("mounts nested values on expansion and releases them on collapse", async () => {
		mount([generic]);
		const label = await screen.findByText("Settings");
		const details = label.closest("details");
		if (!(details instanceof HTMLDetailsElement))
			throw new Error("Expected property disclosure");
		expect(screen.queryByText("Items")).toBeNull();
		details.open = true;
		details.dispatchEvent(new Event("toggle"));
		await screen.findByText("Items");
		details.open = false;
		details.dispatchEvent(new Event("toggle"));
		await waitFor(() => expect(screen.queryByText("Items")).toBeNull());
	});

	it("makes table limits explicit and searches beyond the initial display cap", async () => {
		mount([
			{
				...dataTable,
				row_count: 205,
				rows: Array.from({ length: 205 }, (_, index) => ({
					name: `Row_${index}`,
					properties: []
				}))
			}
		]);
		const table = await screen.findByRole("table", { name: "DataTable rows" });
		expect(within(table).getAllByRole("row").length).toBe(201);
		expect(screen.getByText("Showing the first 200 of 205 matching rows.")).toBeDefined();
		fireEvent.input(screen.getByRole("searchbox"), { target: { value: "Row_204" } });
		await waitFor(() => expect(table.textContent).toContain("Row_204"));
		expect(within(table).getAllByRole("row").length).toBe(2);
	});

	it("shows no related-view UI for non-Blueprints", async () => {
		mount([stringTable]);
		await screen.findByRole("table", { name: "String table entries" });
		expect(screen.queryByText("Related views")).toBeNull();
		expect(screen.queryByText(/No graph view/)).toBeNull();
		expect(screen.queryByRole("link", { name: "Open in Blueprint viewer" })).toBeNull();
	});

	it("hides both export navigators for a single export", async () => {
		mount([dataTable]);
		await screen.findByRole("table", { name: "DataTable rows" });
		expect(screen.queryByRole("navigation", { name: "Exports" })).toBeNull();
		expect(screen.queryByLabelText("Choose an export")).toBeNull();
		expect(screen.queryByRole("heading", { name: "Properties" })).toBeNull();
		expect(screen.queryByText("No matching tagged properties.")).toBeNull();
	});

	it("selects the primary export first and changes detail through the navigator", async () => {
		mount([generic, stringTable]);
		await screen.findByRole("table", { name: "String table entries" });
		const navigator = screen.getByRole("navigation", { name: "Exports" });
		const buttons = within(navigator).getAllByRole("button");
		expect(buttons[0]?.textContent).toContain("Test");
		expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
		expect(screen.queryByRole("region", { name: generic.object_path })).toBeNull();
		fireEvent.click(within(navigator).getByRole("button", { name: /Object.*Object.*props/ }));
		await screen.findByRole("region", { name: generic.object_path });
		expect(screen.queryByRole("table", { name: "String table entries" })).toBeNull();
		expect(screen.getByText("Saved title (base · Fixture / Title)")).toBeDefined();
		fireEvent.change(screen.getByLabelText("Choose an export"), {
			target: { value: stringTable.object_path }
		});
		await screen.findByRole("table", { name: "String table entries" });
	});

	it("narrows the export navigator and searches within the selected detail", async () => {
		mount([generic, stringTable]);
		await screen.findByRole("table", { name: "String table entries" });
		fireEvent.input(screen.getByRole("searchbox"), { target: { value: "NestedName" } });
		await screen.findByText("NestedName");
		const navigator = screen.getByRole("navigation", { name: "Exports" });
		expect(within(navigator).getAllByRole("button")).toHaveLength(1);
		expect(screen.queryByRole("table", { name: "String table entries" })).toBeNull();
		fireEvent.input(screen.getByRole("searchbox"), { target: { value: "missing evidence" } });
		await screen.findByText("No matching decoded assets.");
	});

	it("shows DataTable types once in headers and keeps cells plain", async () => {
		mount([dataTable]);
		const table = await screen.findByRole("table", { name: "DataTable rows" });
		expect(within(table).getAllByText("IntProperty")).toHaveLength(1);
		expect(within(table).getAllByText("FloatProperty")).toHaveLength(1);
		const alpha = within(table).getByRole("row", { name: /Alpha/ });
		expect(within(alpha).getByText("7")).toBeDefined();
		expect(alpha.textContent).not.toContain("IntProperty");
		expect(alpha.textContent).not.toContain("int");
	});

	it("derives a column type from the first non-null value", async () => {
		mount([
			{
				...dataTable,
				rows: [
					{
						name: "Empty",
						properties: [
							{
								name: "Value",
								type: "UnknownProperty",
								value_kind: "float",
								value: null
							}
						]
					},
					{
						name: "Number",
						properties: [
							{
								name: "Value",
								type: "FloatProperty",
								value_kind: "float",
								value: 0.5
							}
						]
					}
				]
			}
		]);
		const table = await screen.findByRole("table", { name: "DataTable rows" });
		expect(
			within(table).getByRole("columnheader", { name: "Value FloatProperty" })
		).toBeDefined();
		expect(within(table).queryByText("UnknownProperty")).toBeNull();
	});

	it("omits the string table notes column when every note is empty", async () => {
		mount([stringTable]);
		const table = await screen.findByRole("table", { name: "String table entries" });
		expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
		expect(within(table).queryByRole("columnheader", { name: "Developer notes" })).toBeNull();
	});

	it("keeps the notes column when a string table entry has a note", async () => {
		mount([
			{
				...stringTable,
				string_table_entries: [
					{ key: "Greeting", source: "Hello", dev_notes: "Menu greeting" }
				]
			}
		]);
		const table = await screen.findByRole("table", { name: "String table entries" });
		expect(within(table).getByRole("columnheader", { name: "Developer notes" })).toBeDefined();
		expect(within(table).getByText("Menu greeting")).toBeDefined();
	});

	it("offers samples as small named buttons without a sample select", () => {
		const read = readyInspection([stringTable]);
		const open = vi.fn();
		const load = vi.fn(() => Effect.succeed(read));
		render(() => (
			<FileAssetOpener
				controls={{ open, loading: false, hasInspection: false }}
				readFile={() => Effect.succeed(read)}
				samples={[
					{ label: "String table", load },
					{ label: "DataTable", load },
					{ label: "Blueprint", load }
				]}
			/>
		));
		const samples = screen.getByRole("group", { name: "Try a sample asset" });
		expect(within(samples).getAllByRole("button")).toHaveLength(3);
		expect(within(samples).getByRole("button", { name: "DataTable" })).toBeDefined();
		expect(within(samples).getByRole("button", { name: "Blueprint" })).toBeDefined();
		expect(screen.queryByRole("combobox")).toBeNull();
		fireEvent.click(within(samples).getByRole("button", { name: "String table" }));
		expect(load).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledOnce();
	});
});
