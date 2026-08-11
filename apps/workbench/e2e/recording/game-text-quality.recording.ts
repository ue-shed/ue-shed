import { createRequire } from "node:module";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { WorkbenchPage } from "../pages/workbench-page.js";

const require = createRequire(import.meta.url);
const electronExecutable: unknown = require("electron");
const workbenchRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const initialRuleFile = resolve(
	workbenchRoot,
	"../../fixtures/unreal-project/FixtureSource/Text/quality-rules.json"
);
const replacementRuleFile = resolve(
	workbenchRoot,
	"../../fixtures/unreal-project/FixtureSource/Text/quality-rules-relaxed.json"
);

if (typeof electronExecutable !== "string") {
	throw new TypeError("The Electron package did not resolve to an executable path");
}

test.skip(
	process.env.UE_SHED_RECORD_GAME_TEXT_QUALITY !== "true",
	"Launch explicitly with UE_SHED_RECORD_GAME_TEXT_QUALITY=true"
);

test("records the real Game Text quality workflow", async ({
	browserName: _browserName
}, testInfo) => {
	if (!process.env.UE_SHED_UASSET_EXECUTABLE) {
		throw new Error("Set UE_SHED_UASSET_EXECUTABLE before recording the Workbench");
	}
	await mkdir(testInfo.outputDir, { recursive: true });
	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	const application = await electron.launch({
		args: [workbenchRoot],
		cwd: workbenchRoot,
		env: { ...environment, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
		executablePath: electronExecutable
	});
	const page = await application.firstWindow();
	const workbench = new WorkbenchPage(page);
	let recording = false;
	try {
		await application.evaluate(
			({ dialog }, selectedRuleFiles) => {
				const original = dialog.showOpenDialog.bind(dialog);
				let qualityRuleSelection = 0;
				Object.defineProperty(dialog, "showOpenDialog", {
					configurable: true,
					value: (...args: Parameters<typeof dialog.showOpenDialog>) => {
						const options = args.at(-1);
						if (options?.title !== "Choose Game Text quality rules")
							return original(...args);
						const selectedRuleFile =
							selectedRuleFiles[
								Math.min(qualityRuleSelection, selectedRuleFiles.length - 1)
							];
						qualityRuleSelection += 1;
						return Promise.resolve({ canceled: false, filePaths: [selectedRuleFile] });
					}
				});
			},
			[initialRuleFile, replacementRuleFile]
		);

		await workbench.expectShowcaseReady();
		await workbench.openRoute("Game Text");
		await expect(page.getByRole("region", { name: "Text units" })).toContainText(
			"Showing 32 of 32 matches"
		);

		const screenshot = await page.screenshot({ type: "png" });
		const requestedSize = {
			height: screenshot.readUInt32BE(20) & ~1,
			width: screenshot.readUInt32BE(16) & ~1
		};
		let resolveFirstFrame: (value: {
			readonly height: number;
			readonly width: number;
		}) => void = () => undefined;
		const firstFrame = new Promise<{ readonly height: number; readonly width: number }>(
			(resolve) => {
				resolveFirstFrame = resolve;
			}
		);
		await page.screencast.start({
			onFrame: ({ viewportHeight, viewportWidth }) =>
				resolveFirstFrame({ height: viewportHeight, width: viewportWidth }),
			size: requestedSize
		});
		const streamedSize = await firstFrame;
		await page.screencast.stop();
		await page.screencast.start({
			path: testInfo.outputPath("game-text-quality-demo.webm"),
			size: { height: streamedSize.height & ~1, width: streamedSize.width & ~1 }
		});
		recording = true;

		await page.waitForTimeout(1_000);
		await page.getByRole("tab", { name: "Quality review" }).click();
		await expect(page.getByRole("region", { name: "Quality rules setup" })).toBeVisible();
		await page.waitForTimeout(1_200);
		await page.getByRole("button", { name: "Load quality rules" }).click();
		await expect(page.getByRole("region", { name: "Quality findings" })).toBeVisible();
		await expect(page.getByRole("region", { name: "Quality summary" })).toContainText(
			"3 findings"
		);
		await page.waitForTimeout(1_700);
		await page.getByRole("button", { name: /Character budgets/ }).click();
		await expect(page.getByRole("region", { name: "Quality findings" })).toContainText(
			"BUDGET"
		);
		await page.waitForTimeout(1_500);
		await page.getByRole("button", { name: /^Terminology/ }).click();
		await expect(page.getByRole("region", { name: "Quality findings" })).toContainText("TERM");
		await page.waitForTimeout(1_500);
		await page.getByRole("button", { name: /^All findings/ }).click();
		const findings = page.getByRole("region", { name: "Quality findings" });
		await findings.getByRole("button").last().click();
		await expect(
			page.getByRole("complementary", { name: "Quality finding detail" })
		).toContainText("EXPECTED");
		await page.waitForTimeout(1_700);
		await page.getByRole("button", { name: "Replace quality rules" }).click();
		await expect(page.getByRole("region", { name: "Quality summary" })).toContainText(
			"1 finding"
		);
		await expect(page.getByText("Budgets", { exact: true }).locator("..")).toContainText("0");
		await page.waitForTimeout(1_900);
		await page.getByRole("tab", { name: "Text browser" }).click();
		await expect(page.getByRole("region", { name: "Text units" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Replace quality rules" })).toHaveCount(0);
		await page.waitForTimeout(1_200);
		await page.getByRole("tab", { name: /Quality review/ }).click();
		await page.waitForTimeout(1_400);
		await page.screenshot({ path: testInfo.outputPath("final.png") });
	} finally {
		if (recording) await page.screencast.stop().catch(() => undefined);
		await application.close().catch(() => undefined);
	}
	const video = await stat(testInfo.outputPath("game-text-quality-demo.webm"));
	expect(video.size).toBeGreaterThan(0);
});
