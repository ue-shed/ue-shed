import { expect, test } from "./fixtures/workbench-test.js";

// The acceptance runner owns a disposable copy and a matching live editor. Never mutate the
// committed fixture or whichever project happens to be selected in a developer's Workbench.
test.skip(
	process.env.UE_SHED_GAME_TEXT_ID_REPAIRS_TEST !== "1",
	"Run test:unreal-game-text-actions with --showcase"
);

test("repairs conflicting DataTable and widget keys through the Showcase", async ({
	workbench
}, testInfo) => {
	test.setTimeout(240_000);
	const { page } = workbench;
	await workbench.openRoute("Game Text");
	await page.getByRole("button", { name: "Scan project", exact: true }).click();
	const results = page.getByRole("region", { name: "Results" });
	await expect(results.locator("button[data-row]").first()).toBeVisible({ timeout: 90_000 });
	const search = page.getByRole("searchbox", { name: "Search game text" });
	for (const sample of [
		{ query: "lighthouse keeper", text: "Find the old lighthouse keeper", label: "table" },
		{ query: "Reach the", text: "Reach the old lighthouse", label: "widget" }
	]) {
		await search.fill(sample.query);
		const row = results.locator("button[data-row]").filter({ hasText: sample.text }).first();
		await expect(row).toBeVisible();
		await row.click();
		const repair = page.getByRole("region", { name: "Fix localization IDs" });
		const group = repair
			.getByRole("group", { name: /^Text [A-Z]$/u })
			.filter({ hasText: sample.text });
		await expect(group).toBeVisible();
		await group.getByRole("button", { name: "Give this text its own key" }).click();
		await repair.getByRole("button", { name: "Check in Unreal" }).click();
		const preview = repair.getByRole("group", { name: "Unreal ID fix preview" });
		await expect(preview).toContainText("Unreal preview: ok", { timeout: 30_000 });
		await page.screenshot({ path: testInfo.outputPath(`${sample.label}-preview.png`) });
		await preview.getByRole("button", { name: "Apply and save in Unreal" }).click();
		await expect(repair.getByRole("status")).toContainText("saved files were verified", {
			timeout: 60_000
		});
		const receipt = repair.getByRole("group", { name: "Unreal ID repair receipt" });
		await expect(receipt).toContainText("Saved-file verification: passed");
		await receipt.scrollIntoViewIfNeeded();
		await page.screenshot({ path: testInfo.outputPath(`${sample.label}-verified.png`) });
		await repair.getByRole("button", { name: "Rescan saved text" }).click();
		await expect(
			results.locator("button[data-row]").filter({ hasText: sample.text }).first()
		).toBeVisible({ timeout: 60_000 });
	}
});
