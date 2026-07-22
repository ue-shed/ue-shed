import { expect, test } from "./fixtures/workbench-test.js";

test.skip(
	process.env.UE_SHED_UNREAL_INTEGRATION !== "1",
	"Set UE_SHED_UNREAL_INTEGRATION=1 with the fixture editor available"
);
test.setTimeout(60_000);

test("persists a live save when reopened from the saved package", async ({ workbench }) => {
	const { page } = workbench;
	page.on("dialog", (dialog) => dialog.accept());

	await workbench.openRoute("Data Authoring");
	await expect(page.getByRole("region", { name: "Table manifest" })).toContainText("LIVE EDITOR");

	const catalog = page.getByRole("navigation", { name: "Project DataTables" });
	await catalog.getByRole("button", { name: /^DT_Enums.*DATA TABLE/ }).click();
	await expect(page.getByRole("region", { name: "Table manifest" })).toContainText("LIVE EDITOR");
	await expect(page.getByText("/Game/Fixture/Authoring/DT_Enums.DT_Enums")).toBeVisible();

	await catalog.getByRole("button", { name: /^CDT_Scalars.*COMPOSITE/ }).click();
	await expect(page.getByText("DERIVED TABLE · READ ONLY")).toBeVisible();
	await expect(page.getByRole("button", { name: "+ Row" })).toBeDisabled();

	await catalog.getByRole("button", { name: /^DT_Scalars DATA TABLE/ }).click();
	await expect(page.getByRole("region", { name: "Table manifest" })).toContainText("LIVE EDITOR");
	await expect(page.getByText("2 / 2 VISIBLE", { exact: true })).toBeVisible();

	await page.getByRole("gridcell").first().click();
	await page.getByRole("button", { name: "Duplicate" }).click();
	const rowName = page.getByRole("textbox", { name: "Unreal row name" });
	await rowName.fill("E2E_ApplyProbe");
	await page.getByRole("button", { name: "Stage row" }).click();
	await expect(page.getByText("STAGED DRAFT")).toBeVisible();
	await page.getByRole("button", { name: "Apply" }).click();
	await expect(page.getByRole("button", { name: "Save packages" })).toBeVisible();
	await expect(page.getByText("3 / 3 VISIBLE", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Save packages" }).click();
	await page.getByRole("button", { name: "Saved package" }).click();
	await expect(page.getByRole("region", { name: "Table manifest" })).toContainText(
		"SAVED PACKAGE"
	);
	await expect(page.getByText("3 / 3 VISIBLE", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Live editor" }).click();
	await expect(page.getByRole("region", { name: "Table manifest" })).toContainText("LIVE EDITOR");

	await page.getByRole("gridcell").nth(5).click();
	await expect(page.getByText("E2E_ApplyProbe / Enabled", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Delete" }).click();
	await expect(page.getByText("STAGED DRAFT")).toBeVisible();
	await page.getByRole("button", { name: "Apply" }).click();
	await expect(page.getByText("2 / 2 VISIBLE", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Save packages" }).click();
	await page.getByRole("button", { name: "Saved package" }).click();
	await expect(page.getByRole("region", { name: "Table manifest" })).toContainText(
		"SAVED PACKAGE"
	);
	await expect(page.getByText("2 / 2 VISIBLE", { exact: true })).toBeVisible();
});
