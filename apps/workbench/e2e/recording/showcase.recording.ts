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
			await workbench.openRoute("Map Review");
			await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
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
			await startTracing();

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
		} else if (journey === "world-log-fast") {
			await startScreencast();
			await startTracing();
			const queryPanel = page.getByRole("region", { name: "Map history query" });
			const targetPanel = page.getByRole("region", { name: "Fast History target" });
			const targetExplorer = targetPanel.getByRole("region", {
				name: "Fast History actor explorer"
			});
			const investigation = page.getByRole("region", {
				name: "World Log investigation lenses"
			});
			const coverage = page.getByRole("region", { name: "Fast History coverage" });
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("World Log");
						await expect(
							page!.getByRole("heading", { name: "World Log" })
						).toBeVisible();
						const savedMap = page!.getByRole("combobox", { name: "Saved map" });
						const fixtureMapPath = await savedMap
							.locator("option")
							.filter({ hasText: /map\s*history\s*world/i })
							.getAttribute("value");
						expect(fixtureMapPath).toBeTruthy();
						await savedMap.selectOption(fixtureMapPath!);
						await page!.getByRole("button", { name: "FAST HISTORY" }).click();
						await expect(queryPanel).toContainText("FAST HISTORY TARGET");
						const actorTargets = targetPanel.getByRole("list", {
							name: "Current actor targets"
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
							targetPanel.getByRole("list", { name: "Current actor targets" })
						).toBeVisible();
						await targetPanel
							.getByRole("button", { name: "ACTOR CLASS", exact: true })
							.click();
						await expect(
							targetPanel.getByRole("list", { name: "Current actor members" })
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
						await page!.getByRole("button", { name: /READ FAST HISTORY/ }).click();
						await expect(investigation).toContainText("submitted CLs", {
							timeout: 120_000
						});
						await expect(coverage).toBeVisible();
						await expect(coverage).toContainText("FAST HISTORY / TARGETED");
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
				name: "Find World Log actor"
			});
			const timeline = page.getByRole("region", { name: "History timeline" });
			const evidence = page.getByRole("complementary", {
				name: "Selected changelist evidence"
			});
			const worldStateLens = page.getByRole("tab", { name: "World state" });
			const changelistLens = page.getByRole("tab", { name: "Changelists" });
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("World Log");
						await expect(
							page!.getByRole("heading", { name: "World Log" })
						).toBeVisible();
						const savedMap = page!.getByRole("combobox", { name: "Saved map" });
						const fixtureMapPath = await savedMap
							.locator("option")
							.filter({ hasText: /map\s*history\s*world/i })
							.getAttribute("value");
						expect(fixtureMapPath).toBeTruthy();
						await savedMap.selectOption(fixtureMapPath!);
						await page!.getByRole("button", { name: /READ DEEP HISTORY/ }).click();
						await expect(
							page!.getByRole("region", { name: "World Log investigation lenses" })
						).toContainText("submitted CLs", {
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
						await expect(selectedActor).toContainText("MOVEMENT TRAIL");
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
							.getByRole("toolbar", { name: "Change View Filter" })
							.getByRole("button", { name: "LABEL CHANGED" })
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
						await expect(selectedActor).toContainText("AT FRAME");
						await expect(
							page!.getByRole("heading", { name: /AFTER CL \d+ point map/ })
						).toBeVisible();
						await page!
							.getByRole("navigation", { name: "Saved state scrubber" })
							.getByRole("button", { name: /Show state after CL/ })
							.last()
							.click();
						await expect(selectedActor).toContainText("NOT PRESENT");
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
						await expect(evidence).toContainText("UNCLASSIFIED PACKAGE EVIDENCE");
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
						await workbench.openRoute("Custodian");
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
						await cleanup.getByRole("button", { name: "CREATE PROPOSAL →" }).click();
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
						await cleanup.getByRole("button", { name: "MOVE TO TRASH" }).click();
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
			const evidence = page.getByRole("region", { name: "Config Explorer evidence" });

			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.expectShowcaseReady();
						await workbench.openRoute("Config");
						await expect(
							page!.getByRole("navigation", { name: "Breadcrumb" })
						).toContainText("CONFIG EXPLORER");
						await page!.getByLabel("Config key").fill("Entries");
						await page!.getByRole("button", { name: /^COMPARE/ }).click();
						await expect(
							evidence.getByText("VALUE DIVERGES", { exact: true })
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
						await page!.getByText("LAUNCH ▾", { exact: true }).click();
						await expect(
							page!.getByRole("button", { name: /WITH UE SHED/ })
						).toBeVisible();
						await expect(page!.getByRole("button", { name: /NORMALLY/ })).toBeVisible();
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
						await page!.getByText("LAUNCH ▾", { exact: true }).click();
						await workbench.openRoute("Data Authoring");
						await expect(
							page!.getByRole("navigation", { name: "Breadcrumb" })
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
							page!.getByRole("navigation", { name: "Breadcrumb" })
						).toBeVisible();
						await expect(
							page!.getByRole("complementary", {
								name: "Audit scope and distributions"
							})
						).toContainText(/textures/i);
						await expect(
							page!.getByRole("article", { name: "Texture investigation" })
						).toContainText("Compared with");
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
							.getByRole("region", { name: "Texture records" })
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
						await expect(
							page!.getByRole("navigation", { name: "Breadcrumb" })
						).toBeVisible();
						await page!
							.getByRole("searchbox", { name: "Search game text" })
							.fill("Hold to skip");
						await expect(
							page!.getByRole("region", { name: "Text units" })
						).toContainText("Hold to skip");
						await expect(
							page!.getByRole("complementary", { name: "Text focus" })
						).toContainText("2 uses");
						await page!.getByRole("searchbox", { name: "Search game text" }).fill("");
						await expect(
							page!.getByRole("region", { name: "Text units" })
						).toContainText("Showing 32 of 32 matches");
						await page!
							.getByRole("region", { name: "Text units" })
							.locator('[aria-current="true"]')
							.scrollIntoViewIfNeeded();
					},
					description:
						"One saved line stays connected to its stable Unreal identity and every authored use.",
					page,
					slug: "04-game-text",
					testInfo,
					title: "Investigate a shared source line"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await workbench.openRoute("Config");
						await expect(
							page!.getByRole("navigation", { name: "Breadcrumb" })
						).toContainText("Config Explorer");
						await expect(page!.getByRole("status")).toContainText("VALUE DIVERGES");
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
						await page!.getByRole("button", { name: /Platform A/ }).click();
						await expect(
							page!.getByRole("list", { name: "PlatformA ordered contributions" })
						).not.toBeEmpty();
					},
					description:
						"The ordered ledger exposes operation, source line, concrete effect, and whether each contribution survives.",
					page,
					slug: "06-config-contribution-ledger",
					testInfo,
					title: "Trace the winning value"
				})
			);
			chapters.push(
				await recordChapter({
					action: async () => {
						await page!.getByRole("button", { name: /Unsupported/ }).click();
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
