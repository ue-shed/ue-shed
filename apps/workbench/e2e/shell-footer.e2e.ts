import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/workbench-test.js";

async function expectWithinViewport(page: Page, locator: Locator): Promise<void> {
	await expect(locator).toBeVisible();
	const [bounds, viewport] = await Promise.all([
		locator.boundingBox(),
		Promise.resolve(page.viewportSize())
	]);
	if (!bounds || !viewport) throw new Error("Expected a measurable element and viewport");
	expect(bounds.x).toBeGreaterThanOrEqual(0);
	expect(bounds.y).toBeGreaterThanOrEqual(0);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
}

test("keeps sidebar footer controls visible and keyboard accessible", async ({ workbench }) => {
	test.setTimeout(90_000);
	await workbench.page.setViewportSize({ width: 1280, height: 800 });
	await workbench.expectShowcaseReady();

	const sessionSettingsTrigger = workbench.page.getByLabel("Change Unreal session monitor port");
	await sessionSettingsTrigger.click();
	const sessionSettings = workbench.page.getByRole("region", {
		name: "Session monitor settings"
	});
	await expectWithinViewport(workbench.page, sessionSettings);

	const portInput = workbench.page.getByRole("spinbutton", { name: "Remote Control port" });
	await portInput.focus();
	await expect(portInput).toBeFocused();
	expect(
		await portInput.evaluate((element) => {
			const style = element.ownerDocument.defaultView?.getComputedStyle(element);
			if (!style) throw new Error("Expected the port input to have a computed style");
			return { style: style.outlineStyle, width: style.outlineWidth };
		})
	).toEqual({ style: "solid", width: "1px" });
	await sessionSettingsTrigger.click();

	await workbench.page.getByText("Launch ▾", { exact: true }).click();
	await expectWithinViewport(
		workbench.page,
		workbench.page.getByRole("region", { name: "Launch project options" })
	);
});
