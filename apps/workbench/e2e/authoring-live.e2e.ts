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
	await expect(page.getByRole("region", { name: "Table summary" })).toContainText("Live editor");

	const catalog = page.getByRole("navigation", { name: "Project DataTables" });
	await catalog.getByRole("button", { name: /^DT_Enums.*DATA TABLE/ }).click();
	await expect(page.getByRole("region", { name: "Table summary" })).toContainText("Live editor");
	await expect(page.getByText("/Game/Fixture/Authoring/DT_Enums.DT_Enums")).toBeVisible();

	await catalog.getByRole("button", { name: /^CDT_Scalars.*COMPOSITE/ }).click();
	await expect(page.getByText("Read-only table")).toBeVisible();
	await expect(page.getByRole("button", { name: "Add row" })).toBeDisabled();

	await catalog.getByRole("button", { name: /^DT_Scalars DATA TABLE/ }).click();
	await expect(page.getByRole("region", { name: "Table summary" })).toContainText("Live editor");
	await expect(page.getByText("2 / 2 rows", { exact: true })).toBeVisible();

	await page.getByRole("gridcell").first().click();
	await page.getByRole("button", { name: "Duplicate row" }).click();
	const rowName = page.getByRole("textbox", { name: "Row name" });
	await rowName.fill("E2E_ApplyProbe");
	await page.getByRole("button", { name: "Stage row" }).click();
	await expect(page.getByText("Draft", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Apply changes" }).click();
	await expect(page.getByRole("button", { name: "Save packages" })).toBeVisible();
	await expect(page.getByText("3 / 3 rows", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Save packages" }).click();
	await page.getByRole("button", { name: "Saved package" }).click();
	await expect(page.getByRole("region", { name: "Table summary" })).toContainText(
		"Saved package"
	);
	await expect(page.getByText("3 / 3 rows", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Live editor" }).click();
	await expect(page.getByRole("region", { name: "Table summary" })).toContainText("Live editor");

	await page.getByRole("gridcell").nth(5).click();
	await expect(page.getByText("E2E_ApplyProbe / Enabled", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Delete row" }).click();
	await expect(page.getByText("Draft", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Apply changes" }).click();
	await expect(page.getByText("2 / 2 rows", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Save packages" }).click();
	await page.getByRole("button", { name: "Saved package" }).click();
	await expect(page.getByRole("region", { name: "Table summary" })).toContainText(
		"Saved package"
	);
	await expect(page.getByText("2 / 2 rows", { exact: true })).toBeVisible();
});
