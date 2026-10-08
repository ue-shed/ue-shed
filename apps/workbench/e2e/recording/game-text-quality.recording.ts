import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { Schema } from "effect";
import { _electron as electron } from "playwright";
import { WorkbenchPage } from "../pages/workbench-page.js";

const require = createRequire(import.meta.url);
const electronExecutable: unknown = require("electron");
const workbenchRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceRuleFile = resolve(
	workbenchRoot,
	"../../fixtures/unreal-project/FixtureSource/Text/quality-rules.json"
);

if (!Schema.is(Schema.String)(electronExecutable)) {
	throw new TypeError("The Electron package did not resolve to an executable path");
}

test.skip(
	process.env.UE_SHED_RECORD_GAME_TEXT_QUALITY !== "true",
	"Launch explicitly with UE_SHED_RECORD_GAME_TEXT_QUALITY=true"
);

function displayedCount(label: string): number {
	const digits = /([\d,]+)/u.exec(label)?.[1];
	if (digits === undefined) throw new Error(`Missing count in: ${label}`);
	const count = Number(digits.replaceAll(",", ""));
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error(`Invalid count in: ${label}`);
	}
	return count;
}

test("records the real Game Text quality workflow", async ({
	browserName: _browserName
}, testInfo) => {
	if (!process.env.UE_SHED_UASSET_EXECUTABLE) {
		throw new Error("Set UE_SHED_UASSET_EXECUTABLE before recording the Workbench");
	}
	await mkdir(testInfo.outputDir, { recursive: true });
	const editableRuleFile = testInfo.outputPath("editable-quality-rules.json");
	await copyFile(sourceRuleFile, editableRuleFile);
	const originalRules = await readFile(editableRuleFile, "utf8");
	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	const application = await electron.launch({
		args: [workbenchRoot],
		cwd: workbenchRoot,
		env: { ...environment, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
		executablePath: electronExecutable
	});
	const page = await application.firstWindow();
	const workbench = new WorkbenchPage(page);
	let recording = false;
	try {
		await page.setViewportSize({ width: 1440, height: 900 });
		const baselineFile = testInfo.outputPath("localization.baseline.json");
		await application.evaluate(
			({ BrowserWindow, dialog }, paths) => {
				const selectedRuleFile = paths.rules;
				BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
				const original = dialog.showOpenDialog.bind(dialog);
				Object.defineProperty(dialog, "showOpenDialog", {
					configurable: true,
					value: (...args: Parameters<typeof dialog.showOpenDialog>) => {
						const options = args.at(-1);
						if (options?.title === "Compare localization baseline")
							return Promise.resolve({
								canceled: false,
								filePaths: [paths.baseline]
							});
						if (options?.title !== "Choose Game Text quality rules")
							return original(...args);
						return Promise.resolve({ canceled: false, filePaths: [selectedRuleFile] });
					}
				});
				const originalSave = dialog.showSaveDialog.bind(dialog);
				Object.defineProperty(dialog, "showSaveDialog", {
					configurable: true,
					value: (...args: Parameters<typeof dialog.showSaveDialog>) => {
						const options = args.at(-1);
						if (options?.title === "Save localization baseline")
							return Promise.resolve({ canceled: false, filePath: paths.baseline });
						return originalSave(...args);
					}
				});
			},
			{ rules: editableRuleFile, baseline: baselineFile }
		);

		await workbench.expectShowcaseReady();
		// A fresh recording starts with the setup notice, independent of saved UI preferences.
		await page.evaluate(() => {
			for (const key of Object.keys(localStorage)) {
				if (key.startsWith("ue-shed:game-text:")) localStorage.removeItem(key);
			}
		});
		await workbench.openRoute("Game Text");
		await page.getByRole("button", { name: "Scan project", exact: true }).click();

		const results = page.getByRole("region", { name: "Results" });
		const search = page.getByRole("searchbox", { name: "Search game text" });
		const searchCount = search.locator("..").getByRole("status");
		const allText = page.getByRole("button", { name: /^All text(?: [\d,]+)?$/u });
		const editable = page.getByRole("button", { name: /^Editable(?: [\d,]+)?$/u });
		const textDetail = page.getByRole("complementary", { name: "Text focus" });
		const qualityTab = page.getByRole("tab", { name: /^Quality checks/u });
		const coverage = page
			.getByRole("main")
			.getByText(/^[\d,]+ lines? (?:in|·) [\d,]+ assets?/u);

		await expect(results).toBeVisible();
		await expect(searchCount).toHaveText(/^[\d,]+ match(?:es)?$/u);
		await expect(coverage).toContainText("scanned");
		const lines = displayedCount(await coverage.innerText());
		expect(lines).toBeGreaterThan(0);
		await expect(allText).toHaveAccessibleName(`All text ${lines.toLocaleString()}`);
		await expect(searchCount).toHaveText(
			`${lines.toLocaleString()} ${lines === 1 ? "match" : "matches"}`
		);
		await expect(textDetail).toContainText(
			"Select a line to see its key, translator notes and every place it appears."
		);
		await expect(page.getByRole("button", { name: "Rescan", exact: true })).toBeEnabled();

		const screenshot = await page.screenshot({ type: "png" });
		const requestedSize = {
			height: screenshot.readUInt32BE(20) & ~1,
			width: screenshot.readUInt32BE(16) & ~1
		};
		let resolveFirstFrame: (value: {
			readonly height: number;
			readonly width: number;
		}) => void = () => undefined;
		const firstFrame = new Promise<{ readonly height: number; readonly width: number }>(
			(resolve) => {
				resolveFirstFrame = resolve;
			}
		);
		await page.screencast.start({
			onFrame: ({ viewportHeight, viewportWidth }) =>
				resolveFirstFrame({ height: viewportHeight, width: viewportWidth }),
			size: requestedSize
		});
		const streamedSize = await firstFrame;
		await page.screencast.stop();
		await page.screencast.start({
			path: testInfo.outputPath("game-text-quality-demo.webm"),
			size: { height: streamedSize.height & ~1, width: streamedSize.width & ~1 }
		});
		recording = true;

		const tabs = page.getByRole("tablist", { name: "Game Text view" });
		const initialToolbar = await tabs.boundingBox();
		if (!initialToolbar) throw new Error("Game Text toolbar has no layout");
		const expectPaneLayout = async (list: Locator, detail: Locator) => {
			const [toolbarBox, listBox, detailBox] = await Promise.all([
				tabs.boundingBox(),
				list.boundingBox(),
				detail.boundingBox()
			]);
			if (!toolbarBox || !listBox || !detailBox) throw new Error("Missing pane layout");
			expect(toolbarBox.y).toBe(initialToolbar.y);
			for (const box of [listBox, detailBox]) {
				expect(box.y).toBeGreaterThan(toolbarBox.y + toolbarBox.height);
				expect(box.y + box.height).toBeLessThanOrEqual(900);
				expect(box.y + box.height).toBeGreaterThanOrEqual(868);
			}
			expect(listBox.y).toBe(detailBox.y);
			for (const pane of [list, detail]) {
				await expect(pane).toHaveCSS("overflow-y", "auto");
			}
			expect(
				await page
					.locator("html")
					.evaluate((element) => element.ownerDocument.scrollingElement?.scrollTop ?? 0)
			).toBe(0);
		};

		await expectPaneLayout(results, textDetail);
		for (const label of ["Export", "Presets", "Rescan"]) {
			const button = page.getByRole("button", { name: label, exact: true });
			await expect(button).toHaveCSS("height", "26px");
		}
		await page.screenshot({ path: testInfo.outputPath("01-text.png") });
		await page.waitForTimeout(1_000);

		const continueLine = results.getByRole("button").filter({
			hasText: "ST_Game · PromptContinue"
		});
		if (!(await continueLine.count())) {
			await results.getByRole("button", { name: /^Show [\d,]+ more$/u }).click();
		}
		await expect(continueLine).toHaveCount(1);
		await continueLine.click();
		await expect(
			textDetail.getByRole("heading", { name: "Continue", exact: true })
		).toBeVisible();
		await expect(textDetail).toContainText("PromptContinue");
		await expect(textDetail).toContainText(
			/[\d,]+ characters? · [\d,]+ words? · [\d,]+ locations?/u
		);
		await expect(textDetail.getByRole("heading", { name: "Where it appears" })).toBeVisible();
		await expect(textDetail).toContainText("String table entry");
		await expect(textDetail).toContainText("/Game/Fixture/Text/ST_Game.ST_Game");
		await expect(textDetail).toContainText("Continue from the pause menu");
		await expectPaneLayout(results, textDetail);
		expect(await results.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		await expect(search).toBeInViewport();
		const copyKey = textDetail.getByRole("button", { name: "Copy key" });
		const copyAsset = textDetail.getByRole("button", { name: "Copy asset path" });
		await expect(copyKey).toHaveCSS("width", "26px");
		await expect(copyAsset).toHaveCSS("width", "26px");
		await expect(textDetail.getByRole("button", { name: "Copy text" })).toHaveCSS(
			"width",
			"26px"
		);
		await expect(textDetail.getByRole("button", { name: "Show in Unreal" })).toBeEnabled();
		await expect(textDetail.getByText("Saved file", { exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("02-text-selected.png") });
		await page.waitForTimeout(1_200);

		await search.fill("Hold");
		await editable.click();
		await expect(editable).toHaveAttribute("aria-pressed", "true");
		const holdLine = results.getByRole("button").filter({ hasText: "Hold to skip" });
		await expect(holdLine).toHaveCount(1);
		await expect(searchCount).toHaveText(/^[\d,]+ match(?:es)?$/u);
		const matches = displayedCount(await searchCount.innerText());
		expect(matches).toBeGreaterThan(0);
		expect(matches).toBeLessThan(lines);
		await expect(allText).toHaveAccessibleName(`All text ${matches.toLocaleString()}`);
		await expect(editable).toHaveAccessibleName(`Editable ${matches.toLocaleString()}`);
		await holdLine.click();
		await expect(textDetail.getByRole("heading", { name: "Hold to skip" })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("03-text-search.png") });
		await page.waitForTimeout(1_200);

		await search.clear();
		await editable.click();
		await expect(editable).toHaveAttribute("aria-pressed", "false");
		await expect(searchCount).toHaveText(
			`${lines.toLocaleString()} ${lines === 1 ? "match" : "matches"}`
		);
		await expect(allText).toHaveAccessibleName(`All text ${lines.toLocaleString()}`);
		await qualityTab.click();
		const setup = page.getByRole("region", { name: "Quality rules setup" });
		await expect(setup).toContainText("Set up writing checks");
		await expect(setup.getByRole("button", { name: "Create rules file" })).toBeVisible();
		await expect(setup.getByRole("button", { name: "Load rules", exact: true })).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath("04-quality-setup.png") });
		await page.waitForTimeout(1_200);

		await setup.getByRole("button", { name: "Load rules", exact: true }).click();
		const findings = page.getByRole("region", { name: "Findings" });
		const findingDetail = page.getByRole("complementary", { name: "Finding detail" });
		const allFindings = page.getByRole("button", { name: /^All findings [\d,]+$/u });
		const characterLimits = page.getByRole("button", { name: /^Character limits [\d,]+$/u });
		const terminology = page.getByRole("button", { name: /^Terminology [\d,]+$/u });
		const rulesOverview = page.getByRole("table", { name: "Rules overview" });
		const rolesOverview = page.getByRole("table", { name: "Roles overview" });
		await expect(findings).toBeVisible();
		await expect(findings.getByText("Loading findings…", { exact: true })).toBeHidden();
		await expect(rulesOverview).toContainText("fixture.prompt.characters");
		await expect(rulesOverview).toContainText("fixture.prompt.terms");
		await expect(rolesOverview).toContainText("fixture.prompt");
		await expect(findingDetail.locator("mark")).toHaveCount(0);
		const initialBudgets = displayedCount(await characterLimits.innerText());
		const initialTerms = displayedCount(await terminology.innerText());
		expect(initialBudgets).toBeGreaterThan(0);
		expect(initialTerms).toBeGreaterThan(1);
		const builtInCount =
			displayedCount(await allFindings.innerText()) - initialBudgets - initialTerms;
		expect(builtInCount).toBeGreaterThan(0);
		const expectFindingCounts = async (budgets: number, terms: number) => {
			const total = budgets + terms + builtInCount;
			await expect(allFindings).toHaveAccessibleName(
				`All findings ${total.toLocaleString()}`
			);
			if (budgets > 0)
				await expect(characterLimits).toHaveAccessibleName(
					`Character limits ${budgets.toLocaleString()}`
				);
			else await expect(characterLimits).toHaveCount(0);
			await expect(terminology).toHaveAccessibleName(`Terminology ${terms.toLocaleString()}`);
			await expect(qualityTab).toHaveAccessibleName(`Quality checks (${total})`);
		};
		await expectFindingCounts(initialBudgets, initialTerms);
		const initialFindingTotal = initialBudgets + initialTerms + builtInCount;
		await expect(findings.getByRole("button", { name: /^Show [\d,]+ more$/u })).toHaveCount(
			initialFindingTotal > 50 ? 1 : 0
		);
		await expect(findings.getByRole("button").filter({ hasText: / · /u })).toHaveCount(
			Math.min(50, initialFindingTotal)
		);
		await expectPaneLayout(findings, findingDetail);
		await page.screenshot({ path: testInfo.outputPath("05-quality-overview.png") });
		await page.waitForTimeout(1_700);

		await terminology.click();
		const skipFinding = findings.getByRole("button").filter({ hasText: "Remove “skip”" });
		await expect(skipFinding).toHaveCount(1);
		await expect(terminology).toHaveAttribute("aria-pressed", "true");
		await expect(findings.getByRole("button")).toHaveCount(initialTerms);
		await expect(findings.getByText("Loading findings…", { exact: true })).toBeHidden();
		await skipFinding.click();
		await expect(findingDetail.locator("mark")).toHaveText("skip");
		await expect(findingDetail.getByRole("heading", { name: "Hold to skip" })).toBeVisible();
		await expect(findingDetail.getByRole("heading", { name: "How to fix" })).toBeVisible();
		await expect(findingDetail).toContainText("/Game/Fixture/Text/ST_Game.ST_Game");
		await expect(skipFinding).toContainText("ST_Game · PromptHold");
		await expect(skipFinding).toContainText("1 location");
		await expect(findingDetail.getByRole("button", { name: "Show in Unreal" })).toBeEnabled();
		await expect(findingDetail.getByRole("button", { name: "Copy asset path" })).toBeEnabled();
		await expectPaneLayout(findings, findingDetail);
		await page.screenshot({ path: testInfo.outputPath("06-quality-finding.png") });
		await page.waitForTimeout(1_500);

		await page.getByRole("button", { name: "Edit rules", exact: true }).click();
		const ruleForm = page.getByRole("region", { name: "Selected quality rule" });
		const ruleList = page.getByRole("complementary", { name: "Quality rule list" });
		const maximumCharacters = ruleForm.getByRole("spinbutton", {
			name: "Maximum characters for fixture.prompt.characters"
		});
		await expect(maximumCharacters).toHaveValue("10");
		await expect(
			page.getByRole("complementary", { name: "Quality role scopes" })
		).toContainText("String Table key starts with Prompt");
		await expect(ruleForm.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
		const savedState = ruleForm.getByText("Saved", { exact: true });
		await expect(savedState).toBeVisible();
		expect(
			await savedState.evaluate(
				(element) => element.ownerDocument.defaultView?.getComputedStyle(element).color
			)
		).toBe(
			await coverage.evaluate(
				(element) => element.ownerDocument.defaultView?.getComputedStyle(element).color
			)
		);
		await expectPaneLayout(ruleList, ruleForm);
		await page.screenshot({ path: testInfo.outputPath("07-rule-editor.png") });
		await page.waitForTimeout(1_300);

		await maximumCharacters.fill("20");
		await page.waitForTimeout(900);
		await ruleForm.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(ruleForm.getByRole("status")).toContainText("Preview updated.");
		await expectFindingCounts(0, initialTerms);
		expect(await readFile(editableRuleFile, "utf8")).toBe(originalRules);
		await page.waitForTimeout(1_200);
		await ruleForm.getByRole("button", { name: "Save", exact: true }).click();
		await expect(ruleForm.getByRole("status")).toContainText("Rule file saved.");
		expect(await readFile(editableRuleFile, "utf8")).toContain('"maximumCharacters": 20');
		await page.waitForTimeout(1_300);
		await page.getByRole("button", { name: "Close rules", exact: true }).click();
		await expect(findings.getByText("Loading findings…", { exact: true })).toBeHidden();
		await expect(skipFinding).toBeVisible();
		await expect(findings.getByRole("button")).toHaveCount(initialTerms);

		await page.getByRole("button", { name: "Edit rules", exact: true }).click();
		await ruleList.getByRole("button", { name: /fixture\.prompt\.terms/u }).click();
		const forbiddenTerm = ruleForm.getByRole("textbox", { name: "Forbidden term 1" });
		await expect(forbiddenTerm).toHaveValue("skip");
		await forbiddenTerm.fill("pause");
		await page.waitForTimeout(900);
		await ruleForm.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(ruleForm.getByRole("status")).toContainText("Preview updated.");
		await expectFindingCounts(0, initialTerms - 1);
		expect(await readFile(editableRuleFile, "utf8")).toContain('"term": "skip"');
		await page.waitForTimeout(1_200);
		await ruleForm.getByRole("button", { name: "Save", exact: true }).click();
		await expect(ruleForm.getByRole("status")).toContainText("Rule file saved.");
		await page.waitForTimeout(1_300);

		await page.getByRole("button", { name: "Close rules", exact: true }).click();
		await expect(findings.getByText("Loading findings…", { exact: true })).toBeHidden();
		await expect(findings.getByRole("button")).toHaveCount(initialTerms - 1);
		await expect(skipFinding).toHaveCount(0);
		const preferredFinding = findings.getByRole("button").filter({
			hasText: "Prefer “proceed”"
		});
		await preferredFinding.click();
		await expect(findingDetail.locator("mark")).toHaveText("Continue");
		await expect(findingDetail.getByRole("heading", { name: "How to fix" })).toBeVisible();
		await expectFindingCounts(0, initialTerms - 1);
		await page.waitForTimeout(1_500);
		await page.screenshot({ path: testInfo.outputPath("final.png") });

		await page.getByRole("tab", { name: "Text", exact: true }).click();
		const culture = page.getByRole("button", { name: /^Culture:/u });
		await expect(culture).toBeVisible();
		await culture.click();
		const cultureChoices = page.getByRole("dialog", { name: "Culture choices" });
		await expect(cultureChoices.getByRole("button")).toHaveCount(4);
		await expect(cultureChoices.getByRole("button").first()).toHaveAccessibleName(
			"All cultures"
		);
		for (const code of ["en", "de", "fr"]) {
			await expect(
				cultureChoices.getByRole("button", { name: code, exact: true })
			).toBeVisible();
		}
		await cultureChoices.getByRole("button", { name: "de", exact: true }).click();
		await expect(culture).toHaveAccessibleName("Culture: de");
		await expect(culture).toHaveCSS("height", "26px");
		await expect(searchCount).toHaveText(/^[\d,]+ match(?:es)?$/u);
		await expect(allText).toHaveAccessibleName(`All text ${lines.toLocaleString()}`);
		const unsyncedIndicator = page.getByRole("status").filter({
			hasText: /^[\d,]+ not synced$/u
		});
		await expect(unsyncedIndicator).toBeVisible();
		await expect(unsyncedIndicator).toHaveAttribute(
			"title",
			"Translations saved in PO files that Unreal has not imported yet"
		);
		const pendingTranslations = displayedCount(await unsyncedIndicator.innerText());
		expect(pendingTranslations).toBeGreaterThan(0);
		// This line exercises native/de/fr stacking and translations with named arguments.
		const namedLine = results.getByRole("button").filter({
			hasText: "ST_Localization · NamedArgument"
		});
		// Large targets page through the same bounded query; keep the recording independent of order.
		if (!(await namedLine.count())) {
			const more = results.getByRole("button", { name: /^Show [\d,]+ more$/u });
			await expect(more).toBeVisible();
			await more.click();
		}
		await expect(namedLine).toHaveCount(1);
		await expect(results).toContainText("Gespräch mit {Name}");
		await expect(page.getByText("Loading translations…", { exact: true })).toHaveCount(0);
		await expectPaneLayout(results, textDetail);
		await page.screenshot({ path: testInfo.outputPath("08-culture-de.png") });
		await namedLine.click();
		const translations = textDetail.getByRole("region", { name: "Translations" });
		await expect(
			translations.getByRole("article", { name: "Translation de", exact: true })
		).toContainText("Gespräch mit {Name}");
		await expect(
			translations.getByRole("article", { name: "Translation en", exact: true })
		).toContainText("Talking with {PlayerName}");
		await expect(
			translations.getByRole("article", { name: "Translation fr", exact: true })
		).toContainText("Discussion avec {PlayerName}");
		await expect(translations.getByText("Manifest key path")).toBeVisible();
		await expect(translations.getByText("Loading translations…", { exact: true })).toHaveCount(
			0
		);
		await expectPaneLayout(results, textDetail);
		const outdated = results
			.getByRole("button")
			.filter({ hasText: "DA_Localization · SharedPrimary" });
		await outdated.click();
		await expect(textDetail.getByRole("heading", { name: "Open the gate" })).toBeVisible();
		await expect(
			translations.getByRole("article", { name: "Translation en", exact: true })
		).toContainText("Translated");
		await expect(
			translations.getByRole("article", { name: "Translation de", exact: true })
		).toContainText("Needs update");
		const outdatedGerman = translations.getByRole("article", {
			name: "Translation de",
			exact: true
		});
		await expect(outdatedGerman).toContainText(
			"Open the gate (source text — the translation is out of date)"
		);
		await expect(outdatedGerman).toContainText("Translation (out of date)");
		await expect(outdatedGerman).toContainText("Die Tür öffnen");
		await expect(outdatedGerman).toContainText("Written for this source");
		await expect(outdatedGerman).toContainText("Open the door");
		// Review toggles show for reviewable translations; the recording never writes the review file.
		await expect(
			outdatedGerman
				.getByRole("group", { name: "Review de", exact: true })
				.getByRole("button", { name: "Reviewed", exact: true })
		).toBeEnabled();
		await expect(translations.getByText("In PO, not synced", { exact: true })).toHaveCount(0);
		await expect(
			translations.getByRole("article", { name: "Translation fr", exact: true })
		).toContainText("Needs update");
		await expect(translations.getByText("Loading translations…", { exact: true })).toHaveCount(
			0
		);
		await expectPaneLayout(results, textDetail);
		await translations
			.getByRole("heading", { name: "Translations", exact: true })
			.evaluate((element) => element.scrollIntoView({ block: "start" }));
		await expectPaneLayout(results, textDetail);
		await page.screenshot({ path: testInfo.outputPath("09-translations-detail.png") });

		const notSynced = page.getByRole("button", { name: /^Not synced [\d,]+$/u });
		const unsyncedLines = displayedCount(await notSynced.innerText());
		expect(unsyncedLines).toBeGreaterThan(0);
		await notSynced.click();
		await expect(notSynced).toHaveAttribute("aria-pressed", "true");
		await expect(searchCount).toHaveText(
			`${unsyncedLines.toLocaleString()} ${unsyncedLines === 1 ? "match" : "matches"}`
		);
		await expect(allText).toHaveAccessibleName(`All text ${unsyncedLines.toLocaleString()}`);
		await expect(results.getByRole("button")).toHaveCount(unsyncedLines);
		await expect(unsyncedIndicator).toHaveText(
			`${pendingTranslations.toLocaleString()} not synced`
		);
		await expect(results).toContainText("Eine frische Sitzung beginnen");
		const pendingLine = results
			.getByRole("button")
			.filter({ hasText: "ST_Localization · Unsynced" });
		await pendingLine.click();
		await expect(translations.getByText("In PO, not synced")).toBeVisible();
		await expect(translations.getByText("Loading translations…", { exact: true })).toHaveCount(
			0
		);
		await expectPaneLayout(results, textDetail);
		await translations
			.getByRole("article", { name: "Translation de", exact: true })
			.evaluate((element) => element.scrollIntoView({ block: "start" }));
		await expectPaneLayout(results, textDetail);
		await page.screenshot({ path: testInfo.outputPath("10-not-synced.png") });

		await notSynced.click();
		await culture.click();
		await cultureChoices.getByRole("button", { name: "All cultures", exact: true }).click();
		await expect(culture).toHaveAccessibleName("Culture: All cultures");
		await expect(searchCount).toHaveText(
			`${lines.toLocaleString()} ${lines === 1 ? "match" : "matches"}`
		);
		await expect(allText).toHaveAccessibleName(`All text ${lines.toLocaleString()}`);
		await expect(results).toContainText("de · needs update");
		await expect(results).toContainText("fr · needs update");
		// The pending edit is beyond the first page of all lines; filter to it, then clear the filter.
		await notSynced.click();
		await expect(results).toContainText("de · not synced");
		await notSynced.click();
		await expect(results.getByText("Outside this target", { exact: true })).toHaveCount(0);
		await expect(results.getByText("Gathered only", { exact: true })).toHaveCount(0);
		await expect(results).not.toContainText("en · translated");
		await expect(page.getByText("Loading translations…", { exact: true })).toHaveCount(0);
		await outdated.click();
		await expect(outdatedGerman).toContainText(
			"Open the gate (source text — the translation is out of date)"
		);
		await expectPaneLayout(results, textDetail);
		await page.screenshot({ path: testInfo.outputPath("11-all-cultures.png") });

		await culture.click();
		await cultureChoices.getByRole("button", { name: "de", exact: true }).click();
		await expect(culture).toHaveAccessibleName("Culture: de");
		await qualityTab.click();
		const formatArguments = page.getByRole("button", { name: /^Format arguments [\d,]+$/u });
		await expect(formatArguments).toBeVisible();
		const formatCount = displayedCount(await formatArguments.innerText());
		await formatArguments.click();
		await expect(formatArguments).toHaveAttribute("aria-pressed", "true");
		await expect(findings.getByText("Loading findings…", { exact: true })).toBeHidden();
		expect(formatCount).toBeGreaterThan(0);
		await expect(findings.getByRole("button").filter({ hasText: / · /u })).toHaveCount(
			Math.min(50, formatCount)
		);
		const argumentFinding = findings
			.getByRole("button")
			.filter({ hasText: "ST_Localization · NamedArgument" });
		await argumentFinding.click();
		const suggested = findingDetail.getByRole("region", { name: "Suggested fix" });
		await expect(suggested).toBeVisible();
		await expect(
			findingDetail.getByRole("heading", { name: "Talking with {PlayerName}" })
		).toBeVisible();
		await expect(findingDetail.locator("h2 mark")).toHaveText("{PlayerName}");
		await expect(suggested).toContainText("Gespräch mit {Name}");
		await expect(suggested).toContainText("Gespräch mit {PlayerName}");
		await expect(suggested.locator("mark")).toHaveText(["{Name}", "{PlayerName}"]);
		await expect(
			findingDetail.getByText("Translation the game uses", { exact: true })
		).toBeVisible();
		await expect(suggested.getByRole("button", { name: "Copy change set" })).toBeEnabled();
		await expect(suggested).toContainText(
			"Edit the translation in Text to stage it, or copy the change set for ue-shed loc apply."
		);
		await expect(
			findingDetail.getByRole("button", { name: "Accept as intended", exact: true })
		).toBeEnabled();
		await expectPaneLayout(findings, findingDetail);
		await suggested.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
		await page.screenshot({ path: testInfo.outputPath("12-localization-findings.png") });

		await page.getByRole("tab", { name: "Reports", exact: true }).click();
		const reportTable = page.getByRole("table", { name: "Localization report" });
		await expect(reportTable).toBeVisible();
		await expect(reportTable.getByRole("row").nth(1)).toHaveAttribute("aria-label", "en");
		await expect(reportTable.getByRole("row")).toHaveCount(4);
		await page.getByRole("button", { name: "Save baseline…" }).click();
		await expect(page.getByText("Baseline saved.", { exact: true })).toBeVisible();
		expect((await stat(baselineFile)).size).toBeGreaterThan(0);
		await page.getByRole("button", { name: "Compare with baseline…" }).click();
		await expect(page.getByText("Baseline compared.", { exact: true })).toBeVisible();
		await expect(reportTable.getByRole("columnheader", { name: "New words" })).toBeVisible();
		for (const code of ["en", "de", "fr"]) {
			const row = reportTable.getByRole("row", { name: code, exact: true });
			await expect(row.getByRole("cell").nth(6)).toHaveText("0");
			await expect(row.getByRole("cell").nth(7)).toHaveText("0");
		}
		await expect(
			page.getByText("Reviewed · Proofread: not tracked yet", { exact: true })
		).toBeVisible();
		await expect(page.getByText("Loading reports…", { exact: true })).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath("13-reports.png") });

		// Planning resolves the engine and lists writes; the recording never starts Unreal.
		const unchangedReport = await reportTable.innerText();
		const pendingIndicator = page.getByText(/^[\d,]+ not synced$/u);
		const unchangedPending = await pendingIndicator.innerText();
		await page.getByRole("button", { name: "Sync with Unreal", exact: true }).click();
		const confirmation = page.getByRole("region", { name: "Confirm Unreal step" });
		await expect(confirmation).toContainText(/Unreal Engine (?:4\.27|5\.[78])/u);
		await expect(confirmation).toContainText("Content/Localization/FixtureGame/");
		await expect(confirmation).toContainText(
			"Check these files out in your source control first"
		);
		await expect(confirmation.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
		await expect(page.getByText("Preparing Unreal step…", { exact: true })).toBeHidden();
		await page.screenshot({ path: testInfo.outputPath("14-sync-plan.png") });
		await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(confirmation).toBeHidden();
		await expect(reportTable).toHaveText(unchangedReport, { useInnerText: true });
		await expect(pendingIndicator).toHaveText(unchangedPending);
		await expect(page.getByText(/Syncing with Unreal/u)).toHaveCount(0);

		// Stage and check a translation edit. The recording uses the committed fixture, so it
		// never writes: it discards the staged edit after checking it against the project's files.
		await page.getByRole("tab", { name: "Text", exact: true }).click();
		await namedLine.click();
		const german = translations.getByRole("article", { name: "Translation de", exact: true });
		await german.getByRole("button", { name: "Edit", exact: true }).click();
		const field = german.getByRole("textbox", { name: "New de translation" });
		await expect(field).toHaveValue("Gespräch mit {Name}");
		await field.fill("Gespräch mit {PlayerName}");
		await german.getByRole("button", { name: "Stage", exact: true }).click();
		await expect(german).toContainText("Staged: Gespräch mit {PlayerName}");
		await page.getByRole("button", { name: "1 staged", exact: true }).click();
		const staged = page.getByRole("region", { name: "Staged translations" });
		await staged.getByRole("button", { name: "Check changes", exact: true }).click();
		await expect(staged).toContainText("Ready to write");
		await expect(staged).toContainText("Content/Localization/FixtureGame/de/FixtureGame.po");
		await expect(
			staged.getByRole("button", { name: "Write to PO", exact: true })
		).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath("15-staged-edit.png") });
		await staged.getByRole("button", { name: "Discard all", exact: true }).click();
		await expect(staged).toBeHidden();
		await expect(pendingIndicator).toHaveText(unchangedPending);
	} finally {
		if (recording) await page.screencast.stop().catch(() => undefined);
		await application.close().catch(() => undefined);
	}
	const video = await stat(testInfo.outputPath("game-text-quality-demo.webm"));
	expect(video.size).toBeGreaterThan(0);
	const savedRules = await readFile(editableRuleFile, "utf8");
	expect(savedRules).toContain('"maximumCharacters": 20');
	expect(savedRules).toContain('"term": "pause"');
});
