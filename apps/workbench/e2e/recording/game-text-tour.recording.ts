import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Disposable, type Locator, type Page } from "@playwright/test";
import { Schema } from "effect";
import { _electron as electron } from "playwright";
import { WorkbenchPage } from "../pages/workbench-page.js";

/**
 * A captioned tour of Game Text for people rather than for regression: it walks every flow at
 * reading pace with a caption under each step, on a copy of the fixture project whose saved
 * DataTable cell has a new key, so key changes, writes and reviews never touch the fixture.
 */

const require = createRequire(import.meta.url);
const electronExecutable: unknown = require("electron");
const workbenchRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtureProject = resolve(workbenchRoot, "../../fixtures/unreal-project");

if (!Schema.is(Schema.String)(electronExecutable)) {
	throw new TypeError("The Electron package did not resolve to an executable path");
}

test.skip(
	process.env.UE_SHED_RECORD_GAME_TEXT_TOUR !== "true",
	"Launch explicitly with UE_SHED_RECORD_GAME_TEXT_TOUR=true"
);

const SKIPPED = new Set([
	"Binaries",
	"Intermediate",
	"Saved",
	"DerivedDataCache",
	"FixtureExpected"
]);

/**
 * Copies the fixture and gives one gathered key an earlier name in Unreal's files, as if the
 * saved DataTable cell's key changed after the last gather.
 */
async function projectWithKeyChange(folder: string) {
	await cp(fixtureProject, folder, {
		recursive: true,
		filter: (source) => !SKIPPED.has(source.split(/[\\/]/u).at(-1) ?? "")
	});
	const localization = join(folder, "Content/Localization/FixtureGame");
	const files = await readdir(localization, { recursive: true });
	for (const name of files) {
		const path = join(localization, name);
		if (name.endsWith(".manifest") || name.endsWith(".archive")) {
			const text = (await readFile(path)).toString("utf16le");
			const renamed = text.replaceAll('"Key": "MissingFrench"', '"Key": "MissingFrenchOld"');
			if (renamed === text) throw new Error(`No key to rename in ${name}`);
			await writeFile(path, Buffer.from(renamed, "utf16le"));
		} else if (name.endsWith(".po")) {
			const text = await readFile(path, "utf8");
			await writeFile(
				path,
				text
					.replaceAll('Rows,MissingFrench"', 'Rows,MissingFrenchOld"')
					.replaceAll("Key:\tMissingFrench\n", "Key:\tMissingFrenchOld\n")
			);
		}
	}
}

const escapeHtml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Captions sit under the page at reading pace: about 15 characters a second, at least 2.5 s. */
function captions(page: Page) {
	let shown: Disposable | undefined;
	const say = async (text: string, extra = 0) => {
		await shown?.dispose();
		shown = await page.screencast.showOverlay(
			`<div style="position:absolute;left:50%;bottom:28px;transform:translateX(-50%);` +
				`max-width:980px;padding:12px 20px;border-radius:10px;` +
				`background:rgba(8,10,14,0.9);border:1px solid rgba(255,255,255,0.14);` +
				`color:#f4f6fa;font:500 19px/1.45 'Segoe UI',system-ui,sans-serif;` +
				`text-align:center;box-shadow:0 8px 28px rgba(0,0,0,0.45)">${escapeHtml(text)}</div>`
		);
		await page.waitForTimeout(Math.max(2_500, text.length * 65) + extra);
	};
	const chapter = async (title: string, description: string) => {
		await shown?.dispose();
		shown = undefined;
		await page.screencast.showChapter(title, { description, duration: 2_600 });
		await page.waitForTimeout(2_800);
	};
	const clear = async () => {
		await shown?.dispose();
		shown = undefined;
	};
	return { say, chapter, clear };
}

test("records a captioned tour of Game Text", async ({ browserName: _browserName }, testInfo) => {
	test.setTimeout(900_000);
	if (!process.env.UE_SHED_UASSET_EXECUTABLE) {
		throw new Error("Set UE_SHED_UASSET_EXECUTABLE before recording the Workbench");
	}
	await mkdir(testInfo.outputDir, { recursive: true });
	const project = testInfo.outputPath("unreal-project");
	await projectWithKeyChange(project);
	const ruleFile = join(project, "FixtureSource/Text/quality-rules.json");
	let exportCount = 0;
	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	const application = await electron.launch({
		args: [workbenchRoot],
		cwd: workbenchRoot,
		env: {
			...environment,
			ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
			UE_SHED_PROJECT_ROOT: project,
			UE_SHED_PROJECT_NAME: "UEShedFixture",
			UE_SHED_REMEMBER_PROJECTS: "false"
		},
		executablePath: electronExecutable
	});
	const page = await application.firstWindow();
	const workbench = new WorkbenchPage(page);
	const video = testInfo.outputPath("game-text-tour.webm");
	let recording = false;
	try {
		await page.setViewportSize({ width: 1440, height: 900 });
		await application.evaluate(
			({ BrowserWindow, dialog }, paths) => {
				BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
				const original = dialog.showOpenDialog.bind(dialog);
				Object.defineProperty(dialog, "showOpenDialog", {
					configurable: true,
					value: (...args: Parameters<typeof dialog.showOpenDialog>) => {
						const options = args.at(-1);
						if (options?.title === "Choose Game Text quality rules")
							return Promise.resolve({ canceled: false, filePaths: [paths.rules] });
						return original(...args);
					}
				});
				let saves = 0;
				Object.defineProperty(dialog, "showSaveDialog", {
					configurable: true,
					value: () => {
						saves += 1;
						return Promise.resolve({
							canceled: false,
							filePath: `${paths.output}/export-${saves}.csv`
						});
					}
				});
			},
			{ rules: ruleFile, output: testInfo.outputDir.replaceAll("\\", "/") }
		);
		await workbench.expectShowcaseReady();
		await page.evaluate(() => {
			for (const key of Object.keys(localStorage)) {
				if (key.startsWith("ue-shed:game-text:")) localStorage.removeItem(key);
			}
		});
		await workbench.openRoute("Game Text");

		// The video stream takes the window's real size.
		const first = await page.screenshot({ type: "png" });
		await page.screencast.start({
			path: video,
			size: { width: first.readUInt32BE(16) & ~1, height: first.readUInt32BE(20) & ~1 }
		});
		recording = true;
		await page.screencast.showActions({
			cursor: "pointer",
			duration: 450,
			fontSize: 15,
			position: "bottom-right"
		});
		const { say, chapter, clear } = captions(page);

		const results = page.getByRole("region", { name: "Results" });
		const side = page.getByRole("complementary", { name: "Text focus" });
		const search = page.getByRole("searchbox", { name: "Search game text" });
		const filterButton = page.getByRole("button", { name: "Filter", exact: true });
		const pills = page.getByRole("list", { name: "Filters" });
		const culture = page.getByRole("button", { name: /^Culture:/u });
		const cultureChoices = page.getByRole("dialog", { name: "Culture choices" });
		const translations = side.getByRole("region", { name: "Translations" });
		const lineRow = (hint: string) => results.getByRole("button").filter({ hasText: hint });
		const back = async () => {
			const lines = page.getByRole("button", { name: "‹ Lines", exact: true });
			if (await lines.count()) await lines.click();
			await expect(results).toBeVisible();
		};
		const reveal = async (line: Locator) => {
			await back();
			for (let attempt = 0; attempt < 16 && (await line.count()) === 0; attempt++) {
				const closed = results.locator('button[aria-expanded="false"]').first();
				const more = results.getByRole("button", { name: /^Show more/u }).first();
				if (await closed.count()) await closed.click();
				else if (await more.count()) await more.click();
				else break;
				await page.waitForTimeout(300);
			}
			await expect(line).toHaveCount(1);
			await line.scrollIntoViewIfNeeded();
		};
		const openField = async (field: string) => {
			await filterButton.click();
			await page.waitForTimeout(500);
			await page.getByRole("menuitem", { name: new RegExp(`^${field}`, "u") }).hover();
			await page.waitForTimeout(700);
			return page.getByRole("menu", { name: field });
		};
		const settle = async () => {
			await expect(page.getByText("Searching…", { exact: true })).toHaveCount(0);
			await expect(page.getByText("Loading translations…", { exact: true })).toHaveCount(0);
		};

		// 1. Scan and the problem list.
		await chapter(
			"Game Text",
			"Review every line of player-facing text and its translations, straight from saved files"
		);
		await say(
			"Game Text reads the project's saved assets and Unreal's localization files. Unreal does not need to be running."
		);
		await page.getByRole("button", { name: "Scan project", exact: true }).click();
		await expect(results.locator('button[aria-expanded="true"]').first()).toBeVisible();
		await settle();
		await say(
			"Every line is grouped by what it needs, worst first: a changed key, then gather work, then translation work, then findings."
		);
		await say(
			"Red marks text whose translations are about to be lost. Amber is waiting on Unreal or a translator. Findings stay grey."
		);
		await say(
			"With no line open, the side pane shows where the lines live: folders, assets and origins, with how many need work."
		);

		// 2. Filter, pills and the folder browser.
		await chapter("Filter", "Narrow the list with pills, Linear-style");
		await say("Filter lists fields. Each one opens its values, with how many lines have them.");
		const problems = await openField("Problem");
		await say("Pick a value and it becomes a pill.");
		await problems.getByRole("menuitemcheckbox", { name: /^Translation work/u }).click();
		await page.keyboard.press("Escape");
		await settle();
		await expect(pills).toContainText("Translation work");
		await say(
			"Every pill must match. Click the middle of a pill to switch between is and is not."
		);
		await pills.getByTitle("Switch to is not", { exact: true }).click();
		await settle();
		await page.waitForTimeout(1_500);
		await pills.getByTitle("Switch to is", { exact: true }).click();
		await settle();
		await say(
			"Folders browse a level at a time, the same way as the side pane, so a project with thousands of folders stays readable."
		);
		const folders = await openField("Folder");
		await folders.getByRole("menuitem", { name: "Folders in Content" }).click();
		await page.waitForTimeout(1_200);
		await folders.getByRole("menuitem", { name: "Folders in Content/Fixture" }).click();
		await page.waitForTimeout(1_200);
		await say("A folder name adds its pill. Typing offers “Path starts with …” for any path.");
		await folders.getByRole("menuitemcheckbox", { name: /^Localization \d/u }).click();
		await page.keyboard.press("Escape");
		await settle();
		await page.waitForTimeout(1_500);
		await say("Remove a pill with its ×, or clear them all.");
		await page.getByRole("button", { name: "Clear filters", exact: true }).click();
		await settle();

		// 3. Display.
		await chapter("Display", "Group by problem, folder, asset, origin or namespace");
		await page.getByRole("button", { name: "Display", exact: true }).click();
		await page.waitForTimeout(600);
		await say("Display regroups the same lines. Here, by asset.");
		await page.getByRole("radio", { name: "Asset" }).click();
		await page.keyboard.press("Escape");
		await settle();
		await say(
			"Each group shows its count and how many of its lines need work. Only open groups load their lines."
		);
		await page.getByRole("button", { name: "Display", exact: true }).click();
		await page.getByRole("radio", { name: "Problem" }).click();
		await page.keyboard.press("Escape");
		await settle();

		// 4. Cultures.
		await chapter("Cultures", "Pick the languages you are working on");
		await say(
			"Each line ends with a strip, one cell per culture: dashed when missing, amber to update, blue when not synced."
		);
		const outdated = lineRow("DA_Localization · SharedPrimary");
		await reveal(outdated);
		await outdated.hover();
		await page.waitForTimeout(1_500);
		await say("The culture picker takes any number of cultures and shows each one's work.");
		await culture.click();
		await page.waitForTimeout(1_200);
		await cultureChoices.getByRole("button", { name: "de", exact: true }).click();
		await page.waitForTimeout(800);
		await page.keyboard.press("Escape");
		await settle();
		await say(
			"With one culture picked, each line shows that culture's translation, and Search translations searches it too."
		);
		await search.fill("Sitzung");
		await page.getByRole("button", { name: "Search translations" }).click();
		await settle();
		await page.waitForTimeout(1_500);
		await search.fill("");
		await page.getByRole("button", { name: "Search translations" }).click();
		await culture.click();
		await cultureChoices.getByRole("button", { name: "All cultures", exact: true }).click();
		await page.keyboard.press("Escape");
		await settle();

		// 5. Changed files.
		await chapter("Changed files", "Does this change touch text?");
		await say(
			"Paste a file list from any version control tool to see the text those files hold."
		);
		await page.getByRole("button", { name: /^Changed files/u }).click();
		await page
			.getByRole("textbox", { name: "Changed files, one path per line" })
			.fill(
				"Content/Fixture/Localization/DT_Localization.uasset\nContent/Fixture/Text/ST_Game.uasset\nSource/Game/Private/Menu.cpp"
			);
		await page.waitForTimeout(800);
		await page.getByRole("button", { name: "Show their text", exact: true }).click();
		await settle();
		await say(
			"The summary says how many files hold text, and the problems say whether a gather is needed."
		);
		await page.getByRole("button", { name: /^Changed files/u }).click();
		await page.getByRole("button", { name: "Clear files", exact: true }).click();
		await page.keyboard.press("Escape");
		await settle();

		// 6. The line page and a key change.
		await chapter("The line page", "One line, everything it needs");
		await say(
			"This line's key changed in the saved DataTable. Unreal still lists its earlier key, with the translations it shipped."
		);
		const renamed = lineRow("DT_Localization · MissingFrench");
		await reveal(renamed);
		await renamed.click();
		await expect(side.getByRole("region", { name: "Key change" })).toBeVisible();
		await settle();
		await say(
			"Opening a line gives it the page. It says what is wrong first, in plain words, and what fixes it."
		);
		await say(
			"Without help, Unreal's next gather would drop those translations. Carry translations stages them for the new key."
		);
		const change = side.getByRole("region", { name: "Key change" });
		await change.scrollIntoViewIfNeeded();
		await change.getByRole("button", { name: "Carry translations" }).click();
		const staged = page.getByRole("region", { name: "Staged translations" });
		await expect(staged).toBeVisible();
		await staged.getByRole("button", { name: "Check changes", exact: true }).click();
		await say(
			"Checking against the project's files says what comes next: gather, export, then write to PO."
		);
		await staged.getByRole("button", { name: "Discard all", exact: true }).click();
		await say(
			"The properties beside it list the key, origin, asset, folder, editing, notes, length and findings."
		);
		await say(
			"The arrows step through the list, opening the next group when needed. ‹ Lines goes back to where you were."
		);
		await page.getByRole("button", { name: "Next line", exact: true }).click();
		await settle();
		await page.waitForTimeout(1_500);
		await page.getByRole("button", { name: "Next line", exact: true }).click();
		await settle();
		await page.waitForTimeout(1_500);
		await back();

		// 7. Editing and review.
		await chapter("Translate and review", "Edits go to PO files; Unreal stays in charge");
		const named = lineRow("ST_Localization · NamedArgument");
		await reveal(named);
		await named.click();
		await settle();
		const german = translations.getByRole("article", { name: "Translation de", exact: true });
		await german.scrollIntoViewIfNeeded();
		await say(
			"This German translation uses {Name}, but the source says {PlayerName}. Edit it and stage the change."
		);
		await german.getByRole("button", { name: "Edit", exact: true }).click();
		const field = german.getByRole("textbox", { name: "New de translation" });
		await field.fill("Gespräch mit {PlayerName}");
		await page.waitForTimeout(800);
		await german.getByRole("button", { name: "Stage", exact: true }).click();
		await page.getByRole("button", { name: "1 staged", exact: true }).click();
		await staged.getByRole("button", { name: "Check changes", exact: true }).click();
		await expect(staged).toContainText("Ready to write");
		await say(
			"The check names the PO file to check out first. Writing changes only that translation."
		);
		await staged.getByRole("button", { name: "Write to PO", exact: true }).click();
		await expect(staged).toBeHidden();
		await settle();
		await say(
			"The edit now shows as not synced until Unreal imports it. Sync with Unreal runs that import and compile."
		);
		await reveal(named);
		await named.click();
		await settle();
		const reviewGerman = translations
			.getByRole("article", { name: "Translation de", exact: true })
			.getByRole("group", { name: "Review de", exact: true });
		await reviewGerman.scrollIntoViewIfNeeded();
		await say(
			"Review flags live in a project file beside the target. Changing the text later shows the review as out of date."
		);
		await reviewGerman.getByRole("button", { name: "Reviewed", exact: true }).click();
		await page.waitForTimeout(1_500);
		await back();

		// 8. Bulk actions.
		await chapter("Bulk actions", "Work on many lines at once");
		await say("Tick lines to act on them together. Shift-click takes the range between.");
		const work = results.getByRole("button", { name: /^Translation work \d/u });
		if ((await work.getAttribute("aria-expanded")) === "false") await work.click();
		const ticks = results
			.getByRole("region", { name: "Translation work" })
			.getByRole("checkbox", { name: /^Select /u });
		await expect(ticks.first()).toBeVisible();
		await ticks.first().click();
		await page.waitForTimeout(700);
		await ticks.last().click({ modifiers: ["Shift"] });
		const bulk = page.getByRole("toolbar", { name: "Selected lines" });
		await expect(bulk).toBeVisible();
		await say(
			"The bar exports them for translators with just the picked cultures, marks them reviewed, carries translations to changed keys, or copies their keys."
		);
		await bulk.getByRole("button", { name: "Export for translators" }).click();
		await expect(bulk.getByRole("status")).toContainText("Exported");
		exportCount += 1;
		await page.waitForTimeout(1_500);
		const markReviewed = bulk.getByRole("button", { name: /^Mark reviewed/u });
		if (await markReviewed.count()) {
			await markReviewed.click();
			await expect(bulk.getByRole("status")).toContainText("reviewed");
			await page.waitForTimeout(1_500);
		}
		await say(
			"The selection stays while you filter and regroup, so you can build it up from several views."
		);
		await bulk.getByRole("button", { name: "Clear selection" }).click();

		// 9. Quality checks.
		await chapter("Quality checks", "Character limits, terminology and translation checks");
		await page.getByRole("tab", { name: /^Quality checks/u }).click();
		await say(
			"Checks run on the same text. Built-in checks compare each translation with its source: arguments, plural forms, rich text tags and more."
		);
		const setup = page.getByRole("region", { name: "Quality rules setup" });
		if (await setup.count()) {
			await say(
				"A project can add its own rules: character limits per role and preferred terms."
			);
			await setup.getByRole("button", { name: "Load rules", exact: true }).click();
		}
		const findings = page.getByRole("region", { name: "Findings" });
		await expect(findings.getByText("Loading findings…", { exact: true })).toBeHidden();
		await page.getByRole("button", { name: /^Terminology [\d,]+$/u }).click();
		await findings.getByRole("button").filter({ hasText: "Remove “skip”" }).click();
		await say("A finding highlights the exact term and says how to fix it.");

		// 10. Reports, Unreal steps and exports.
		await chapter("Reports and Unreal", "Progress per culture, and Unreal's own steps");
		await page.getByRole("tab", { name: "Reports", exact: true }).click();
		await expect(page.getByRole("table", { name: "Localization report" })).toBeVisible();
		await say(
			"Reports give each culture's progress, and a baseline counts what changed since a handoff."
		);
		await page.getByRole("button", { name: "Sync with Unreal", exact: true }).click();
		const confirmation = page.getByRole("region", { name: "Confirm Unreal step" });
		await expect(page.getByText("Preparing Unreal step…", { exact: true })).toBeHidden();
		await say(
			"Unreal steps run Unreal's own gather, import, export and compile. The plan lists every file it may write before anything runs."
		);
		await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.getByRole("tab", { name: "Text", exact: true }).click();
		await settle();
		await page.getByRole("button", { name: "Export", exact: true }).click();
		await page.waitForTimeout(700);
		await say(
			"Export writes what the list shows: a readable CSV, JSON, or one spreadsheet with every language lined up by key."
		);
		// Saving would print a local path; the bulk export above already wrote a file.
		await page.keyboard.press("Escape");
		await page.waitForTimeout(800);
		await say(
			"Everything here also works from the command line: ue-shed loc status, loc export, loc apply and loc run."
		);
		await clear();
		await page.waitForTimeout(1_000);
	} finally {
		if (recording) await page.screencast.stop().catch(() => undefined);
		await application.close().catch(() => undefined);
	}
	expect((await stat(video)).size).toBeGreaterThan(0);
	for (let index = 1; index <= exportCount; index++)
		expect((await stat(testInfo.outputPath(`export-${index}.csv`))).size).toBeGreaterThan(0);
});
