import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	expect,
	indexedBlueprintTest,
	offlineBlueprintTest as test
} from "./fixtures/workbench-test.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
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
