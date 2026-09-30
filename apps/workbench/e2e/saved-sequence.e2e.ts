import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	expect,
	indexedBlueprintTest,
	offlineBlueprintTest as test
} from "./fixtures/workbench-test.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
test("inspects saved strings, null object keys and camera binding scope without Unreal", async ({
	offlineBlueprint: { harness, workbench }
}) => {
	test.setTimeout(60_000);
	await workbench.openRoute("Sequencer");
	const page = workbench.page;
	await page
		.getByLabel("Sequence asset path")
		.fill(
			resolve(
				repositoryRoot,
				"fixtures/unreal-project/Content/Fixture/ParserNative/LS_SavedDetails.uasset"
			)
		);
	await page.getByRole("button", { name: "Open sequence" }).click();
	await expect(page.getByText("Saved evidence decoded", { exact: true })).toBeVisible();
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
	offlineBlueprint: { harness, workbench }
}) => {
	test.setTimeout(60_000);
	await workbench.openRoute("Sequencer");
	const page = workbench.page;
	await page
		.getByLabel("Sequence asset path")
		.fill(
			resolve(
				repositoryRoot,
				"fixtures/unreal-project/Content/Fixture/ParserNative/LS_Discrete.uasset"
			)
		);
	await page.getByRole("button", { name: "Open sequence" }).click();
	await expect(page.getByText("Partial saved evidence", { exact: true })).toBeVisible();
	const sections = page.getByRole("list", { name: "Sections" }).getByRole("button");
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
	offlineBlueprint: { harness, workbench }
}, testInfo) => {
	test.setTimeout(60_000);
	const path = resolve(
		repositoryRoot,
		"fixtures/unreal-project/Content/Fixture/ParserNative/LS_Numeric.uasset"
	);
	await workbench.openRoute("Sequencer");
	const page = workbench.page;
	await page.getByLabel("Sequence asset path").fill(path);
	await page.getByRole("button", { name: "Open sequence" }).click();
	await expect(page.getByRole("region", { name: "Sequence coverage" })).toContainText(
		"LS_Numeric"
	);
	await expect(
		page.getByRole("img", { name: "Saved sequence tracks and sections" })
	).toBeVisible();
	await page.getByRole("list", { name: "Sections" }).getByRole("button").first().click();
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
		await workbench.openRoute("Sequencer");
		const page = workbench.page;
		await page.getByText("Sequences in the selected project", { exact: true }).click();
		await page
			.getByRole("button", { name: "/Game/Fixture/Sequences/LS_NestedTimeline", exact: true })
			.click();
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
