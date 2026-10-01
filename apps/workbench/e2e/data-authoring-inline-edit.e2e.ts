import { expect, test } from "./fixtures/workbench-test.js";

// Inline editing needs a live editor session; saved-package authority is read-only by design.
test.skip(
	process.env.UE_SHED_UNREAL_INTEGRATION !== "1",
	"Set UE_SHED_UNREAL_INTEGRATION=1 with the fixture editor available"
);

test("stages Count 7 to 13 with the inline editor", async ({ workbench }, testInfo) => {
	test.setTimeout(90_000);
	await workbench.expectShowcaseReady();
	await workbench.openRoute("Data Authoring");
	const { page } = workbench;
	await page
		.getByRole("navigation", { name: "Project DataTables" })
		.getByRole("button", { name: /^DT_Scalars\b/ })
		.click();
	const summary = page.getByRole("region", { name: "Table summary" });
	await expect(summary).toContainText("DT_Scalars");
	await expect(summary).toContainText("0 changes");
	const grid = page.getByRole("grid", { name: "Spreadsheet" });
	const alpha = grid.getByRole("row").filter({
		has: page.getByRole("rowheader", { name: "Scalar_Alpha" })
	});
	const count = alpha.getByRole("gridcell", { name: "7" });
	await expect(count).toHaveAttribute("aria-readonly", "false");
	// Capture diagnostics without making compiler event keys part of the test's assertions.
	const evidence = await grid.evaluate(`grid => ({
		columns: Array.from(grid.querySelectorAll('[role="columnheader"]'), cell => cell.textContent),
		cells: Array.from(grid.querySelectorAll('[role="row"] [role="gridcell"]'), cell => ({
			value: cell.textContent,
			column: cell.getAttribute("aria-colindex"),
			readOnly: cell.getAttribute("aria-readonly"),
			doubleClickHandler: typeof cell._$$dblclick
		})),
		keyDownHandler: typeof grid._$$keydown
	})`);
	await testInfo.attach("inline-edit-grid.json", {
		body: JSON.stringify(evidence, null, 2),
		contentType: "application/json"
	});
	await count.dblclick();
	const editor = grid.getByRole("textbox", { name: "Edit C1" });
	await expect(editor).toBeVisible();
	await editor.fill("13");
	await editor.press("Enter");
	await expect(alpha.getByRole("gridcell", { name: "13" })).toBeVisible();
	await expect(summary).toContainText("1 change");
	const review = page.getByRole("button", { name: "Review 1" });
	await expect(review).toBeVisible();
	await review.click();
	await expect(page.getByText("Scalar_Alpha.Count")).toBeVisible();
	await expect(page.getByText("7 → 13")).toBeVisible();
});
