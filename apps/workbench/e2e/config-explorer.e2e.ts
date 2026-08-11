import { expect, test } from "./fixtures/workbench-test.js";

test("queries real saved-config provenance without renderer filesystem authority", async ({
	workbench
}, testInfo) => {
	await workbench.expectShowcaseReady();
	await workbench.openRoute("Config");
	const page = workbench.page;

	await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
		"CONFIG EXPLORER"
	);
	await expect(page.getByRole("region", { name: "Config query workspace" })).toBeVisible();
	await expect(page.getByLabel("Config section")).toHaveValue("Fixture.Settings");
	await expect(page.getByLabel("Config key")).toHaveValue("Entries");

	await page.getByRole("button", { name: /^COMPARE/ }).click();
	const evidence = page.getByRole("region", { name: "Config Explorer evidence" });
	await expect(evidence.getByText("VALUE DIVERGES", { exact: true })).toBeVisible();
	await expect(page.getByRole("region", { name: "Platform config comparison" })).toContainText(
		"PlatformA"
	);
	await expect(page.getByRole("region", { name: "Platform config comparison" })).toContainText(
		"PlatformB"
	);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("config-explorer-editable-comparison.png")
	});

	await page.getByRole("button", { name: /Last writer/ }).click();
	await expect(page.getByLabel("Config key")).toHaveValue("Mode");
	await expect(page.getByRole("button", { name: /^TRACE VALUE/ })).toBeVisible();
	await page.getByRole("button", { name: /^TRACE VALUE/ }).click();
	await expect(
		page.getByRole("region", { name: "PlatformA effective saved value" })
	).toContainText("PlatformA");

	await page.getByRole("button", { name: /Coverage gap/ }).click();
	await page.getByRole("button", { name: /^TRACE VALUE/ }).click();
	await expect(evidence.getByText("partial coverage", { exact: true })).toBeVisible();
	await expect(page.getByRole("region", { name: "PlatformA coverage exceptions" })).toContainText(
		"unsupported"
	);

	const selectedProject = page.getByRole("button", { name: "Selected project" });
	await selectedProject.click();
	await expect(selectedProject).toHaveAttribute("aria-pressed", "true");
});
