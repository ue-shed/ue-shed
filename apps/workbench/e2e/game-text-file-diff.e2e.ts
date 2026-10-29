import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "./fixtures/workbench-test.js";

const fixturePo = resolve("../../fixtures/unreal-project/Content/Localization/Game/fr/Game.po");

/** The fixture's French PO a translator and a gather later: edited, removed, added and rekeyed. */
function later(po: string): string {
	return po
		.replace('msgstr "Retour au titre"', 'msgstr "Retour à l’écran titre"')
		.replace(
			'msgctxt "Fixture.GameTextProblems.Menu,Options"\nmsgid "Options"\nmsgstr "Options"\n',
			""
		)
		.replace(
			"Fixture.GameTextProblems.Quests,QuestOutro",
			"Fixture.GameTextProblems.Quests,6F1C2A0B44E1"
		)
		.concat(
			'\n#. Key:\tCredits\nmsgctxt "Fixture.GameTextProblems.Menu,Credits"\nmsgid "Credits"\nmsgstr "Générique"\n'
		);
}

test("Game Text compares two localization files without a scan", async ({
	application,
	workbench
}, testInfo) => {
	test.setTimeout(120_000);
	const page = workbench.page;
	const directory = await mkdtemp(join(tmpdir(), "ue-shed-e2e-file-diff-"));
	try {
		const before = join(directory, "before", "Game.po");
		const after = join(directory, "after", "Game.po");
		const po = (await readFile(fixturePo, "utf8")).replaceAll("\r\n", "\n");
		await mkdir(join(directory, "before"));
		await mkdir(join(directory, "after"));
		await writeFile(before, po);
		await writeFile(after, later(po));
		await application.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
		});
		await workbench.openRoute("Game Text");
		await page.getByRole("tab", { name: "Compare files" }).click();
		await application.evaluate(
			({ dialog }, files) => {
				const queue = [...files];
				dialog.showOpenDialog = async () => ({
					canceled: false,
					filePaths: [queue.shift() ?? ""]
				});
			},
			[before, after]
		);
		for (const side of ["Before", "After"])
			await page
				.getByRole("group", { name: side, exact: true })
				.getByRole("button", { name: "Choose…" })
				.click();
		await page.getByRole("button", { name: "Compare", exact: true }).click();
		const comparison = page.getByRole("region", { name: "File comparison" });
		await expect(comparison).toBeVisible({ timeout: 60_000 });
		await expect(comparison.getByRole("status")).toContainText("1 moved to a new key");
		await expect(comparison.getByRole("listitem", { name: "New key" })).toContainText(
			"6F1C2A0B44E1"
		);
		await expect(comparison.getByRole("listitem", { name: "Added" })).toContainText(
			"Générique"
		);
		await expect(comparison.getByRole("listitem", { name: "Removed" })).toContainText(
			"Options"
		);
		await expect(comparison.getByRole("listitem", { name: "Edited" })).toContainText(
			"Retour à l’écran titre"
		);
		await page.screenshot({ path: testInfo.outputPath("game-text-file-diff-1440.png") });
		await comparison.getByRole("button", { name: /^New key,/u }).click();
		await expect(comparison.getByRole("listitem")).toHaveCount(1);
		await page.screenshot({
			path: testInfo.outputPath("game-text-file-diff-new-keys-1440.png")
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
