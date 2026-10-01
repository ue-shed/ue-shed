import { join, resolve } from "node:path";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	expect,
	indexedBlueprintTest,
	offlineBlueprintTest as test
} from "./fixtures/workbench-test.js";
import type { WorkbenchPage } from "./pages/workbench-page.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturePath = resolve(
	repositoryRoot,
	"fixtures/unreal-project/Content/Fixture/Blueprints/BP_GraphFixture.uasset"
);

async function openIndexedBlueprint(workbench: WorkbenchPage, assetName: string) {
	await workbench.openRoute("Blueprint Graphs");
	const search = workbench.page.getByLabel("Search project Blueprints");
	await expect(search).toBeVisible({ timeout: 60_000 });
	await search.fill(assetName);
	await workbench.page
		.getByRole("button", { name: `Open ${assetName} from project index` })
		.click();
	await expect(workbench.page.getByText("Fully decoded", { exact: true })).toBeVisible();
}

indexedBlueprintTest(
	"inspects saved Blueprint variables, class defaults and component templates without Unreal",
	async ({ indexedBlueprint: { harness, workbench } }) => {
		indexedBlueprintTest.setTimeout(90_000);
		await openIndexedBlueprint(workbench, "BP_ReviewFixture");
		const page = workbench.page;
		await page.getByRole("tab", { name: "Blueprint", exact: true }).click();
		const definition = page.getByLabel("Blueprint definition");
		await definition.getByText("ReviewCount · int · none", { exact: true }).click();
		await expect(definition).toContainText("Review|Settings");
		await definition.getByText("ReviewCount", { exact: true }).click();
		await expect(
			definition.locator("code").filter({ hasText: '"name":"ReviewCount"' })
		).toContainText('"value":23');
		await definition.getByText(/^ReviewChild ·/).click();
		await expect(definition).toContainText("SavedSocket");
		await definition.getByText("RelativeLocation", { exact: true }).click();
		await expect(definition.getByText(/"x":11,"y":22,"z":33/)).toBeVisible();
		await definition.getByText(/^ReviewRoot ·/).click();
		await expect(definition).toContainText("CollisionCylinder");
		const root = definition.locator("details").filter({ has: page.getByText(/^ReviewRoot ·/) });
		await root.getByText("Saved native data", { exact: true }).click();
		await expect(
			root.locator("code").filter({ hasText: "UCSModifiedProperties" })
		).toContainText('"values":[]');
		await page.getByLabel("Search saved nodes and pins").fill("Saved review fixture");
		await page.getByRole("button", { name: "node · EdGraphNode_Comment" }).click();
		await expect(page.getByRole("heading", { name: "EdGraphNode_Comment" })).toBeVisible();
		expect(await harness.launchCount()).toBe(0);
	}
);

test("offers samples without a selected project and finishes failed camera status checks", async ({
	offlineBlueprint: { application, harness, workbench }
}) => {
	const page = workbench.page;
	const sample = join(harness.checkoutRoot, "fixtures", "unreal-project");
	await mkdir(join(sample, "Content"), { recursive: true });
	await writeFile(join(sample, "Sample.uproject"), JSON.stringify({ FileVersion: 3 }));
	await cp(fixturePath, join(sample, "Content", "BP_GraphFixture.uasset"));
	await cp(
		resolve(repositoryRoot, "packages/config-explorer/fixtures/config-source"),
		join(harness.checkoutRoot, "packages/config-explorer/fixtures/config-source"),
		{ recursive: true }
	);
	await workbench.openRoute("Blueprint Graphs");
	await workbench.openRoute("Showcase");
	await expect(page.getByRole("region", { name: "Current project" })).toContainText(
		"Not selected"
	);
	await expect(
		page.getByRole("main").getByText("Sample query available", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Try the sample project" })).toBeVisible();
	await application.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler("camera:status");
		ipcMain.handle("camera:status", () => {
			throw new Error("Camera status test failure");
		});
	});
	await workbench.openRoute("Blueprint Graphs");
	await workbench.openRoute("Showcase");
	await expect(page.getByRole("region", { name: "Current project" })).toContainText(
		"Unavailable"
	);
	await expect(page.getByText("Checking live session…", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Try the sample project" }).click();
	await expect(page.getByRole("region", { name: "Current project" })).toContainText(
		"unreal-project"
	);
	expect(await harness.launchCount()).toBe(0);
});

test("asks for a project instead of a file path", async ({
	offlineBlueprint: { harness, workbench }
}) => {
	await workbench.openRoute("Blueprint Graphs");
	const page = workbench.page;
	await expect(page.getByText("Read-only · no Unreal required", { exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "No project selected" })).toBeVisible();
	await expect(page.getByLabel("Search project Blueprints")).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Browse/ })).toHaveCount(0);
	expect(await harness.launchCount()).toBe(0);
});

indexedBlueprintTest(
	"searches the project index and inspects a saved Blueprint graph without Unreal",
	async ({ indexedBlueprint: { harness, workbench } }, testInfo) => {
		indexedBlueprintTest.setTimeout(90_000);
		expect(await harness.launchCount()).toBe(0);
		await openIndexedBlueprint(workbench, "BP_GraphFixture");
		const page = workbench.page;

		const summary = page.getByRole("region", { name: "Blueprint summary" });
		await expect(summary).toContainText("2graphs");
		await expect(summary).toContainText("6nodes");
		await expect(summary).toContainText("15pins");
		await expect(summary).toContainText("1link");
		await expect(page.getByLabel("Search project Blueprints")).toHaveValue("");
		await expect(
			page.getByRole("region", { name: "Saved Blueprint graph" }).locator("svg path")
		).toHaveCount(1);
		await page.getByRole("button", { name: "Inspect SetActorHiddenInGame" }).click();
		await expect(page.getByLabel("Saved pin evidence")).toContainText("bool");
		await page.getByRole("tab", { name: "UserConstructionScript, 1 node" }).click();
		await expect(page.getByRole("button", { name: /Inspect/ })).toHaveCount(1);
		await page.getByRole("tab", { name: "EventGraph, 5 nodes" }).click();

		const graphViewport = page.getByLabel("Graph viewport");
		await page.getByRole("button", { name: "Zoom in" }).click();
		await expect(page.getByLabel("Graph zoom")).toHaveText("110%");
		for (let index = 0; index < 5; index += 1) {
			await page.getByRole("button", { name: "Zoom in" }).click();
		}
		await expect(page.getByLabel("Graph zoom")).toHaveText("160%");
		await expect
			.poll(() =>
				graphViewport.evaluate((element) => element.scrollWidth > element.clientWidth)
			)
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

		await page.getByText("Compare saved versions", { exact: true }).click();
		await page.getByLabel("Baseline asset path").fill(fixturePath);
		await page.getByRole("button", { name: "Compare baseline" }).click();
		await expect(page.getByText(/No changes in decoded evidence/)).toBeVisible();

		expect(await harness.launchCount()).toBe(0);
		expect(await harness.markerExists()).toBe(false);
		await page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("blueprint-graphs-indexed.png")
		});
	}
);
