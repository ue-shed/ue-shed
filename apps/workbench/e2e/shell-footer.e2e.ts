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

test("keeps sidebar footer controls visible and keyboard accessible", async ({
	workbench
}, testInfo) => {
	test.setTimeout(90_000);
	await workbench.page.setViewportSize({ width: 1280, height: 800 });
	await workbench.expectShowcaseReady();
	await expectWithinViewport(
		workbench.page,
		workbench.page.getByRole("button", { name: "Show Unreal ↗" })
	);

	const sessionSettingsTrigger = workbench.page.getByLabel("Change Unreal target port");
	await sessionSettingsTrigger.click();
	const sessionSettings = workbench.page.getByRole("region", {
		name: "Unreal target settings"
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
	await portInput.fill("39992");
	await sessionSettings.getByRole("button", { name: "Apply", exact: true }).click();
	await expect(sessionSettingsTrigger).toHaveText(":39992");
	await expect
		.poll(() => workbench.page.evaluate("window.ueShed.editorSession.settings()"))
		.toEqual({ endpoint: "http://127.0.0.1:39992/", port: 39992 });
	await workbench.page.getByRole("main").click();
	await expect(sessionSettings).toBeHidden();
	await sessionSettingsTrigger.click();
	await expect(sessionSettings).toBeVisible();
	await workbench.page.keyboard.press("Escape");
	await expect(sessionSettings).toBeHidden();
	await expect(sessionSettingsTrigger).toBeFocused();

	const launchTrigger = workbench.page.getByText("Launch ▾", { exact: true });
	const launchMenu = workbench.page.getByRole("region", { name: "Launch project options" });
	await launchTrigger.click();
	await expectWithinViewport(workbench.page, launchMenu);
	await workbench.page.screenshot({ path: testInfo.outputPath("editor-handoff-footer.png") });
	await workbench.page.getByRole("main").click();
	await expect(launchMenu).toBeHidden();
	await launchTrigger.click();
	await workbench.page.keyboard.press("Escape");
	await expect(launchMenu).toBeHidden();
	await expect(launchTrigger).toBeFocused();
});
