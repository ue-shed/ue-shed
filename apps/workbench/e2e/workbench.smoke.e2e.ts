import { expect, test } from "./fixtures/workbench-test.js";

test("launches the configured showcase and opens a saved DataTable", async ({
	workbench
}, testInfo) => {
	await workbench.expectShowcaseReady();
	await workbench.openRoute("Data Authoring");

	await expect(workbench.page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
		"Data authoring/Tables"
	);
	await expect(
		workbench.page.getByRole("navigation", { name: "Project DataTables" })
	).toBeVisible();
	await expect(
		workbench.page.getByText("/Game/Fixture/Authoring/DT_Scalars.DT_Scalars", { exact: true })
	).toBeVisible();
	await expect(workbench.page.getByText("Scalar_Alpha / Enabled", { exact: true })).toBeVisible();
	await workbench.page.getByRole("button", { name: "Sessions" }).click();
	await expect(workbench.page.getByText("No staged drafts.", { exact: true })).toBeVisible();
	await workbench.page.getByRole("button", { name: "Cell" }).click();
	await workbench.page.getByRole("button", { name: "+ Row" }).click();
	await expect(workbench.page.getByRole("form", { name: "Row name editor" })).toBeVisible();
	await workbench.page.getByRole("button", { name: "Cancel" }).click();
	await workbench.page.getByRole("button", { name: /^Review \d+$/ }).click();
	await expect(workbench.page.getByText("SESSION REVIEW", { exact: true })).toBeVisible();
	await workbench.page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("data-authoring-review.png")
	});

	await workbench.openRoute("Map Review");
	await expect(workbench.page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
		"Map review / Live world"
	);
	await expect(
		workbench.page.getByRole("heading", { name: "Actors in the open level" })
	).toBeVisible();
	await expect(workbench.page.getByRole("button", { name: "CONNECT LIVE WORLD" })).toBeVisible();
	await expect(workbench.page.getByRole("region", { name: "Review set status" })).toContainText(
		"Fixture Structure"
	);
	await expect(
		workbench.page.getByRole("region", { name: "Review View authoring" })
	).toContainText("Select an actor, then reframe");
	await expect(
		workbench.page.getByRole("button", { name: "REFRAME SELECTED ACTOR" })
	).toBeVisible();
	await workbench.page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("map-review-world-scout.png")
	});
	await workbench.page.getByRole("button", { name: "CAPTURE SET" }).click();
	const captureWorkflow = workbench.page.getByRole("dialog", {
		name: "Capture review set"
	});
	await expect(captureWorkflow).toContainText("Editor World");
	await captureWorkflow.getByRole("button", { name: "REVIEW CAPTURE PLAN →" }).click();
	await expect(
		captureWorkflow.getByRole("region", { name: "Preview capture plan" })
	).toContainText("Structure Context");
	await workbench.page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("map-review-capture-plan.png")
	});
	await captureWorkflow.getByRole("button", { name: "← BACK" }).click();
	await captureWorkflow.getByRole("button", { name: "CANCEL" }).click();

	await workbench.openRoute("Data Authoring");
	await workbench.page
		.getByRole("navigation", { name: "Project DataTables" })
		.getByRole("button", { name: /^DT_LargeScalars DATA TABLE/ })
		.click();
	await expect(workbench.page.getByText("10000 / 10000 VISIBLE", { exact: true })).toBeVisible();
});
