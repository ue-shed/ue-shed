import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	expect,
	indexedBlueprintTest,
	indexedBlueprintTest as test,
	offlineBlueprintTest as noProjectTest
} from "./fixtures/workbench-test.js";

import type { WorkbenchPage } from "./pages/workbench-page.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
async function openIndexedSequence(workbench: WorkbenchPage, assetName: string) {
	await workbench.openRoute("Sequencer");
	const search = workbench.page.getByLabel("Search project Sequences");
	await expect(search).toBeVisible({ timeout: 60_000 });
	await search.fill(assetName);
	await workbench.page
		.getByRole("button", { name: `Open ${assetName} from project index` })
		.click();
	await expect(workbench.page.getByRole("region", { name: "Sequence coverage" })).toContainText(
		assetName
	);
}

test("inspects saved strings, null object keys and camera binding scope without Unreal", async ({
	indexedBlueprint: { harness, workbench }
}) => {
	test.setTimeout(60_000);
	await openIndexedSequence(workbench, "LS_SavedDetails");
	const page = workbench.page;
	await expect(page.getByText("Fully decoded", { exact: true })).toBeVisible();
	const sections = page.getByRole("list", { name: "Sections" });
	await sections
		.getByRole("listitem")
		.filter({ hasText: "Root · Label" })
		.getByRole("button")
		.click();
	const inspector = page.getByRole("region", { name: "Section inspector" });
	await expect(inspector).toContainText('100 · "世界 🌟"');
	await inspector.getByText("Saved section settings", { exact: true }).click();
	await expect(inspector).toContainText("row index: 2");
	await sections
		.getByRole("listitem")
		.filter({ hasText: "Root · Mesh" })
		.getByRole("button")
		.click();
	await expect(inspector).toContainText("24 · null object");
	await sections
		.getByRole("listitem")
		.filter({ hasText: "MovieSceneCameraCutTrack" })
		.getByRole("button")
		.nth(2)
		.click();
	await expect(inspector.getByRole("region", { name: "Camera binding" })).toContainText(
		"Sequence ID: 42"
	);
	await expect(inspector).toContainText("Resolve parent index: 1");
	expect(await harness.launchCount()).toBe(0);
});

test("inspects saved boolean and integer keys with omitted defaults", async ({
	indexedBlueprint: { harness, workbench }
}) => {
	test.setTimeout(60_000);
	await openIndexedSequence(workbench, "LS_Discrete");
	const page = workbench.page;
	await expect(page.getByText(/^Partial ·/)).toBeVisible();
	const sections = page
		.getByRole("list", { name: "Sections" })
		.locator("button[data-sequence-section]");
	await sections.first().click();
	const inspector = page.getByRole("region", { name: "Section inspector" });
	await expect(inspector).toContainText("-12 · false");
	await expect(inspector).toContainText("Saved external inversion flag: true");
	await sections.nth(2).click();
	await expect(inspector).toContainText("-2147483648");
	await expect(inspector).toContainText("2147483647");
	await sections.nth(6).click();
	await expect(inspector).toContainText("Default enabled: not serialized");
	expect(await harness.launchCount()).toBe(0);
});

test("reviews a saved sequence and baseline without Unreal", async ({
	indexedBlueprint: { harness, workbench }
}, testInfo) => {
	test.setTimeout(60_000);
	const path = resolve(
		repositoryRoot,
		"fixtures/unreal-project/Content/Fixture/ParserNative/LS_Numeric.uasset"
	);
	const page = workbench.page;
	await openIndexedSequence(workbench, "LS_Numeric");
	await expect(page.getByRole("region", { name: "Sequence coverage" })).toContainText(
		"LS_Numeric"
	);
	await expect(
		page.getByRole("img", { name: "Saved sequence tracks and sections" })
	).toBeVisible();
	await page
		.getByRole("list", { name: "Sections" })
		.locator("button[data-sequence-section]")
		.first()
		.click();
	await expect(page.getByRole("region", { name: "Section inspector" })).toBeVisible();
	await page.getByText("Compare saved versions", { exact: true }).click();
	await page.getByLabel("Baseline asset path").fill(path);
	await page.getByRole("button", { name: "Compare baseline" }).click();
	await expect(page.getByText(/No changes in decoded evidence/)).toBeVisible();
	expect(await harness.launchCount()).toBe(0);
	await page.screenshot({
		path: testInfo.outputPath("saved-sequence-review.png"),
		fullPage: true
	});
});

indexedBlueprintTest(
	"follows a saved subsequence reference through the project index",
	async ({ indexedBlueprint: { harness, workbench } }) => {
		indexedBlueprintTest.setTimeout(90_000);
		await openIndexedSequence(workbench, "LS_NestedTimeline");
		const page = workbench.page;
		await expect(page.getByRole("region", { name: "Sequence coverage" })).toContainText(
			"LS_NestedTimeline"
		);
		await page.getByText(/^References ·/).click();
		await page.getByRole("button", { name: "Load project references" }).click();
		await page.getByRole("button", { name: "Open saved asset" }).first().click();
		await expect(page.getByRole("region", { name: "Sequence coverage" })).toContainText(
			"LS_TextTimeline"
		);
		expect(await harness.launchCount()).toBe(0);
	}
);

noProjectTest(
	"asks for a project instead of a file path",
	async ({ offlineBlueprint: { harness, workbench } }) => {
		await workbench.openRoute("Sequencer");
		const page = workbench.page;
		await expect(page.getByRole("heading", { name: "No project selected" })).toBeVisible();
		await expect(
			page.getByText(/Choose a project in the sidebar to search its Level Sequences/)
		).toBeVisible();
		await expect(page.getByLabel("Sequence asset path")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Choose file", exact: true })).toHaveCount(0);
		expect(await harness.launchCount()).toBe(0);
	}
);
