import { expect, test } from "./fixtures/workbench-test.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const enabled = process.env.UE_SHED_MAP_REVIEW_AUTHORING_E2E === "1" && endpoint !== undefined;
async function editorActorCall(functionName: string, parameters: object): Promise<void> {
	const response = await fetch(`${endpoint}/remote/object/call`, {
		body: JSON.stringify({
			functionName,
			generateTransaction: false,
			objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
			parameters
		}),
		headers: { "content-type": "application/json" },
		method: "PUT"
	});
	if (!response.ok)
		throw new Error(`Could not prepare fixture selection: HTTP ${response.status}`);
}

test.skip(!enabled, "set UE_SHED_MAP_REVIEW_AUTHORING_E2E=1 with a live editor endpoint");
test.setTimeout(90_000);

test("authors real candidate previews from the selected fixture subject", async ({
	workbench
}, testInfo) => {
	try {
		await workbench.expectShowcaseReady();
		await workbench.openRoute("Map Review");
		const refreshRate = workbench.page.getByRole("slider", { name: "World refresh rate" });
		await expect(refreshRate).toHaveValue("5");
		await refreshRate.fill("30");
		await expect(refreshRate).toHaveValue("30");
		await workbench.page
			.getByRole("button", { name: "Select Review Subject" })
			.click({ timeout: 60_000 });
		await workbench.page.getByRole("button", { name: "GO TO ACTOR ↗" }).click();
		const candidates = workbench.page.getByRole("region", { name: "Framing candidates" });
		await expect(
			candidates.getByRole("button", { name: "Select Context three-quarter" })
		).toBeVisible({ timeout: 60_000 });
		await expect(candidates.getByRole("button", { name: /^Select / })).toHaveCount(7);
		await expect(candidates.getByRole("img").first()).toHaveJSProperty("naturalWidth", 640, {
			timeout: 30_000
		});
		await workbench.page.getByRole("button", { name: "FOLLOW ACTOR" }).click();
		await workbench.page.waitForTimeout(750);
		await expect(workbench.page.getByRole("button", { name: "STOP FOLLOWING" })).toBeVisible();
		await workbench.page.getByRole("button", { name: "STOP FOLLOWING" }).click();
		await workbench.page.screenshot({
			fullPage: true,
			path: testInfo.outputPath("map-review-authoring.png")
		});
	} finally {
		await editorActorCall("SelectNothing", {});
	}
});
