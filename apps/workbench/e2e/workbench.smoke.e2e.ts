import { expect, test } from "./fixtures/workbench-test.js";

test("launches the configured showcase and opens a saved DataTable", async ({ workbench }) => {
	await workbench.expectShowcaseReady();
	await workbench.openRoute("Data Authoring");

	await expect(workbench.page.getByRole("heading", { name: "Table ledger" })).toBeVisible();
	await expect(
		workbench.page.getByRole("navigation", { name: "Project DataTables" })
	).toBeVisible();
	await expect(
		workbench.page.getByText("/Game/Fixture/Authoring/DT_Scalars.DT_Scalars", { exact: true })
	).toBeVisible();
	await expect(workbench.page.getByText("Scalar_Alpha / Enabled", { exact: true })).toBeVisible();

	await workbench.openRoute("Map Review");
	await expect(
		workbench.page.getByRole("heading", { name: "A memory for the world." })
	).toBeVisible();
	await expect(workbench.page.getByRole("region", { name: "Review set status" })).toContainText(
		"Fixture Structure"
	);
	await expect(
		workbench.page.getByRole("region", { name: "Review View authoring" })
	).toContainText("Frame what matters.");
	await expect(
		workbench.page.getByRole("button", { name: "REFRAME SELECTED ACTOR" })
	).toBeVisible();

	await workbench.openRoute("Data Authoring");
	await workbench.page.getByRole("button", { name: /DT_LargeScalars/ }).click();
	await expect(workbench.page.getByText("10000 / 10000 VISIBLE", { exact: true })).toBeVisible();
});
