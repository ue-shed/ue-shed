import { expect, test } from "./fixtures/workbench-test.js";

test("showcases real saved-config provenance without renderer filesystem authority", async ({
	workbench
}, testInfo) => {
	await workbench.expectShowcaseReady();
	await workbench.openRoute("Config");
	const page = workbench.page;
	const evidence = page.getByRole("region", { name: "Config Explorer evidence" });

	await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
		"Showcase / Config Explorer"
	);
	await expect(page.getByText("VALUE DIVERGES", { exact: true })).toBeVisible();
	await expect(page.getByRole("region", { name: "Platform config comparison" })).toContainText(
		"PlatformA"
	);
	await expect(page.getByRole("region", { name: "Platform config comparison" })).toContainText(
		"PlatformB"
	);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("config-explorer-platform-comparison.png")
	});

	await page.getByRole("button", { name: /Platform A/ }).click();
	await expect(page.getByRole("list", { name: "PlatformA ordered contributions" })).toContainText(
		"clear"
	);

	await page.getByRole("button", { name: /Platform B/ }).click();
	await expect(page.getByRole("list", { name: "PlatformB ordered contributions" })).toContainText(
		"append"
	);

	await page.getByRole("button", { name: /Scalar/ }).click();
	await expect(
		page.getByRole("region", { name: "PlatformA effective saved value" })
	).toContainText("PlatformA");

	await page.getByRole("button", { name: /Explicit empty/ }).click();
	await expect(
		page.getByRole("region", { name: "PlatformA effective saved value" })
	).toContainText("[ explicit empty ]");

	await page.getByRole("button", { name: /Unsupported/ }).click();
	await expect(evidence.getByText("partial coverage", { exact: true })).toBeVisible();
	await expect(page.getByRole("region", { name: "PlatformA coverage exceptions" })).toContainText(
		"unsupported"
	);

	await page.getByRole("button", { name: /Redirect/ }).click();
	await expect(evidence.getByText("partial coverage", { exact: true })).toBeVisible();
});
