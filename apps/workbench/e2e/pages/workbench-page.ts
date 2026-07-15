import { expect, type Page } from "@playwright/test";

export type WorkbenchRoute =
	| "Showcase"
	| "Data Authoring"
	| "Game Text"
	| "Map Review"
	| "Texture Audit"
	| "Camera Lab";

export class WorkbenchPage {
	readonly page: Page;

	constructor(page: Page) {
		this.page = page;
	}

	async expectShowcaseReady(): Promise<void> {
		await expect(this.page).toHaveTitle("UE Shed Workbench");
		await expect(
			this.page.getByRole("heading", { name: "Unreal tooling, outside the editor." })
		).toBeVisible();
		const readiness = this.page.getByRole("region", { name: "Showcase readiness" });
		await expect(readiness).toContainText("Fixture preset");
		await expect(readiness).toContainText("committed corpus");
		await expect(readiness).toContainText("Saved-asset reader");
		await expect(readiness).toContainText("explicit path");
	}

	async openRoute(route: WorkbenchRoute): Promise<void> {
		const navigation = this.page.getByRole("navigation", { name: "Workbench" });
		const link = navigation.getByRole("link", { exact: true, name: route });
		await link.click();
		await expect(link).toHaveAttribute("aria-current", "page");
	}
}
