import { expect, test } from "./fixtures/workbench-test.js";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { movementGymScenario } from "@ue-shed/scenarios";

test("virtualizes the saved actor outliner while retaining keyboard access to the last actor", async ({
	workbench
}) => {
	await workbench.openRoute("World Log");
	const page = workbench.page;
	const outliner = page.getByRole("complementary", { name: "Saved actor outliner" });
	await expect(outliner).toContainText("4137");
	const list = outliner.getByRole("list", { name: "Saved actors" });
	await expect(list.getByRole("button", { name: /Brush_0/ }).first()).toBeVisible();
	expect(await list.getByRole("listitem").count()).toBeLessThan(80);
	const first = list.getByRole("button", { name: /Brush_0/ }).first();
	await first.click();
	await page.keyboard.press("End");
	await expect(list.getByRole("button", { pressed: true })).toBeFocused();
	expect(await list.evaluate((element) => element.parentElement?.scrollTop ?? 0)).toBeGreaterThan(
		10_000
	);
	expect(await list.getByRole("listitem").count()).toBeLessThan(80);
	await outliner.getByRole("textbox", { name: "Find an actor" }).fill("Brush_0");
	await expect(list.getByRole("button", { name: /Brush_0/ })).toBeVisible();
	await expect(list.getByRole("listitem")).toHaveCount(2);
});

test("selected projects acquire draft storage and catalog refresh discovers added packages", async ({
	workbench,
	application
}) => {
	test.setTimeout(90_000);
	const root = await mkdtemp(join(tmpdir(), "ue-shed-e2e-selected-"));
	try {
		const content = join(root, "Content", "Fixture", "Authoring");
		await mkdir(content, { recursive: true });
		await writeFile(join(root, "SelectedFixture.uproject"), JSON.stringify({ FileVersion: 3 }));
		const fixture = resolve("../../fixtures/unreal-project/Content/Fixture/Authoring");
		await copyFile(join(fixture, "DT_Scalars.uasset"), join(content, "DT_Scalars.uasset"));
		await application.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, root);
		const page = workbench.page;
		await page.getByRole("button", { name: "Open your project", exact: true }).click();

		await expect(page.getByRole("button", { name: basename(root), exact: true })).toBeVisible();
		await workbench.openRoute("Data Authoring");
		const catalog = page.getByRole("navigation", { name: "Project DataTables" });
		await catalog.getByRole("button", { name: /^DT_Scalars\b/ }).click();
		await page.getByRole("button", { name: "Duplicate row", exact: true }).click();
		const editor = page.getByRole("form", { name: "Row name editor" });
		await editor.getByLabel("Row name", { exact: true }).fill("SelectedProjectDraft");
		await editor.getByRole("button", { name: "Stage row" }).click();
		await expect(page.getByRole("button", { name: "Review 1", exact: true })).toBeVisible();
		await copyFile(
			join(fixture, "DT_LeftReferences.uasset"),
			join(content, "DT_LeftReferences.uasset")
		);
		await catalog.getByRole("button", { name: "Refresh project DataTables" }).click();
		await expect(catalog.getByRole("button", { name: /^DT_LeftReferences\b/ })).toBeVisible();
		await workbench.openRoute("Showcase");
		await page.getByRole("button", { name: "Try the sample project", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "unreal-project", exact: true })
		).toBeVisible();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("saves the edited scenario document and reopens it with a matching replay command", async ({
	workbench,
	application
}) => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-e2e-scenario-"));
	const path = join(root, "draft.json");
	try {
		await application.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
		}, path);
		await workbench.openRoute("Scenario Studio");
		const page = workbench.page;
		await page.getByRole("button", { name: "Nudge later" }).click();
		await page.getByRole("button", { name: "Save draft…" }).click();
		await expect(page.getByRole("status")).toContainText("Saved " + path);
		const saved = await readFile(path, "utf8");
		expect(JSON.parse(saved)).not.toEqual(movementGymScenario);
		await expect(page.getByText(/pnpm ue-shed scenarios run.*--document/)).toContainText(path);
		await page.getByRole("button", { name: "Nudge later" }).click();
		await expect(
			page.getByText("Save the draft to generate its PowerShell replay command.")
		).toBeVisible();
		await page.getByRole("button", { name: "Open draft…" }).click();
		await expect(page.getByRole("status")).toContainText("Opened " + path);
		await expect(page.getByText(/pnpm ue-shed scenarios run.*--document/)).toBeVisible();
		await workbench.openRoute("Showcase");
		await workbench.openRoute("Scenario Studio");
		await expect(page.getByText(/pnpm ue-shed scenarios run.*--document/)).toContainText(path);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("keeps reviewed and saved Game Text rules across tabs, navigation, and preset export", async ({
	workbench,
	application
}) => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-e2e-rule-state-"));
	const rulePath = join(root, "rules.json");
	const presetPath = join(root, "preset.json");
	try {
		await copyFile(
			resolve("../../fixtures/unreal-project/FixtureSource/Text/quality-rules.json"),
			rulePath
		);
		await application.evaluate(
			({ dialog }, paths) => {
				dialog.showOpenDialog = async () => ({
					canceled: false,
					filePaths: [paths.rulePath]
				});
				dialog.showSaveDialog = async () => ({
					canceled: false,
					filePath: paths.presetPath
				});
			},
			{ rulePath, presetPath }
		);
		await workbench.openRoute("Game Text");
		const page = workbench.page;
		await page.getByRole("tab", { name: "Quality", exact: true }).click();
		await page.getByRole("button", { name: "Load rules" }).click();
		await page.getByRole("tab", { name: /^Rules/ }).click();
		const maximum = page.getByRole("spinbutton", {
			name: "Maximum characters for fixture.prompt.characters"
		});
		await maximum.fill("64");
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(page.getByText(/Changes are not saved yet/)).toBeVisible();
		await page.getByRole("tab", { name: /^Findings/ }).click();
		await page.getByRole("tab", { name: /^Rules/ }).click();
		await expect(maximum).toHaveValue("64");
		await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
		expect(JSON.parse(await readFile(rulePath, "utf8")).rules[0].maximumCharacters).toBe(10);
		const toolbar = page.getByRole("region", { name: "Investigation files" });
		await toolbar.getByRole("button", { name: "Save preset" }).click();
		await expect(toolbar.getByRole("status")).toContainText("Saved preset:");
		expect(
			JSON.parse(await readFile(presetPath, "utf8")).rules.rules[0].maximumCharacters
		).toBe(64);
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByText("Rule file saved.", { exact: true })).toBeVisible();
		expect(JSON.parse(await readFile(rulePath, "utf8")).rules[0].maximumCharacters).toBe(64);
		await page.getByRole("tab", { name: /^Findings/ }).click();
		await page.getByRole("tab", { name: /^Rules/ }).click();
		await expect(maximum).toHaveValue("64");
		await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
		await workbench.openRoute("Showcase");
		await workbench.openRoute("Game Text");
		await page.getByRole("tab", { name: /^Rules/ }).click();
		await expect(maximum).toHaveValue("64");
		await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("restores Game Text and Texture Audit searches after navigating away", async ({
	workbench,
	application
}) => {
	test.setTimeout(90_000);
	const page = workbench.page;
	await workbench.openRoute("Game Text");
	const textSearch = page.getByRole("searchbox", { name: "Search game text", exact: true });
	await textSearch.fill("Look around");
	await expect(page.getByRole("complementary", { name: "Text focus" })).toContainText(
		"Look around"
	);
	await workbench.openRoute("Texture Audit");
	const textureSearch = page.getByRole("textbox", { name: "Search textures" });
	await textureSearch.pressSequentially("NonPowerOfTwo", { delay: 20 });
	await expect(textureSearch).toHaveValue("NonPowerOfTwo");
	await expect(textureSearch).toBeFocused();
	await workbench.openRoute("Game Text");
	await expect(textSearch).toHaveValue("Look around");
	await expect(page.getByRole("complementary", { name: "Text focus" })).toContainText(
		"Look around"
	);
	await workbench.openRoute("Texture Audit");
	await expect(textureSearch).toHaveValue("NonPowerOfTwo");
	await workbench.openRoute("Game Text");
	await application.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, resolve("../../fixtures/unreal-project/FixtureSource/Text/quality-rules.json"));
	await page.getByRole("tab", { name: "Quality", exact: true }).click();
	await page.getByRole("button", { name: "Load rules", exact: true }).click();
	await expect(page.getByRole("complementary", { name: "Quality filters" })).toBeVisible();
	await workbench.openRoute("Showcase");
	await workbench.openRoute("Game Text");
	await expect(page.getByRole("tab", { name: /^Quality/ })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(page.getByRole("complementary", { name: "Quality filters" })).toBeVisible();
});

for (const route of ["Game Text", "Texture Audit"] as const) {
	test(
		"exports and restores a " + route + " investigation",
		async ({ workbench, application }) => {
			test.setTimeout(90_000);
			const root = await mkdtemp(join(tmpdir(), "ue-shed-e2e-investigation-"));
			const exportPath = join(root, "export.json");
			const presetPath = join(root, "preset.json");
			try {
				await workbench.openRoute(route);
				const page = workbench.page;
				const toolbar = page.getByRole("region", { name: "Investigation files" });
				await expect(toolbar.getByRole("button", { name: "Export JSON" })).toBeEnabled();
				await application.evaluate(({ dialog }, path) => {
					dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
				}, exportPath);
				await toolbar.getByRole("button", { name: "Export JSON" }).click();
				await expect(toolbar.getByRole("status")).toContainText("Exported ");
				const exported = JSON.parse(await readFile(exportPath, "utf8"));
				expect(exported.source.generation).toBeGreaterThanOrEqual(1);
				const rows =
					route === "Game Text" ? exported.result.corpus.units : exported.result.records;
				expect(rows.length).toBeGreaterThan(0);
				const search = page.getByRole(route === "Game Text" ? "searchbox" : "textbox", {
					name: route === "Game Text" ? "Search game text" : "Search textures",
					exact: true
				});
				await search.fill(route === "Game Text" ? "Press" : "UI");
				await application.evaluate(({ dialog }, path) => {
					dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
					dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
				}, presetPath);
				await toolbar.getByRole("button", { name: "Save preset" }).click();
				await expect(toolbar.getByRole("status")).toContainText("Saved preset:");
				const preset = JSON.parse(await readFile(presetPath, "utf8"));
				expect(preset.query.query).toBe(route === "Game Text" ? "Press" : "UI");
				if (route === "Texture Audit") expect(preset.rules.rules.length).toBeGreaterThan(0);
				await toolbar.getByRole("button", { name: "Copy CLI replay" }).click();
				await expect(toolbar.getByRole("status")).toHaveText(
					"PowerShell replay command copied."
				);
				const copied = await application.evaluate(({ clipboard }) => clipboard.readText());
				expect(copied).toContain("pnpm ue-shed investigations run");
				expect(copied).toContain(presetPath);
				await search.fill("different settings");
				await expect(toolbar.getByRole("button", { name: "Copy CLI replay" })).toHaveCount(
					0
				);
				await toolbar.getByRole("button", { name: "Open preset" }).click();
				await expect(search).toHaveValue(preset.query.query);
				await expect(toolbar.getByRole("button", { name: "Export CSV" })).toBeEnabled();
				const csvPath = join(root, "export.csv");
				await application.evaluate(({ dialog }, path) => {
					dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
				}, csvPath);
				await toolbar.getByRole("button", { name: "Export CSV" }).click();
				await expect(toolbar.getByRole("status")).toContainText("Exported ");
				expect(await readFile(csvPath, "utf8")).toContain('"metadata"');
				if (route === "Game Text") {
					const rules = JSON.parse(
						await readFile(
							resolve(
								"../../fixtures/unreal-project/FixtureSource/Text/quality-rules.json"
							),
							"utf8"
						)
					);
					await writeFile(
						presetPath,
						JSON.stringify({
							...preset,
							query: {
								...preset.query,
								mode: "quality",
								qualityFilter: "character_budget"
							},
							rules
						})
					);
					await toolbar.getByRole("button", { name: "Open preset" }).click();
					await expect(
						page.getByRole("button", { name: /Character budgets/, pressed: true })
					).toBeVisible();
					await application.evaluate(({ dialog }, path) => {
						dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
					}, exportPath);
					await toolbar.getByRole("button", { name: "Export JSON" }).click();
					await expect(toolbar.getByRole("status")).toContainText("Exported ");
					const quality = JSON.parse(await readFile(exportPath, "utf8"));
					expect(quality.result.mode).toBe("quality");
					expect(quality.result.report.findings.length).toBeGreaterThan(0);
					expect(
						quality.result.report.findings.every(
							(finding: { kind: string }) => finding.kind === "character_budget"
						)
					).toBe(true);
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	);
}
