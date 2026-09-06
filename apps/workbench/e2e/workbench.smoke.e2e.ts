import { expect, test } from "./fixtures/workbench-test.js";

test("opens saved tables and restores a staged draft after navigation", async ({ workbench }) => {
	test.setTimeout(90_000);
	await workbench.expectShowcaseReady();
	await workbench.openRoute("Data Authoring");
	const page = workbench.page;
	await expect(page.getByRole("heading", { name: "Data authoring", exact: true })).toBeVisible();
	await expect(page.getByText("Scalar_Alpha / Enabled", { exact: true })).toBeVisible();
	await expect(page.getByText("Saved snapshot", { exact: true })).toBeVisible();
	await expect(page.getByText("Applied", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Duplicate row", exact: true }).click();
	const editor = page.getByRole("form", { name: "Row name editor" });
	await editor.getByLabel("Row name", { exact: true }).fill("ReviewAddedRow");
	await editor.getByRole("button", { name: "Stage row", exact: true }).click();
	await expect(page.getByRole("button", { name: "Review 1", exact: true })).toBeVisible();
	await workbench.openRoute("Showcase");
	await workbench.openRoute("Data Authoring");
	await expect(page.getByRole("button", { name: "Review 1", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Review 1", exact: true }).click();
	await expect(page.getByText("ReviewAddedRow", { exact: false }).first()).toBeVisible();
	page.once("dialog", async (dialog) => {
		expect(dialog.message()).toContain("dirty draft will remain persisted");
		await dialog.accept();
	});
	await page
		.getByRole("navigation", { name: "Project DataTables" })
		.getByRole("button", { name: /^DT_LargeScalars\b/ })
		.click();
	await expect(page.getByText("10000 / 10000 rows", { exact: true })).toBeVisible({
		timeout: 60_000
	});
});
