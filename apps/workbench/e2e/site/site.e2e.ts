import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const slugs = ["getting-started", "data-authoring", "game-text", "config-explorer", "map-review"];

const sequenceFixture = resolve(
	import.meta.dirname,
	"../../../../fixtures/unreal-project/Content/Fixture/ParserNative/LS_SavedDetails.uasset"
);

function sequencerErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" && !message.text().includes("deprecated parameters")) {
			errors.push(message.text());
		}
	});
	return errors;
}

async function dropSiteFixture(page: Page, path: string) {
	const bytes = JSON.stringify([...(await readFile(path))]);
	const name = JSON.stringify(basename(path));
	// The e2e tsconfig has no DOM lib, so the page-side drop is a string expression.
	await page.evaluate(`(() => {
		const transfer = new DataTransfer();
		transfer.items.add(
			new File([new Uint8Array(${bytes})], ${name}, { type: "application/octet-stream" })
		);
		document
			.querySelector("main")
			?.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
	})()`);
}

async function expectSequenceFits(page: Page) {
	await expect
		.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"))
		.toBe(true);
}

async function expectSavedSequence(page: Page) {
	const summary = page.getByRole("region", { name: "Sequence coverage" });
	await expect(summary).toContainText("LS_SavedDetails");
	await expect(summary).toContainText("5 tracks · 2 bindings · 7 sections · 6 keys");
	await expect(summary).toContainText("Fully decoded");
	await page
		.getByRole("list", { name: "Sections" })
		.getByRole("listitem")
		.filter({ hasText: "Root · Label" })
		.getByRole("button")
		.click();
	await expect(page.getByRole("region", { name: "Section inspector" })).toContainText(
		'100 · "世界 🌟"'
	);
	await expectSequenceFits(page);
}

test("showcase navigation, images, and keyboard tabs", async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1 })).toContainText("Your Unreal project");
	const tabs = page.getByRole("tab");
	for (const tab of await tabs.all()) {
		await tab.click();
		await expect(page.getByRole("tabpanel").getByRole("img")).toHaveJSProperty(
			"complete",
			true
		);
		await expect
			.poll(() =>
				page
					.getByRole("tabpanel")
					.getByRole("img")
					.evaluate((image: { readonly naturalWidth: number }) => image.naturalWidth)
			)
			.toBeGreaterThan(0);
		const walkthrough = page.getByRole("link", { name: "Follow the walkthrough" });
		await expect(walkthrough).toHaveAttribute("href", /^\/docs\//);
	}
	await tabs.first().focus();
	await page.keyboard.press("ArrowRight");
	await expect(tabs.nth(1)).toBeFocused();
	await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
	await expect
		.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"))
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("home.png"),
		fullPage: true,
		animations: "disabled"
	});
	await page.getByRole("link", { name: "Start exploring" }).click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Start with a saved project");
	expect(errors).toEqual([]);
});

for (const slug of slugs) {
	test(`direct guide /docs/${slug} has working media and styles`, async ({ page }, testInfo) => {
		await page.goto(`/docs/${slug}`);
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		await expect(
			page.getByRole("navigation", { name: "Guides" }).locator('[aria-current="page"]')
		).toHaveCount(1);
		for (const image of await page.getByRole("main").getByRole("img").all()) {
			await image.scrollIntoViewIfNeeded();
			await expect
				.poll(() =>
					image.evaluate((image: { readonly naturalWidth: number }) => image.naturalWidth)
				)
				.toBeGreaterThan(0);
		}
		await expect
			.poll(() =>
				page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")
			)
			.toBe(true);
		// This catches a missing extracted StyleX stylesheet on nested URLs.
		await expect(page.locator("h1")).toHaveCSS("font-weight", "400");
		await page.evaluate("scrollTo({ top: 0, behavior: 'instant' })");
		await page.screenshot({
			path: testInfo.outputPath(`${slug}.png`),
			fullPage: true,
			animations: "disabled"
		});
		await page.getByRole("link", { name: "ue-shed / docs" }).click();
		await expect(page).toHaveURL("http://127.0.0.1:4175/");
	});
}

test("unknown guide offers a way back", async ({ page }) => {
	await page.goto("/docs/missing-guide");
	await expect(page.getByRole("heading", { name: "Guide not found" })).toBeVisible();
	await page.getByRole("link", { name: "Start with the field guide" }).click();
	await expect(page.getByRole("heading", { name: "Start with a saved project" })).toBeVisible();
});

const blueprintFixture = resolve(
	import.meta.dirname,
	"../../../../fixtures/unreal-project/Content/Fixture/Blueprints/BP_GraphFixture.uasset"
);

const stringTableFixture = resolve(
	import.meta.dirname,
	"../../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset"
);
const dataTableFixture = resolve(
	import.meta.dirname,
	"../../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
);

test("browser Blueprint viewer opens local files and the sample", async ({ page }, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" && !message.text().includes("deprecated parameters")) {
			errors.push(message.text());
		}
	});
	await page.goto("/");
	await page.getByRole("link", { name: "Blueprint viewer", exact: true }).click();
	await expect(page).toHaveURL(/\/blueprints$/);
	await page.getByRole("button", { name: "Try the sample Blueprint" }).click();
	await expect(page.getByRole("region", { name: "Blueprint summary" })).toContainText(
		"Fully decoded"
	);
	await page.reload();
	await page.getByLabel("Choose a Blueprint .uasset").setInputFiles(blueprintFixture);
	const summary = page.getByRole("region", { name: "Blueprint summary" });
	await expect(summary).toContainText("2graphs");
	await expect(summary).toContainText("6nodes");
	await expect(summary).toContainText("15pins");
	await expect(summary).toContainText("1link");
	await expect(summary).toContainText("Fully decoded");
	await page.getByRole("button", { name: "Inspect SetActorHiddenInGame" }).click();
	await expect(page.getByLabel("Saved pin evidence")).toContainText("bool");
	await expect
		.poll(() => page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"))
		.toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("blueprints.png"),
		fullPage: true,
		animations: "disabled"
	});
	expect(errors).toEqual([]);
});

test("browser Blueprint viewer explains invalid packages", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" && !message.text().includes("deprecated parameters")) {
			errors.push(message.text());
		}
	});
	await page.goto("/blueprints");
	await page.getByLabel("Choose a Blueprint .uasset").setInputFiles({
		name: "Invalid.uasset",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("This is not an Unreal package.")
	});
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByRole("alert")).toContainText(/saved package|Blueprint graph/);
	await expect(page.getByRole("region", { name: "Blueprint summary" })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("asset inspector opens local assets and hands graphs to the Blueprint viewer", async ({
	page
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error" && !message.text().includes("deprecated parameters")) {
			errors.push(message.text());
		}
	});
	const assertFits = async () => {
		await expect
			.poll(() =>
				page.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth")
			)
			.toBe(true);
	};
	await page.goto("/");
	await page.getByRole("link", { name: "Asset inspector", exact: true }).click();
	await expect(page).toHaveURL(/\/inspect$/);
	await expect(page.getByRole("heading", { name: "Asset Inspector", exact: true })).toBeVisible();
	const picker = page.getByLabel("Choose a .uasset to inspect", { exact: true });
	await picker.setInputFiles(stringTableFixture);
	const entries = page.getByRole("table", { name: "String table entries" });
	await expect(entries).toContainText("PromptContinue");
	await expect(entries).toContainText("Hold to skip");
	await expect(page.getByRole("link", { name: "Open in Blueprint viewer" })).toHaveCount(0);
	await assertFits();
	await picker.setInputFiles(dataTableFixture);
	const rows = page.getByRole("table", { name: "DataTable rows" });
	await expect(rows).toContainText("Scalar_Alpha");
	await expect(rows).toContainText("Scalar_Beta");
	await expect(rows).toContainText("Count");
	await assertFits();
	await picker.setInputFiles(blueprintFixture);
	const blueprintLink = page.getByRole("link", { name: "Open in Blueprint viewer" });
	await expect(blueprintLink).toBeVisible();
	// A same-document marker catches an accidental full navigation/reload.
	await page.evaluate("window.__siteInspectorJourney = true");
	await blueprintLink.click();
	await expect(page).toHaveURL(/\/blueprints$/);
	expect(await page.evaluate<boolean>("window.__siteInspectorJourney === true")).toBe(true);
	const summary = page.getByRole("region", { name: "Blueprint summary" });
	await expect(summary).toContainText("2graphs");
	await expect(summary).toContainText("6nodes");
	await expect(summary).toContainText("15pins");
	await expect(summary).toContainText("1link");
	await expect(summary).toContainText("Fully decoded");
	await assertFits();
	await page.goBack();
	await expect(page).toHaveURL(/\/inspect$/);
	await expect(page.getByRole("region", { name: "Asset summary" })).toContainText(
		"BP_GraphFixture"
	);
	await expect(blueprintLink).toBeVisible();
	await assertFits();
	await picker.setInputFiles({
		name: "Invalid.uasset",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("This is not an Unreal package.")
	});
	await expect(page.getByRole("alert")).toContainText("saved package");
	await expect(page.getByRole("region", { name: "Asset summary" })).toHaveCount(0);
	await assertFits();
	await page.getByRole("link", { name: "Blueprint viewer", exact: true }).click();
	await page.getByLabel("Choose a Blueprint .uasset").setInputFiles(stringTableFixture);
	await page.getByRole("link", { name: "Inspect this file instead" }).click();
	await expect(page).toHaveURL(/\/inspect$/);
	await expect(entries).toContainText("PromptContinue");
	await expect(entries).toContainText("Hold to skip");
	await expect(blueprintLink).toHaveCount(0);
	await assertFits();
	await page.screenshot({
		path: testInfo.outputPath("inspect.png"),
		fullPage: true,
		animations: "disabled"
	});
	expect(errors).toEqual([]);
});

test("Sequencer homepage navigation opens a dropped timeline and section evidence", async ({
	page
}, testInfo) => {
	const errors = sequencerErrors(page);
	await page.goto("/");
	await page.getByRole("link", { name: "Sequencer viewer", exact: true }).click();
	await expect(page).toHaveURL(/\/sequencer$/);
	await expect(page.getByRole("heading", { name: "Sequencer", exact: true })).toBeVisible();
	await dropSiteFixture(page, sequenceFixture);
	await expectSavedSequence(page);
	await page.getByLabel("Timeline zoom").focus();
	await page.keyboard.press("End");
	await expectSequenceFits(page);
	await page.screenshot({
		path: testInfo.outputPath("sequencer.png"),
		fullPage: true,
		animations: "disabled"
	});
	expect(errors).toEqual([]);
});

test("Sequencer sample opens locally without a file pick", async ({ page }) => {
	const errors = sequencerErrors(page);
	await page.goto("/sequencer");
	await page.getByRole("button", { name: "Try the sample Level Sequence" }).click();
	await expectSavedSequence(page);
	expect(errors).toEqual([]);
});

test("Sequencer explains garbage bytes and offers inspection for a Blueprint", async ({ page }) => {
	const errors = sequencerErrors(page);
	await page.goto("/sequencer");
	await page.getByLabel("Choose a Level Sequence .uasset").setInputFiles({
		name: "Invalid.uasset",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("This is not an Unreal package.")
	});
	await expect(page.getByRole("alert")).toBeVisible();
	await expectSequenceFits(page);
	await dropSiteFixture(page, blueprintFixture);
	const failure = page.getByRole("alert");
	await expect(failure.getByRole("link", { name: "Inspect this file instead" })).toBeVisible();
	await page.evaluate("window.__siteInspectorJourney = true");
	await failure.getByRole("link", { name: "Inspect this file instead" }).click();
	await expect(page).toHaveURL(/\/inspect$/);
	await expect(page.getByRole("region", { name: "Asset summary" })).toContainText(
		"BP_GraphFixture"
	);
	expect(await page.evaluate<boolean>("window.__siteInspectorJourney === true")).toBe(true);
	await expectSequenceFits(page);
	expect(errors).toEqual([]);
});

test("inspection hands saved sequence evidence to Sequencer and browser Back restores inspection", async ({
	page
}) => {
	const errors = sequencerErrors(page);
	await page.goto("/inspect");
	await page
		.getByLabel("Choose a .uasset to inspect", { exact: true })
		.setInputFiles(sequenceFixture);
	const link = page.getByRole("link", { name: "Open in Sequencer viewer", exact: true });
	await expect(link).toBeVisible();
	await expect(page.getByRole("link", { name: "Open in Blueprint viewer" })).toHaveCount(0);
	await page.evaluate("window.__siteInspectorJourney = true");
	await link.click();
	await expect(page).toHaveURL(/\/sequencer$/);
	expect(await page.evaluate<boolean>("window.__siteInspectorJourney === true")).toBe(true);
	await expectSavedSequence(page);
	await page.goBack();
	await expect(page).toHaveURL(/\/inspect$/);
	await expect(page.getByRole("region", { name: "Asset summary" })).toContainText(
		"LS_SavedDetails"
	);
	await expect(link).toBeVisible();
	expect(await page.evaluate<boolean>("window.__siteInspectorJourney === true")).toBe(true);
	await expectSequenceFits(page);
	expect(errors).toEqual([]);
});

async function expectSavedDataTable(page: Page) {
	const summary = page.getByRole("region", { name: "Table summary" });
	await expect(summary).toContainText("DT_Scalars");
	await expect(summary).toContainText("2 rows · 5 fields");
	await expect(summary).toContainText("Fully decoded");
	const grid = page.getByRole("region", { name: "Table grid" });
	await expect(grid.getByRole("rowheader", { name: "Scalar_Alpha", exact: true })).toBeVisible();
	await expect(grid.getByRole("rowheader", { name: "Scalar_Beta", exact: true })).toBeVisible();
	// Scroll only the spreadsheet viewport on mobile; the page itself must never overflow.
	const count = grid.getByRole("gridcell", { name: "7", exact: true });
	await count.scrollIntoViewIfNeeded();
	await count.click();
	const inspector = page.getByRole("region", { name: "Cell inspector" });
	await expect(inspector).toContainText("Count");
	await expect(inspector).toContainText("Scalar_Alpha");
	await expect(inspector.getByText("7", { exact: true })).toBeVisible();
	await expectSequenceFits(page);
	await page.getByRole("button", { name: "Charts", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Patterns in DT_Scalars" })).toBeVisible();
	await expectSequenceFits(page);
}

test("Data Tables homepage navigation opens read-only rows and Patterns", async ({ page }) => {
	const errors = sequencerErrors(page);
	await page.goto("/");
	await page.getByRole("link", { name: "Data tables", exact: true }).click();
	await expect(page).toHaveURL(/\/data-tables$/);
	await expect(page.getByRole("heading", { name: "Data Tables", exact: true })).toBeVisible();
	await page.getByLabel("Choose a DataTable .uasset").setInputFiles(dataTableFixture);
	await expectSavedDataTable(page);
	expect(errors).toEqual([]);
});

test("Data Tables sample opens locally without a file pick", async ({ page }) => {
	const errors = sequencerErrors(page);
	await page.goto("/data-tables");
	await page.getByRole("button", { name: "Try the sample DataTable" }).click();
	await expectSavedDataTable(page);
	expect(errors).toEqual([]);
});

test("Data Tables explains garbage bytes and offers inspection for a Blueprint", async ({
	page
}) => {
	const errors = sequencerErrors(page);
	await page.goto("/data-tables");
	await page.getByLabel("Choose a DataTable .uasset").setInputFiles({
		name: "Invalid.uasset",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("This is not an Unreal package.")
	});
	await expect(page.getByRole("alert")).toBeVisible();
	await expectSequenceFits(page);
	await page.getByLabel("Choose a DataTable .uasset").setInputFiles(blueprintFixture);
	const failure = page.getByRole("alert");
	await expect(failure.getByRole("link", { name: "Inspect this file instead" })).toBeVisible();
	await page.evaluate("window.__siteInspectorJourney = true");
	await failure.getByRole("link", { name: "Inspect this file instead" }).click();
	await expect(page).toHaveURL(/\/inspect$/);
	await expect(page.getByRole("region", { name: "Asset summary" })).toContainText(
		"BP_GraphFixture"
	);
	expect(await page.evaluate<boolean>("window.__siteInspectorJourney === true")).toBe(true);
	await expectSequenceFits(page);
	expect(errors).toEqual([]);
});

test("inspection hands a DataTable to Data Tables and Back restores the inspection", async ({
	page
}) => {
	const errors = sequencerErrors(page);
	await page.goto("/inspect");
	await page
		.getByLabel("Choose a .uasset to inspect", { exact: true })
		.setInputFiles(dataTableFixture);
	const link = page.getByRole("link", { name: "Open in Data Tables", exact: true });
	await expect(link).toBeVisible();
	await page.evaluate("window.__siteInspectorJourney = true");
	await link.click();
	await expect(page).toHaveURL(/\/data-tables$/);
	expect(await page.evaluate<boolean>("window.__siteInspectorJourney === true")).toBe(true);
	await expectSavedDataTable(page);
	await page.goBack();
	await expect(page).toHaveURL(/\/inspect$/);
	await expect(page.getByRole("region", { name: "Asset summary" })).toContainText("DT_Scalars");
	await expect(page.getByRole("table", { name: "DataTable rows" })).toContainText("Scalar_Beta");
	await expect(link).toBeVisible();
	expect(await page.evaluate<boolean>("window.__siteInspectorJourney === true")).toBe(true);
	await expectSequenceFits(page);
	expect(errors).toEqual([]);
});
