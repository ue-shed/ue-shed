import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	expect,
	indexedBlueprintTest,
	offlineBlueprintTest as test
} from "./fixtures/workbench-test.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturePath = resolve(
	repositoryRoot,
	"fixtures/unreal-project/Content/Fixture/Blueprints/BP_GraphFixture.uasset"
);

test("opens saved Blueprint evidence without a project or Unreal process", async ({
	offlineBlueprint: { application, harness, workbench }
}, testInfo) => {
	test.setTimeout(60_000);
	expect(await harness.launchCount()).toBe(0);

	await workbench.openRoute("Blueprint Graphs");
	await expect(workbench.page.getByText("LOCAL FILE · NO UNREAL", { exact: true })).toBeVisible();
	await expect(workbench.page.getByText(/No Workbench project/)).toBeVisible();

	const pathInput = workbench.page.getByLabel("Blueprint package path");
	await pathInput.fill(fixturePath);
	await workbench.page.getByRole("button", { name: "Open graph" }).click();

	const summary = workbench.page.getByRole("region", { name: "Blueprint summary" });
	await expect(summary).toContainText("2graphs");
	await expect(summary).toContainText("6nodes");
	await expect(summary).toContainText("15pins");
	await expect(summary).toContainText("1links");
	await expect(workbench.page.getByText("Complete saved-graph projection")).toBeVisible();
	await expect(
		workbench.page.getByRole("region", { name: "Saved Blueprint graph" }).locator("svg path")
	).toHaveCount(1);
	await workbench.page.getByRole("button", { name: "Inspect SetActorHiddenInGame" }).click();
	await expect(workbench.page.getByLabel("Saved pin evidence")).toContainText("bool");
	await workbench.page.getByRole("button", { name: "UserConstructionScript, 1 nodes" }).click();
	await expect(workbench.page.getByRole("button", { name: /Inspect/ })).toHaveCount(1);
	await workbench.page.getByRole("button", { name: "EventGraph, 5 nodes" }).click();

	const graphViewport = workbench.page.getByLabel("Graph viewport");
	await workbench.page.getByRole("button", { name: "Zoom in" }).click();
	await expect(workbench.page.getByLabel("Graph zoom")).toHaveText("110%");
	for (let index = 0; index < 5; index += 1) {
		await workbench.page.getByRole("button", { name: "Zoom in" }).click();
	}
	await expect(workbench.page.getByLabel("Graph zoom")).toHaveText("160%");
	await expect
		.poll(() => graphViewport.evaluate((element) => element.scrollWidth > element.clientWidth))
		.toBe(true);
	await graphViewport.dispatchEvent("pointerdown", {
		button: 0,
		clientX: 320,
		clientY: 240,
		pointerId: 7
	});
	await graphViewport.dispatchEvent("pointermove", {
		button: 0,
		clientX: 180,
		clientY: 140,
		pointerId: 7
	});
	await graphViewport.dispatchEvent("pointerup", {
		button: 0,
		clientX: 180,
		clientY: 140,
		pointerId: 7
	});
	await expect
		.poll(() => graphViewport.evaluate((element) => element.scrollLeft))
		.toBeGreaterThan(0);

	await application.evaluate(({ dialog }, selectedPath) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
	}, fixturePath);
	await workbench.page.getByRole("button", { name: "Browse…" }).click();
	await expect(pathInput).toHaveValue(fixturePath);
	await expect(workbench.page.getByText("Complete saved-graph projection")).toBeVisible();

	expect(await harness.launchCount()).toBe(0);
	expect(await harness.markerExists()).toBe(false);
	await workbench.page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("blueprint-graphs-offline.png")
	});
});

indexedBlueprintTest(
	"searches the initial project index and opens a Blueprint without Unreal",
	async ({ indexedBlueprint: { harness, workbench } }, testInfo) => {
		indexedBlueprintTest.setTimeout(90_000);
		expect(await harness.launchCount()).toBe(0);

		await workbench.openRoute("Blueprint Graphs");
		const search = workbench.page.getByLabel("Search indexed Blueprints");
		await expect(search).toBeVisible({ timeout: 60_000 });
		await search.fill("GraphFixture");
		await workbench.page
			.getByRole("button", { name: "Open BP_GraphFixture from project index" })
			.click();

		const summary = workbench.page.getByRole("region", { name: "Blueprint summary" });
		await expect(summary).toContainText("2graphs");
		await expect(summary).toContainText("6nodes");
		await expect(workbench.page.getByLabel("Blueprint package path")).toHaveValue(fixturePath);
		await expect(workbench.page.getByText("Complete saved-graph projection")).toBeVisible();
		expect(await harness.launchCount()).toBe(0);
		expect(await harness.markerExists()).toBe(false);

		await workbench.page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("blueprint-graphs-indexed.png")
		});
	}
);
