import { expect, test } from "@playwright/test";

const slugs = ["getting-started", "data-authoring", "game-text", "config-explorer", "map-review"];

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
