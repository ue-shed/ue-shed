import { expect, type Page } from "@playwright/test";

export type WorkbenchRoute =
	| "Showcase"
	| "Data Authoring"
	| "Game Text"
	| "Input Atlas"
	| "Map Review"
	| "Texture Audit"
	| "Camera Lab"
	| "Config"
	| "World Log";

export class WorkbenchPage {
	readonly page: Page;

	constructor(page: Page) {
		this.page = page;
	}

	async expectShowcaseReady(): Promise<void> {
		await expect(this.page).toHaveTitle("UE Shed Workbench");
		await expect(this.page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
			"Showcase / Workbench"
		);
		const project = this.page.getByRole("region", { name: "Current project" });
		await expect(project).toContainText("unreal-project");
		await expect(project).toContainText("Packages");
		await expect(project).toContainText("Saved maps");
		const workflows = this.page.getByRole("region", { name: "Workbench workflows" });
		for (const name of [
			"Config Explorer",
			"Data Authoring",
			"Input Atlas",
			"Game Text",
			"Texture Audit",
			"Map Review",
			"World Log",
			"Camera Lab"
		]) {
			await expect(workflows.getByRole("link", { name })).toBeVisible();
		}
		await expect(workflows).toContainText("packages indexed");
	}

	async openRoute(route: WorkbenchRoute): Promise<void> {
		const navigation = this.page.getByRole("navigation", { name: "Workbench" });
		const link = navigation.getByRole("link", { exact: true, name: route });
		await link.click();
		await expect(link).toHaveAttribute("aria-current", "page");
	}
}
