import { createRequire } from "node:module";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { Schema } from "effect";
import { _electron as electron, type ElectronApplication } from "playwright";
import { WorkbenchPage } from "../pages/workbench-page.js";

const RecordingJourney = Schema.Literal("saved-workflows", "map-review");
const FixtureLaunchResult = Schema.Union(
	Schema.Struct({ status: Schema.Literal("ready") }),
	Schema.Struct({
		message: Schema.String,
		recovery: Schema.String,
		status: Schema.Literal("failed")
	})
);

const RecordingManifest = Schema.Struct({
	artifacts: Schema.Struct({
		finalScreenshot: Schema.String,
		logs: Schema.String,
		trace: Schema.String,
		video: Schema.optional(Schema.String)
	}),
	chapters: Schema.Array(
		Schema.Struct({
			screenshot: Schema.String,
			title: Schema.String
		})
	),
	commit: Schema.String,
	contract: Schema.Struct({
		name: Schema.Literal("ue-shed-showcase-recording"),
		version: Schema.Literal(1)
	}),
	dirty: Schema.Boolean,
	error: Schema.optional(Schema.String),
	finishedAt: Schema.String,
	id: Schema.NonEmptyString,
	journey: RecordingJourney,
	startedAt: Schema.String,
	status: Schema.Literal("passed", "failed")
});

const decodeManifest = Schema.decodeUnknownSync(RecordingManifest);
const decodeJourney = Schema.decodeUnknownSync(RecordingJourney);
const decodeFixtureLaunchResult = Schema.decodeUnknownSync(FixtureLaunchResult);
const journey = decodeJourney(process.env.UE_SHED_RECORDING_JOURNEY ?? "saved-workflows");
const require = createRequire(import.meta.url);
const electronExecutable: unknown = require("electron");
const workbenchRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

if (typeof electronExecutable !== "string") {
	throw new TypeError("The Electron package did not resolve to an executable path");
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
}

async function recordChapter(options: {
	readonly action: () => Promise<void>;
	readonly description: string;
	readonly page: Page;
	readonly resetScroll?: boolean;
	readonly slug: string;
	readonly testInfo: TestInfo;
	readonly title: string;
}): Promise<{ readonly screenshot: string; readonly title: string }> {
	return test.step(options.title, async () => {
		await options.page.screencast.showChapter(options.title, {
			description: options.description,
			duration: 1_200
		});
		await options.page.waitForTimeout(1_300);
		await options.action();
		if (options.resetScroll !== false) {
			await options.page.evaluate("scrollTo(0, 0)");
		}
		await options.page.waitForTimeout(750);
		const screenshot = `chapters/${options.slug}.png`;
		await options.page.screenshot({
			path: options.testInfo.outputPath(screenshot)
		});
		return { screenshot, title: options.title };
	});
}

test(`records the ${journey} Workbench journey`, async ({
	browserName: _browserName
}, testInfo) => {
	if (!process.env.UE_SHED_UASSET_EXECUTABLE) {
		throw new Error("Launch the recorder through pnpm showcase:record");
	}

	await mkdir(testInfo.outputDir, { recursive: true });
	const playwrightArtifacts = testInfo.outputPath(".playwright");
	await mkdir(playwrightArtifacts, { recursive: true });
	const startedAt = new Date().toISOString();
	const logs: string[] = [];
	const chapters: { readonly screenshot: string; readonly title: string }[] = [];
	let application: ElectronApplication | undefined;
	let page: Page | undefined;
	let screencastStarted = false;
	let traceStarted = false;
	let videoReady = false;
	let failure: unknown;
	const artifactFailure = (label: string, cause: unknown) => {
		logs.push(`[recorder:${label}] ${errorMessage(cause)}`);
		failure ??= cause;
	};

	try {
		const environment = { ...process.env };
		delete environment.ELECTRON_RUN_AS_NODE;
		application = await electron.launch({
			args: [workbenchRoot],
			artifactsDir: playwrightArtifacts,
			cwd: workbenchRoot,
			env: {
				...environment,
				ELECTRON_DISABLE_SECURITY_WARNINGS: "true"
			},
			executablePath: electronExecutable
		});
		page = await application.firstWindow();
		page.on("console", (message) =>
			logs.push(`[renderer:${message.type()}] ${message.text()}`)
		);
		page.on("pageerror", (error) => logs.push(`[renderer:error] ${errorMessage(error)}`));
		const childProcess = application.process();
		childProcess.stdout?.on("data", (chunk: Buffer) =>
			logs.push(`[main:stdout] ${chunk.toString()}`)
		);
		childProcess.stderr?.on("data", (chunk: Buffer) =>
			logs.push(`[main:stderr] ${chunk.toString()}`)
		);
		await application.context().tracing.start({
			screenshots: true,
			snapshots: true,
			sources: true
		});
		traceStarted = true;

		const workbench = new WorkbenchPage(page);
		const startScreencast = async () => {
			await page!.screencast.start({
				annotate: { duration: 700, fontSize: 18, position: "top-right" },
				path: testInfo.outputPath("demo.webm"),
				size: { height: 940, width: 1540 }
			});
			screencastStarted = true;
		};
		if (journey === "map-review") {
			await workbench.expectShowcaseReady();
			await workbench.openRoute("Map Review");
			await expect(
				page.getByRole("heading", { name: "A memory for the world." })
			).toBeVisible();
			await expect(page.getByRole("region", { name: "Review set status" })).toContainText(
				"Fixture Structure"
			);
			const history = page.getByRole("region", { name: "Capture history" });
			const initialRuns = history.getByRole("button");
			const initialRunCount = await initialRuns.count();
			const successfulRuns = initialRuns.filter({ hasText: "completed" });
			if ((await successfulRuns.count()) === 0) {
				throw new Error(
					"Map Review recording requires one prior local Capture Run to demonstrate before-and-after evidence."
				);
			}
			await successfulRuns.first().click();
			const selectedCapture = page.getByRole("region", { name: "Selected capture" });
			const selectedRunId = selectedCapture.locator("code");
			const initialRunId = await selectedRunId.textContent();
			if (!initialRunId) throw new Error("The prior Map Review capture has no run ID");
			const initialImage = selectedCapture.getByRole("img");
			await expect(initialImage).toHaveJSProperty("naturalWidth", 1280);

			const launch = decodeFixtureLaunchResult(
				await page.evaluate("globalThis.ueShed.fixture.launchReview()")
			);
			if (launch.status === "failed") {
				throw new Error(`${launch.message} ${launch.recovery}`);
			}
			await startScreencast();

			chapters.push(
				await recordChapter({
					action: async () => {
						await expect(selectedCapture).toContainText("PURE / ORDINARY WORLD");
						await expect(initialImage).toBeVisible();
					},
					description: "The latest immutable Pure capture is our visual baseline.",
					page,
					slug: "01-before-capture",
					testInfo,
					title: "Before: retained evidence"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!.getByRole("button", { name: "CAPTURE SET" }).click();
						await expect(history.getByRole("button")).toHaveCount(initialRunCount + 1, {
							timeout: 120_000
						});
						await expect(selectedRunId).not.toHaveText(initialRunId, {
							timeout: 120_000
						});
						const image = selectedCapture.getByRole("img");
						await expect(image).toHaveJSProperty("naturalWidth", 1280);
						await expect(image).toHaveJSProperty("naturalHeight", 720);
						await page!.waitForTimeout(2_000);
					},
					description:
						"Workbench realizes the approved pose in Unreal and promotes a new immutable Capture Run.",
					page,
					slug: "02-new-capture",
					testInfo,
					title: "Capture the approved Review Set"
				})
			);
			const newRunId = await selectedRunId.textContent();
			if (!newRunId) throw new Error("The new Map Review capture has no run ID");
			chapters.push(
				await recordChapter({
					action: async () => {
						const completedRuns = history
							.getByRole("button")
							.filter({ hasText: "completed" });
						await completedRuns.nth(1).click();
						await expect(selectedRunId).toHaveText(initialRunId);
						await page!.waitForTimeout(1_200);
						await completedRuns.first().click();
						await expect(selectedRunId).toHaveText(newRunId);
						await page!.waitForTimeout(1_000);
					},
					description:
						"The previous and fresh observations remain independently addressable in local history.",
					page,
					resetScroll: false,
					slug: "03-before-and-after",
					testInfo,
					title: "Review before and after"
				})
			);
		} else {
			await startScreencast();
			chapters.push(
				await recordChapter({
					action: () => workbench.expectShowcaseReady(),
					description:
						"The committed fixture and saved-asset reader are ready without Unreal.",
					page,
					slug: "01-showcase-ready",
					testInfo,
					title: "Showcase is ready"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("Data Authoring");
						await expect(
							page!.getByRole("heading", { name: "Table ledger" })
						).toBeVisible();
						await expect(
							page!.getByRole("region", { name: "Table manifest" })
						).toContainText("DT_Scalars");
					},
					description: "Open a typed DataTable directly from its saved package.",
					page,
					slug: "02-data-authoring",
					testInfo,
					title: "Inspect a saved DataTable"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("Texture Audit");
						await expect(
							page!.getByRole("heading", { name: "Texture evidence desk" })
						).toBeVisible();
						await expect(
							page!.getByRole("region", { name: "Scan coverage" })
						).toContainText("Textures");
					},
					description: "Inspect whole-corpus rules and serialized texture evidence.",
					page,
					slug: "03-texture-audit",
					testInfo,
					title: "Review texture evidence"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("Game Text");
						await expect(
							page!.getByRole("heading", { name: "Find the words in the game." })
						).toBeVisible();
						await page!
							.getByRole("searchbox", { name: "Search corpus" })
							.fill("Continue");
						await expect(
							page!.getByRole("region", { name: "Text units" })
						).toContainText("Continue");
					},
					description: "Search player-facing language while preserving Unreal identity.",
					page,
					slug: "04-game-text",
					testInfo,
					title: "Search the saved game text corpus"
				})
			);
		}
	} catch (cause) {
		failure = cause;
	} finally {
		if (page && screencastStarted) {
			await page.screencast.stop().catch((cause: unknown) => artifactFailure("video", cause));
			await stat(testInfo.outputPath("demo.webm"))
				.then((info) => {
					if (info.size === 0) throw new Error("The showcase video is empty");
					videoReady = true;
				})
				.catch((cause: unknown) => artifactFailure("video", cause));
		}
		if (page && !page.isClosed()) {
			await page
				.screenshot({ path: testInfo.outputPath("final.png") })
				.catch((cause: unknown) => artifactFailure("screenshot", cause));
		}
		if (application && traceStarted) {
			await application
				.context()
				.tracing.stop({ path: testInfo.outputPath("trace.zip") })
				.catch((cause: unknown) => artifactFailure("trace", cause));
		}
		if (application) {
			const closeResult = await Promise.race([
				application
					.close()
					.then(() => "closed" as const)
					.catch((cause: unknown) => {
						artifactFailure("close", cause);
						return "failed" as const;
					}),
				new Promise<"timed-out">((resolveTimeout) =>
					setTimeout(() => resolveTimeout("timed-out"), 10_000)
				)
			]);
			if (closeResult === "timed-out") {
				logs.push("[recorder:close] Electron did not exit in 10 seconds; terminated it.");
				application.process().kill();
			}
		}
		await rm(playwrightArtifacts, { force: true, recursive: true }).catch((cause: unknown) =>
			artifactFailure("cleanup", cause)
		);

		await writeFile(testInfo.outputPath("workbench.log"), logs.join("\n"), "utf8");
		const manifest = decodeManifest({
			artifacts: {
				finalScreenshot: "final.png",
				logs: "workbench.log",
				trace: "trace.zip",
				...(videoReady ? { video: "demo.webm" } : {})
			},
			chapters,
			commit: process.env.UE_SHED_RECORDING_COMMIT ?? "unknown",
			contract: { name: "ue-shed-showcase-recording", version: 1 },
			dirty: process.env.UE_SHED_RECORDING_DIRTY === "true",
			...(failure ? { error: errorMessage(failure) } : {}),
			finishedAt: new Date().toISOString(),
			id: process.env.UE_SHED_RECORDING_ID ?? "unknown",
			journey,
			startedAt,
			status: failure ? "failed" : "passed"
		});
		await writeFile(
			testInfo.outputPath("run.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8"
		);
	}

	if (failure) throw failure;
});
