import { createRequire } from "node:module";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { Schema } from "effect";
import { _electron as electron, type ElectronApplication } from "playwright";
import { WorkbenchPage } from "../pages/workbench-page.js";

const RecordingJourney = Schema.Literals([
	"saved-workflows",
	"site-saved",
	"custodian",
	"config-explorer",
	"map-review",
	"world-log",
	"world-log-fast"
]);
const FixtureLaunchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready") }),
	Schema.Struct({
		message: Schema.String,
		recovery: Schema.String,
		status: Schema.Literal("failed")
	})
]);

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
	status: Schema.Literals(["passed", "failed"])
});

const decodeManifest = Schema.decodeUnknownSync(RecordingManifest);
const decodeJourney = Schema.decodeUnknownSync(RecordingJourney);
const decodeFixtureLaunchResult = Schema.decodeUnknownSync(FixtureLaunchResult);
const journey = decodeJourney(process.env.UE_SHED_RECORDING_JOURNEY ?? "saved-workflows");
const require = createRequire(import.meta.url);
const electronExecutable: unknown = require("electron");
const workbenchRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

if (!Schema.is(Schema.String)(electronExecutable)) {
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
		await options.page.evaluate("document.fonts.ready");
		const screenshot = `chapters/${options.slug}.png`;
		await options.page.screenshot({
			animations: "disabled",
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
			args: [workbenchRoot, `--user-data-dir=${testInfo.outputPath("profile")}`],
			artifactsDir: playwrightArtifacts,
			cwd: workbenchRoot,
			env: {
				...environment,
				ELECTRON_DISABLE_SECURITY_WARNINGS: "true"
			},
			executablePath: electronExecutable
		});
		page = await application.firstWindow();
		await application.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
		});
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
		const workbench = new WorkbenchPage(page);
		const startScreencast = async () => {
			// Electron's outer-window screenshot can be taller than the frame CDP delivers.
			// Probe one frame first so FFmpeg uses the actual content dimensions.
			const screenshot = await page!.screenshot({ type: "png" });
			const requestedSize = {
				height: screenshot.readUInt32BE(20) & ~1,
				width: screenshot.readUInt32BE(16) & ~1
			};
			let resolveFirstFrame: (size: {
				readonly height: number;
				readonly width: number;
			}) => void = () => undefined;
			const firstFrame = new Promise<{ readonly height: number; readonly width: number }>(
				(resolve) => {
					resolveFirstFrame = resolve;
				}
			);
			await page!.screencast.start({
				onFrame: ({ viewportHeight, viewportWidth }) =>
					resolveFirstFrame({ height: viewportHeight, width: viewportWidth }),
				size: requestedSize
			});
			const streamedSize = await firstFrame;
			await page!.screencast.stop();
			const size = {
				height: streamedSize.height & ~1,
				width: streamedSize.width & ~1
			};
			await page!.screencast.start({
				annotate: { duration: 700, fontSize: 18, position: "top-right" },
				path: testInfo.outputPath("demo.webm"),
				size
			});
			screencastStarted = true;
		};
		const startTracing = async () => {
			// Tracing must join the correctly-sized video stream instead of creating the first stream.
			await application!.context().tracing.start({
				screenshots: true,
				snapshots: true,
				sources: true
			});
			traceStarted = true;
		};
		if (journey === "map-review") {
			await workbench.expectShowcaseReady();
			const launch = decodeFixtureLaunchResult(
				await page.evaluate("globalThis.ueShed.fixture.launchReview()")
			);
			if (launch.status === "failed") throw new Error(`${launch.message} ${launch.recovery}`);
			await workbench.openRoute("Map Review");
			await expect(page.getByRole("region", { name: "Review set status" })).toContainText(
				"/Game/Fixture/Cameras/L_CameraLoad"
			);
			const history = page.getByRole("region", { name: "Runs" });
			const selectedCapture = page.getByRole("region", { name: "Selected capture" });
			const selectedRunId = selectedCapture.locator("code").first();
			const captureFreshRun = async () => {
				await page!.getByRole("button", { name: "Capture set", exact: true }).click();
				const dialog = page!.getByRole("dialog", { name: "Capture review set" });
				await dialog.getByRole("button", { name: /REVIEW CAPTURE PLAN/ }).click();
				await dialog.getByRole("button", { name: "CAPTURE 1 VIEW", exact: true }).click();
				const completed = dialog.getByRole("region", { name: "Capture complete" });
				await expect(completed).toBeVisible({ timeout: 120_000 });
				await expect(completed).toContainText(/1\s*Captured/);
				await expect(completed).toContainText(/0\s*Failed/);
				const runId = (await completed.locator("code").textContent())?.trim();
				if (!runId) throw new Error("The capture omitted its run ID");
				await dialog.getByRole("button", { name: "DONE", exact: true }).click();
				await expect(selectedRunId).toHaveText(runId);
				const image = selectedCapture.getByRole("img", { name: /^Natural capture/ });
				await expect(image).toHaveJSProperty("naturalWidth", 1280);
				await expect(image).toHaveJSProperty("naturalHeight", 720);
				return runId;
			};
			// Capture both observations now: an old local run must never become the website baseline.
			const initialRunId = await captureFreshRun();
			await startScreencast();
			await startTracing();
			chapters.push(
				await recordChapter({
					action: async () => {
						await selectedCapture.scrollIntoViewIfNeeded();
						await expect(selectedRunId).toHaveText(initialRunId);
					},
					description:
						"A fresh observation of the colorful Camera Lab fixture establishes the baseline.",
					page,
					resetScroll: false,
					slug: "01-before-capture",
					testInfo,
					title: "The Camera Lab map, through Map Review"
				})
			);
			let newRunId = "";
			chapters.push(
				await recordChapter({
					action: async () => {
						newRunId = await captureFreshRun();
						expect(newRunId).not.toBe(initialRunId);
						await selectedCapture.scrollIntoViewIfNeeded();
					},
					description:
						"Capture the same approved pose into another immutable run without replacing the baseline.",
					page,
					resetScroll: false,
					slug: "02-new-capture",
					testInfo,
					title: "Recapture the approved view"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						const completedRuns = history
							.getByRole("button")
							.filter({ hasText: "completed" });
						await completedRuns.nth(1).click();
						await expect(selectedRunId).toHaveText(initialRunId);
						await completedRuns.first().click();
						await expect(selectedRunId).toHaveText(newRunId);
						await expect(
							selectedCapture.getByRole("button", { name: "Compare previous run" })
						).toBeEnabled();
						await selectedCapture.scrollIntoViewIfNeeded();
					},
					description:
						"Both fresh observations of the colorful fixture remain independently addressable in history.",
					page,
					resetScroll: false,
					slug: "03-before-and-after",
					testInfo,
					title: "Review the colorful Camera Lab map"
				})
			);
		} else if (journey === "world-log-fast") {
			await startScreencast();
			await startTracing();
			const queryPanel = page.getByRole("region", { name: "Map history query" });
			const targetPanel = page.getByRole("region", { name: "Fast history target" });
			const targetExplorer = targetPanel.getByRole("region", {
				name: "Fast history targets"
			});
			const investigation = page.getByRole("region", {
				name: "Result views"
			});
			const coverage = page.getByRole("region", { name: "Fast history coverage" });
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("World Log");
						await expect(
							page!.getByRole("heading", { name: "World log" })
						).toBeVisible();
						const savedMap = page!.getByRole("combobox", { name: "Saved map" });
						const fixtureMapPath = await savedMap
							.locator("option")
							.filter({ hasText: /map\s*history\s*world/i })
							.getAttribute("value");
						expect(fixtureMapPath).toBeTruthy();
						await savedMap.selectOption(fixtureMapPath!);
						await page!.getByRole("button", { name: "Fast history" }).click();
						await expect(queryPanel).toContainText(
							"Target one current actor or class."
						);
						const actorTargets = targetPanel.getByRole("list", {
							name: "Actor targets"
						});
						await expect(actorTargets).toBeVisible();
						const firstActor = actorTargets.locator("button[aria-pressed]").first();
						await expect(firstActor).toBeVisible();
						await firstActor.click();
						await expect(firstActor).toHaveAttribute("aria-pressed", "true");
					},
					description:
						"Fast History can start from one current actor in the selected map before any Perforce scan runs.",
					page,
					slug: "01-fast-history-actor-target",
					testInfo,
					title: "Choose a current actor target"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await expect(
							targetPanel.getByRole("list", { name: "Actor targets" })
						).toBeVisible();
						await targetPanel
							.getByRole("button", { name: "Actor class", exact: true })
							.click();
						await expect(
							targetPanel.getByRole("list", { name: "Class members" })
						).toBeVisible();
						await targetExplorer
							.getByRole("button", { name: "Toggle actor class filters" })
							.click();
						const classTarget = targetExplorer
							.getByLabel("Actor class filters")
							.getByRole("button")
							.first();
						await expect(classTarget).toBeVisible();
						await classTarget.click();
						await expect(classTarget).toHaveAttribute("aria-pressed", "true");
					},
					description:
						"Fast History starts from the present-day actor projection and narrows the scan to one current class.",
					page,
					slug: "02-fast-history-class-target",
					testInfo,
					title: "Choose a current actor class"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!.getByRole("button", { name: "Read history" }).click();
						await expect(investigation).toContainText("CLs", {
							timeout: 120_000
						});
						await expect(coverage).toBeVisible();
						await expect(coverage).toContainText("Following");
						await expect(coverage).toContainText("current actor");
						await expect(coverage).toContainText(
							"Deleted or historically reclassified actors are outside this result"
						);
						await coverage.scrollIntoViewIfNeeded();
					},
					description:
						"The result keeps the current-class boundary visible instead of implying complete historical coverage.",
					page,
					resetScroll: false,
					slug: "03-fast-history-result",
					testInfo,
					title: "Read targeted class history"
				})
			);
		} else if (journey === "world-log") {
			await startScreencast();
			await startTracing();
			const outliner = page.getByRole("complementary", { name: "Saved actor outliner" });
			const savedActors = outliner.getByRole("list", { name: "Saved actors" });
			const actorSearch = outliner.getByRole("textbox", {
				name: "Find an actor"
			});
			const timeline = page.getByRole("region", { name: "History timeline" });
			const evidence = page.getByRole("complementary", {
				name: "Changelist details"
			});
			const worldStateLens = page.getByRole("tab", { name: "Actors" });
			const changelistLens = page.getByRole("tab", { name: "Changelists" });
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("World Log");
						await expect(
							page!.getByRole("heading", { name: "World log" })
						).toBeVisible();
						const savedMap = page!.getByRole("combobox", { name: "Saved map" });
						const fixtureMapPath = await savedMap
							.locator("option")
							.filter({ hasText: /map\s*history\s*world/i })
							.getAttribute("value");
						expect(fixtureMapPath).toBeTruthy();
						await savedMap.selectOption(fixtureMapPath!);
						await page!.getByRole("button", { name: "Read history" }).click();
						await expect(
							page!.getByRole("region", { name: "Result views" })
						).toContainText("CLs", {
							timeout: 120_000
						});
						await expect(worldStateLens).toHaveAttribute("aria-selected", "true");
						await expect(
							page!.getByRole("application", {
								name: "Top-down saved actor points map"
							})
						).toBeVisible();
					},
					description:
						"A bounded scan opens directly into the reconstructed saved world, with coverage and evidence counts in view.",
					page,
					slug: "01-world-log-scan",
					testInfo,
					title: "Read the World Partition history"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						const eastMarker = savedActors.getByRole("button", {
							name: /East Marker/i
						});
						const eastGroup = eastMarker.locator("xpath=../../..");
						const eastClass = (
							await eastGroup
								.getByRole("button")
								.first()
								.locator("strong")
								.textContent()
						)?.trim();
						expect(eastClass).toBeTruthy();
						await outliner
							.getByRole("button", { name: "Toggle actor class filters" })
							.click();
						const classFilters = outliner.getByLabel("Actor class filters");
						const classFilter = classFilters
							.getByRole("button")
							.filter({ hasText: eastClass! })
							.first();
						await expect(classFilter).toBeVisible();
						await classFilter.click();
						await expect(classFilter).toHaveAttribute("aria-pressed", "true");
						await actorSearch.fill("East Marker");
						await expect(eastMarker).toBeVisible();
						await expect(savedActors.locator("button[aria-pressed]")).toHaveCount(1);
					},
					description:
						"The shared actor explorer combines class facets and text search without leaving the map workspace.",
					page,
					slug: "02-actor-explorer",
					testInfo,
					title: "Filter actors by class and label"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await actorSearch.fill("");
						const eastMarker = savedActors.getByRole("button", {
							name: /East Marker/i
						});
						await eastMarker.click();
						await expect(eastMarker).toHaveAttribute("aria-pressed", "true");
						const selectedActor = page!.getByRole("complementary", {
							name: "Selected saved actor"
						});
						await expect(selectedActor).toContainText("East Marker");
						await expect(selectedActor).toContainText("Movement");
					},
					description:
						"Selecting a row selects the same actor on the point map and inspector, then focuses the map on it.",
					page,
					slug: "03-moved-actor",
					testInfo,
					title: "Inspect a moved actor"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await outliner.getByRole("button", { name: /East Marker/i }).click();
						await changelistLens.click();
						await expect(changelistLens).toHaveAttribute("aria-selected", "true");
						await timeline
							.getByRole("toolbar", { name: "Change filters" })
							.getByRole("button", { name: "Label changed" })
							.click();
						const labelChange = timeline
							.getByRole("button", {
								name: /label changed/i
							})
							.last();
						await labelChange.click();
						await expect(evidence).toContainText("actor label changed");
					},
					description:
						"The changelist lens keeps the selected actor, semantic transition, and package revision together.",
					page,
					slug: "04-label-change",
					testInfo,
					title: "Inspect a label change"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await worldStateLens.click();
						await outliner.getByRole("button", { name: /South Marker/i }).click();
						const selectedActor = page!.getByRole("complementary", {
							name: "Selected saved actor"
						});
						await selectedActor
							.getByRole("button", { name: /new saved actor/i })
							.click();
						await worldStateLens.click();
						await expect(selectedActor).toContainText("Present");
						await expect(
							page!.getByRole("heading", { name: /^After CL \d+$/ })
						).toBeVisible();
						await page!
							.getByRole("navigation", { name: "Frames" })
							.getByRole("button", { name: /Show state after CL/ })
							.last()
							.click();
						await expect(selectedActor).toContainText("Not at frame");
					},
					description:
						"The scrubber shows an actor before its removal and confirms that it is absent later.",
					page,
					slug: "05-removal-over-time",
					testInfo,
					title: "View removal across time"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await changelistLens.click();
						await timeline
							.getByRole("button", { name: /Select changelist/ })
							.last()
							.click();
						await expect(evidence).toContainText("Unclassified packages");
					},
					description:
						"The final changelist retains package edits that cannot be safely explained as actor changes.",
					page,
					slug: "06-unclassified-evidence",
					testInfo,
					title: "Keep unclassified evidence visible"
				})
			);
		} else if (journey === "custodian") {
			await startScreencast();
			await startTracing();
			const recordingPage = page;
			if (recordingPage === undefined) throw new Error("Workbench page is unavailable");
			const cleanup = recordingPage.getByRole("dialog", { name: "Review cleanup" });
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.expectShowcaseReady();
						await workbench.openRoute("Project Custodian");
						await expect(
							recordingPage.getByRole("region", { name: "Storage summary" })
						).toBeVisible();
						await expect(
							recordingPage.getByRole("complementary", { name: "Dry-run plan" })
						).toContainText("ReclaimableShowcase");
					},
					description:
						"Scan a disposable Unreal project and distinguish authored content from its exact rebuildable queue.",
					page: recordingPage,
					slug: "01-storage-plan",
					testInfo,
					title: "Inventory rebuildable storage"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await recordingPage
							.getByRole("button", { name: "Review cleanup…" })
							.click();
						await expect(cleanup).toBeVisible();
						await expect(
							cleanup.getByRole("region", { name: "Select cleanup targets" })
						).toContainText("Trash / Recycle Bin");
					},
					description:
						"Select exact target IDs and the recoverable Trash mode before any mutation authority exists.",
					page: recordingPage,
					slug: "02-target-selection",
					testInfo,
					title: "Select cleanup targets"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await cleanup.getByRole("button", { name: "Create proposal" }).click();
						await expect(
							cleanup.getByRole("region", { name: "Approve cleanup proposal" })
						).toBeVisible();
					},
					description:
						"Persist the exact plan and expose its approval phrase, receipt path, and revalidation contract.",
					page: recordingPage,
					slug: "03-durable-proposal",
					testInfo,
					title: "Create a durable proposal"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						const phrase = await cleanup.getByText(/^RECLAIM proposal-/).textContent();
						if (phrase === null)
							throw new Error("Custodian approval phrase is missing");
						await cleanup.getByRole("textbox").fill(phrase);
						await cleanup.getByRole("button", { name: "Move to Trash" }).click();
						await expect(
							cleanup.getByRole("region", { name: "Cleanup result" })
						).toContainText("Cleanup finished");
					},
					description:
						"Approve the reviewed proposal, revalidate against live disk state, and retain a per-target receipt.",
					page: recordingPage,
					slug: "04-cleanup-receipt",
					testInfo,
					title: "Execute with durable evidence"
				})
			);
		} else if (journey === "config-explorer") {
			await startScreencast();
			await startTracing();
			const evidence = page.getByRole("region", { name: "Comparison" });

			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.expectShowcaseReady();
						await workbench.openRoute("Config Explorer");
						await expect(
							page!.getByRole("navigation", { name: "Breadcrumb" })
						).toContainText("Config Explorer");
						await page!.getByLabel("Config key").fill("Entries");
						await page!.getByRole("button", { name: "Compare" }).click();
						await expect(
							evidence.getByText("Value diverges", { exact: true })
						).toBeVisible();
						await expect(
							page!.getByRole("region", { name: "Platform config comparison" })
						).toContainText("PlatformA");
					},
					description:
						"Enter a family, section, key, and two platforms, then execute a real headless comparison over the saved hierarchy.",
					page,
					slug: "01-platform-comparison",
					testInfo,
					title: "Build and run a config query"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						const contributions = page!.getByRole("list", {
							name: "PlatformA ordered contributions"
						});
						await expect(contributions).toContainText("clear");
						await contributions.scrollIntoViewIfNeeded();
					},
					description:
						"Trace every source line in order, including no-ops, removals, clearing, and the effects that still survive.",
					page,
					resetScroll: false,
					slug: "02-platform-a-lineage",
					testInfo,
					title: "Read the ordered contribution ledger"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!.getByRole("button", { name: /Last writer/ }).click();
						await expect(page!.getByLabel("Config key")).toHaveValue("Mode");
						await expect(
							page!.getByRole("region", {
								name: "PlatformA effective saved value"
							})
						).toContainText("PlatformA");
					},
					description:
						"One-click examples execute the same editable query and show scalar replacement with the prior saved value.",
					page,
					slug: "03-scalar-replacement",
					testInfo,
					title: "Investigate another key"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!.getByRole("button", { name: /Empty vs missing/ }).click();
						await expect(
							page!.getByRole("region", {
								name: "PlatformA effective saved value"
							})
						).toContainText("[ explicit empty ]");
					},
					description:
						"An initialized-empty array remains distinct from a key that never existed or was later cleared.",
					page,
					slug: "04-explicit-empty",
					testInfo,
					title: "Distinguish explicit empty from missing"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!.getByRole("button", { name: /Coverage gap/ }).click();
						await expect(
							evidence.getByText("partial coverage", { exact: true })
						).toBeVisible();
						await expect(
							page!.getByRole("region", { name: "PlatformA coverage exceptions" })
						).toContainText("unsupported");
					},
					description:
						"Unsupported syntax becomes a typed partial-coverage result instead of a confident but incomplete answer.",
					page,
					slug: "05-unsupported-syntax",
					testInfo,
					title: "Surface coverage limits"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						const selectedProject = page!.getByRole("button", {
							name: "Selected project"
						});
						await selectedProject.click();
						await expect(selectedProject).toHaveAttribute("aria-pressed", "true");
						await page!.getByLabel("Config family").fill("Engine");
						await page!
							.getByLabel("Config section")
							.fill("/Script/EngineSettings.GameMapsSettings");
						await page!.getByLabel("Config key").fill("GameDefaultMap");
						await page!
							.getByRole("combobox", { name: "Platform", exact: true })
							.fill("Windows");
						await page!.getByRole("button", { name: /^TRACE VALUE/ }).click();
						const selectedValue = page!.getByRole("region", {
							name: "Windows effective saved value"
						});
						await expect(selectedValue).toContainText(
							"/Game/Fixture/Cameras/L_CameraLoad"
						);
						await selectedValue.scrollIntoViewIfNeeded();
					},
					description:
						"Switch from the portable sample to the globally selected Workbench project, keeping engine discovery and filesystem reads in the trusted main process.",
					page,
					resetScroll: false,
					slug: "06-selected-project",
					testInfo,
					title: "Target the selected Unreal project"
				})
			);
		} else {
			await startScreencast();
			await startTracing();
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.expectShowcaseReady();
						await page!.getByRole("button", { name: "Launch ▾", exact: true }).click();
						await expect(
							page!.getByRole("button", { name: /With plugin suite/i })
						).toBeVisible();
						await expect(
							page!.getByRole("button", { name: /Plain editor/i })
						).toBeVisible();
					},
					description:
						"The project is usable offline; both editor launch modes remain explicit and leave the project descriptor unchanged.",
					page,
					slug: "01-offline-project-launch-options",
					testInfo,
					title: "Offline first, full editor on demand"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!.getByRole("button", { name: "Launch ▾", exact: true }).click();
						await workbench.openRoute("Data Authoring");
						await expect(
							page!.getByRole("region", { name: "Table summary" })
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
						await page!.getByRole("tab", { name: "Charts" }).click();
						await expect(page!.getByText("Enabled distribution")).toBeVisible();
						await expect(page!.getByText("Count distribution")).toBeVisible();
						await expect(
							page!.getByRole("navigation", { name: "Project DataTables" })
						).toBeVisible();
					},
					description:
						"Switch the open table to Charts to see inferred distributions without leaving the catalog.",
					page,
					slug: "02-data-authoring-charts",
					testInfo,
					title: "Chart the open DataTable"
				})
			);
			if (journey !== "site-saved")
				chapters.push(
					await recordChapter({
						action: async () => {
							await workbench.openRoute("Texture Audit");
							await expect(
								page!.getByRole("navigation", { name: "Breadcrumb" })
							).toBeVisible();
							await expect(
								page!.getByRole("complementary", {
									name: "Facets"
								})
							).toContainText(/textures/i);
							await expect(
								page!.getByRole("article", { name: "Asset" })
							).toContainText("Comparison");
							await page!
								.getByRole("button", { name: /Generate \d+ saved previews/ })
								.click();
							await expect(page!.getByLabel("Preview authority")).toHaveText(
								"Saved asset",
								{
									timeout: 90_000
								}
							);
							await page!
								.getByRole("region", { name: "Results" })
								.getByRole("button", { name: /T_Audit_UI_2048x1024/ })
								.click();
							await expect(page!.getByLabel("Preview authority")).toHaveText(
								"Saved asset"
							);
						},
						description:
							"Move from a rule finding to peer evidence, while filling the bounded saved-preview cache in one headless Unreal launch.",
						page,
						slug: "03-texture-audit",
						testInfo,
						title: "Investigate a texture outlier"
					})
				);
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("Game Text");
						// A fresh profile scans on request; nothing reads the project before that.
						await page!
							.getByRole("button", { name: "Scan project", exact: true })
							.click();
						const results = page!.getByRole("region", { name: "Results" });
						// Only the worst group starts open once the list is longer than a page.
						const translationWork = results.getByRole("button", {
							name: /^Translation work \d/u
						});
						await translationWork.click();
						await expect(translationWork).toHaveAttribute("aria-expanded", "true");
						await expect(
							results.getByRole("img", { name: /de to update, fr to update/u })
						).toBeVisible();
						await expect(
							page!.getByRole("button", { name: "Culture: All cultures" })
						).toBeVisible();
					},
					description:
						"Every line grouped by what it needs, with a strip showing each culture's translation state.",
					page,
					slug: "04-game-text",
					testInfo,
					title: "Review lines by what they need"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("Config Explorer");
						await page!.getByRole("button", { name: /^Compare platforms/i }).click();
						await expect(
							page!.getByRole("region", { name: "Config Explorer evidence" })
						).toContainText("Value diverges");
						await expect(
							page!.getByRole("region", { name: "Platform config comparison" })
						).toContainText("PlatformA");
					},
					description:
						"The same saved key resolves independently across two platforms, with every source layer retained as evidence.",
					page,
					slug: "05-config-platform-comparison",
					testInfo,
					title: "Compare saved config across platforms"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!
							.getByRole("list", { name: "PlatformA ordered contributions" })
							.scrollIntoViewIfNeeded();
						await expect(
							page!.getByRole("list", { name: "PlatformA ordered contributions" })
						).not.toBeEmpty();
					},
					description:
						"The ordered ledger exposes operation, source line, concrete effect, and whether each contribution survives.",
					page,
					slug: "06-config-contribution-ledger",
					resetScroll: false,
					testInfo,
					title: "Trace the winning value"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!.getByRole("button", { name: /Coverage gap/ }).click();
						await page!.getByRole("button", { name: /^Trace value/i }).click();
						await expect(
							page!.getByRole("region", { name: "PlatformA coverage exceptions" })
						).toContainText("unsupported");
					},
					description:
						"Unsupported syntax remains a visible partial-coverage exception instead of being silently ignored.",
					page,
					slug: "07-config-coverage-boundary",
					testInfo,
					title: "Keep uncertainty visible"
				})
			);
			if (journey === "site-saved")
				chapters.push(
					await recordChapter({
						action: async () => {
							await workbench.openRoute("Map Review");
							const source = page!
								.getByRole("tablist", { name: "Map data source" })
								.getByRole("tab", { name: "Saved map", exact: true });
							await source.click();
							await expect(source).toHaveAttribute("aria-selected", "true");
							const savedMap = page!.getByRole("region", {
								name: "Saved top-down actor map"
							});
							const picker = savedMap.getByRole("combobox", { name: "Saved map" });
							await expect(picker).toBeEnabled({ timeout: 90_000 });
							await picker.click();
							await savedMap
								.getByRole("searchbox", { name: "Search saved maps" })
								.fill("L_CameraLoad");
							await savedMap
								.getByRole("option", {
									name: /Content\/Fixture\/Cameras\/L_CameraLoad\.umap/
								})
								.click();
							await expect(picker).toContainText("L_CameraLoad", { timeout: 90_000 });
							await expect(savedMap.locator("header")).toContainText(
								"/Game/Fixture/Cameras/L_CameraLoad"
							);
							await expect(savedMap).toContainText(/[1-9]\d* of [\d,]+ actors/);
							const actors = savedMap.getByRole("list", { name: "Saved actors" });
							await expect(actors.getByRole("button").first()).toBeVisible();
							const pointMap = savedMap.getByRole("application", {
								name: "Top-down saved actor map"
							});
							await expect(pointMap).toBeVisible();
							await expect
								.poll(() =>
									pointMap.evaluate(
										(canvas: {
											readonly width: number;
											readonly height: number;
										}) => canvas.width * canvas.height
									)
								)
								.toBeGreaterThan(0);
							await expect(savedMap).toContainText(/\d[\d,]* × \d[\d,]* UU/);
							const findActor = savedMap.getByRole("textbox", {
								name: "Find saved actor"
							});
							await findActor.fill("path:PersistentLevel.ReviewSubject");
							const subject = actors.getByRole("button", { name: /Review Subject/ });
							await subject.click();
							await expect(subject).toHaveAttribute("aria-pressed", "true");
							await findActor.fill("");
							await savedMap.getByRole("button", { name: "Reset view" }).click();
							const details = savedMap.getByRole("complementary");
							await expect(
								details.getByRole("heading", {
									name: "Review Subject",
									exact: true
								})
							).toBeVisible();
							await expect(details).toContainText("PersistentLevel.ReviewSubject");
							await expect(details.getByRole("definition")).toHaveCount(5);
							await expect(details).toContainText("Read from saved project files.");
							await expect(page!.getByRole("alert")).toHaveCount(0);
							await expect(
								savedMap.getByRole("heading", { name: "Couldn't load saved map" })
							).toHaveCount(0);
							// Start the frame at the source tabs: the offline recorder's editor status probe
							// above them is expected to fail and is not part of the saved-map story.
							await page!
								.getByRole("tablist", { name: "Map data source" })
								.evaluate(
									(tabs: {
										scrollIntoView(options: { readonly block: "start" }): void;
									}) => tabs.scrollIntoView({ block: "start" })
								);
						},
						description:
							"Read Camera Lab's saved map without Unreal, inspect its actor positions, and select Review Subject as the starting point for review.",
						page,
						resetScroll: false,
						slug: "08-map-review-saved-map",
						testInfo,
						title: "Start review from the saved Camera Lab map"
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
				...(videoReady ? { video: "demo.webm" } : undefined)
			},
			chapters,
			commit: process.env.UE_SHED_RECORDING_COMMIT ?? "unknown",
			contract: { name: "ue-shed-showcase-recording", version: 1 },
			dirty: process.env.UE_SHED_RECORDING_DIRTY === "true",
			...(failure ? { error: errorMessage(failure) } : undefined),
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
