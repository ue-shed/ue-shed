import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import {
	CaptureProfile,
	CaptureProfileId,
	CaptureRun,
	ReviewAuthoringSession,
	ReviewSet,
	ReviewSetId,
	defaultNaturalOnlyVisibilityPolicy
} from "@ue-shed/cameras";
import { _electron as electron } from "playwright";
import { Effect, Schema } from "effect";
import type {
	MapReviewFlowAttachment,
	MapReviewFlowCheckpoint,
	MapReviewFlowCleanup
} from "../src/main/map-review-flow-contract.js";
import type {
	MapReviewAuthoringRoundtripDriver,
	MapReviewFlowCheckpointSink,
	MapReviewFlowStepEvidence
} from "../src/main/map-review-flow.js";
import { MapReviewFlowExecutionError } from "../src/main/map-review-flow.js";
import { WorkbenchPage } from "./pages/workbench-page.js";

const require = createRequire(import.meta.url);
const electronExecutable: unknown = require("electron");
const workbenchRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureContractPath = fileURLToPath(
	new URL("../../../fixtures/unreal-project/fixture-contract.json", import.meta.url)
);
const editorActorSubsystem = "/Script/UnrealEd.Default__EditorActorSubsystem";
const cameraLibrary = "/Script/UEShedCameras.Default__UEShedCameraLibrary";
const editorLoadingLibrary = "/Script/UnrealEd.Default__EditorLoadingAndSavingUtils";
const playSessionLibrary = "/Script/UEShedCoreEditor.Default__UEShedEditorPlaySessionLibrary";

if (typeof electronExecutable !== "string") {
	throw new TypeError("The Electron package did not resolve to an executable path");
}
const electronPath: string = electronExecutable;

interface RemoteCallResponse {
	readonly [key: string]: unknown;
}

const FixtureContract = Schema.Struct({
	mapReviewGallery: Schema.Struct({
		map: Schema.NonEmptyString,
		occluders: Schema.Record(Schema.String, Schema.NonEmptyString),
		subjects: Schema.Record(Schema.String, Schema.NonEmptyString),
		transforms: Schema.Record(
			Schema.String,
			Schema.Struct({
				location: Schema.Struct({ x: Schema.Finite, y: Schema.Finite, z: Schema.Finite }),
				rotation: Schema.Struct({
					pitch: Schema.Finite,
					roll: Schema.Finite,
					yaw: Schema.Finite
				}),
				scale: Schema.Struct({ x: Schema.Finite, y: Schema.Finite, z: Schema.Finite })
			})
		)
	})
});

export interface MapReviewFlowLifecycle {
	readonly afterLaunch?: (args: {
		readonly application: ElectronApplication;
		readonly page: Page;
		readonly segment: number;
	}) => Promise<void>;
	readonly beforeClose?: (args: {
		readonly application: ElectronApplication;
		readonly page: Page;
		readonly segment: number;
	}) => Promise<void>;
}

export interface MapReviewFlowHarness {
	readonly artifactRoot: string;
	readonly driver: MapReviewAuthoringRoundtripDriver;
	readonly fixtureMap: string;
	readonly flow: "authoring-roundtrip" | "high-count-rig";
	readonly page: () => Page;
	readonly subjectActorPath: string;
	readonly subjectKey: string;
	readonly subjectScale: { readonly x: number; readonly y: number; readonly z: number };
	readonly tempProjectRoot: string;
}

function flowError(operation: string, cause: unknown): MapReviewFlowExecutionError {
	return new MapReviewFlowExecutionError({
		message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
		operation
	});
}

function step(
	operation: string,
	run: () => Promise<MapReviewFlowStepEvidence>
): Effect.Effect<MapReviewFlowStepEvidence, MapReviewFlowExecutionError> {
	return Effect.tryPromise({ try: run, catch: (cause) => flowError(operation, cause) });
}

async function remoteCall(args: {
	readonly endpoint: string;
	readonly functionName: string;
	readonly objectPath: string;
	readonly parameters?: Readonly<Record<string, unknown>>;
}): Promise<RemoteCallResponse> {
	const response = await fetch(`${args.endpoint}/remote/object/call`, {
		body: JSON.stringify({
			functionName: args.functionName,
			generateTransaction: false,
			objectPath: args.objectPath,
			parameters: args.parameters ?? {}
		}),
		headers: { "content-type": "application/json" },
		method: "PUT",
		signal: AbortSignal.timeout(30_000)
	});
	if (!response.ok) {
		throw new Error(`${args.functionName} failed with HTTP ${response.status}`);
	}
	return (await response.json()) as RemoteCallResponse;
}

function launchEnvironment(overrides: Readonly<Record<string, string>>): Record<string, string> {
	if (!process.env.UE_SHED_UASSET_EXECUTABLE) {
		throw new Error("Launch Map Review flows through the repository flow command.");
	}
	const environment: Record<string, string> = {
		ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
		...overrides
	};
	for (const [key, value] of Object.entries(process.env)) {
		if (
			key === "ELECTRON_RUN_AS_NODE" ||
			key === "UE_SHED_SAVED_WORLD_MAP" ||
			key === "UE_SHED_SAVED_WORLD_MAPS" ||
			value === undefined
		) {
			continue;
		}
		if (!(key in environment)) environment[key] = value;
	}
	return environment;
}

function pngDimensions(bytes: Buffer): { readonly height: number; readonly width: number } {
	if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
		throw new Error("The raw capture is not a PNG.");
	}
	return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
}

async function readOnlyJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function createMapReviewFlowHarness(args: {
	readonly artifactRoot: string;
	readonly collection?: boolean;
	readonly endpoint: string;
	readonly flow?: "authoring-roundtrip" | "high-count-rig";
	readonly lifecycle?: MapReviewFlowLifecycle;
}): Promise<MapReviewFlowHarness> {
	const flow = args.flow ?? "authoring-roundtrip";
	const collection = args.collection ?? false;
	const contextCameraCount = flow === "high-count-rig" ? 31 : 5;
	const fixtureContract = Schema.decodeUnknownSync(FixtureContract)(
		await readOnlyJson(fixtureContractPath)
	);
	const galleryMap = fixtureContract.mapReviewGallery.map;
	const subjectKey = "compound";
	const compoundSubject = fixtureContract.mapReviewGallery.subjects[subjectKey];
	if (compoundSubject === undefined) {
		throw new Error(`The fixture contract has no ${subjectKey} Map Review subject.`);
	}
	const compoundTransform = fixtureContract.mapReviewGallery.transforms[subjectKey];
	if (compoundTransform === undefined) {
		throw new Error(`The fixture contract has no ${subjectKey} Map Review transform.`);
	}
	const tempProjectRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-review-flow-"));
	const configuredProjectRoot = process.env.UE_SHED_PROJECT_ROOT;
	if (configuredProjectRoot === undefined) {
		throw new Error("The Map Review flow requires the configured Unreal project root.");
	}
	const authoringRoot = join(configuredProjectRoot, ".ue-shed", "review", "authoring-sessions");
	const reviewSetPath = join(tempProjectRoot, "gallery-review-set.json");
	await mkdir(authoringRoot, { recursive: true });
	const initialAuthoringFiles = new Set(await readdir(authoringRoot));
	await mkdir(args.artifactRoot, { recursive: true });
	const policy = defaultNaturalOnlyVisibilityPolicy();
	const reviewSet = ReviewSet.make({
		captureProfiles: [
			CaptureProfile.make({
				id: CaptureProfileId.make("gallery-hd"),
				imageFormat: "png",
				renderProfile: "full_fidelity",
				resolution: { height: 720, width: 1280 }
			})
		],
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 1 } },
		description: "Isolated Map Review full-flow evidence.",
		displayName: "Map Review Flow Gallery",
		id: ReviewSetId.make("map-review-flow-gallery"),
		project: { id: "ue-shed-fixture", mapPath: galleryMap },
		views: [],
		visibilityPolicies: [policy]
	});
	await writeFile(reviewSetPath, `${JSON.stringify(reviewSet, null, 2)}\n`, "utf8");

	const environment = launchEnvironment({
		UE_SHED_FIXTURE_AUTHORING_MAP: galleryMap,
		UE_SHED_PROJECT_ROOT: configuredProjectRoot,
		UE_SHED_REMOTE_CONTROL_ENDPOINT: args.endpoint,
		UE_SHED_REVIEW_SET: reviewSetPath
	});
	let application: ElectronApplication | undefined;
	let workbench: WorkbenchPage | undefined;
	let segment = 0;
	let cleaned = false;
	let sessionPath: string | undefined;
	let runPath: string | undefined;
	let firstRunPath: string | undefined;
	const createdSessionPaths = new Set<string>();
	const createdRunPaths = new Set<string>();

	const currentWorkbench = (): WorkbenchPage => {
		if (workbench === undefined) throw new Error("Workbench is not running.");
		return workbench;
	};
	const launch = async () => {
		segment += 1;
		application = await electron.launch({
			args: [workbenchRoot],
			cwd: workbenchRoot,
			env: environment,
			executablePath: electronPath
		});
		const page = await application.firstWindow();
		workbench = new WorkbenchPage(page);
		await args.lifecycle?.afterLaunch?.({ application, page, segment });
	};
	const closeWorkbench = async () => {
		if (application === undefined || workbench === undefined) return;
		const closingApplication = application;
		const page = workbench.page;
		await args.lifecycle?.beforeClose?.({ application, page, segment });
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		const closed = await Promise.race([
			closingApplication.close().then(() => true),
			new Promise<false>((resolveTimeout) => {
				closeTimer = setTimeout(() => resolveTimeout(false), 10_000);
			})
		]);
		if (closeTimer !== undefined) clearTimeout(closeTimer);
		if (!closed) closingApplication.process().kill();
		application = undefined;
		workbench = undefined;
	};
	const selectActor = async (actorPath: string) => {
		await remoteCall({
			endpoint: args.endpoint,
			functionName: "SelectNothing",
			objectPath: editorActorSubsystem
		});
		await remoteCall({
			endpoint: args.endpoint,
			functionName: "SetActorSelectionState",
			objectPath: editorActorSubsystem,
			parameters: { Actor: actorPath, bShouldBeSelected: true }
		});
	};
	const captureCurrentSet = async (): Promise<string> => {
		const page = currentWorkbench().page;
		const saved = Schema.decodeUnknownSync(ReviewSet)(await readOnlyJson(reviewSetPath));
		await page.getByRole("button", { name: "CAPTURE SET" }).click();
		const dialog = page.getByRole("dialog", { name: "Capture review set" });
		await dialog.getByRole("button", { name: /REVIEW CAPTURE PLAN/ }).click();
		await dialog
			.getByRole("button", {
				name: `CAPTURE ${saved.views.length} ${saved.views.length === 1 ? "VIEW" : "VIEWS"}`
			})
			.click();
		const completed = dialog.getByRole("region", { name: "Capture complete" });
		await expect(completed).toBeVisible({ timeout: 180_000 });
		const runId = (await completed.locator("code").textContent())?.trim();
		if (!runId) throw new Error("The completed capture omitted its run ID.");
		const path = join(configuredProjectRoot, ".ue-shed", "review", "runs", runId, "run.json");
		await expect
			.poll(async () => {
				try {
					await readFile(path);
					return true;
				} catch {
					return false;
				}
			})
			.toBe(true);
		const run = Schema.decodeUnknownSync(CaptureRun)(await readOnlyJson(path));
		expect(run.results).toHaveLength(saved.views.length);
		if (run.status !== "completed")
			throw new Error(`Capture run failed: ${JSON.stringify(run)}`);
		createdRunPaths.add(path);
		await dialog.getByRole("button", { name: "DONE" }).click();
		return path;
	};
	await launch();

	const driver: MapReviewAuthoringRoundtripDriver = {
		prepareFixture: () =>
			step("prepareFixture", async () => {
				const current = currentWorkbench();
				await current.expectShowcaseReady();
				const launchResult = await current.page.evaluate(
					"globalThis.ueShed.fixture.launchReview()"
				);
				if (
					typeof launchResult !== "object" ||
					launchResult === null ||
					!("status" in launchResult) ||
					launchResult.status !== "ready"
				) {
					throw new Error(
						`The Map Review fixture did not become ready: ${JSON.stringify(launchResult)}`
					);
				}
				await current.openRoute("Map Review");
				await current.page.getByRole("tab", { name: "LIVE WORLD" }).click();
				await expect(current.page.getByText("Map Review Flow Gallery")).toBeVisible({
					timeout: 60_000
				});
				return {};
			}),
		selectSubject: () =>
			step("selectSubject", async () => {
				const page = currentWorkbench().page;
				const stop = page.getByRole("button", { exact: true, name: "STOP" });
				if (!(await stop.isVisible())) {
					await page.getByRole("button", { exact: true, name: "PLAY" }).click();
				}
				await expect(page.getByRole("button", { exact: true, name: "STOP" })).toBeVisible({
					timeout: 30_000
				});
				await selectActor(compoundSubject);
				return {};
			}),
		generateRig: () =>
			step("generateRig", async () => {
				const page = currentWorkbench().page;
				await page.getByRole("button", { name: "ADD SELECTED ACTOR AS VIEW" }).click();
				const candidates = page.getByRole("region", { name: "Framing candidates" });
				await expect(candidates.getByRole("button", { name: /^Select / })).toHaveCount(7, {
					timeout: 60_000
				});
				await expect
					.poll(async () => (await readdir(authoringRoot)).length)
					.toBeGreaterThan(0);
				const sessionFile = (await readdir(authoringRoot)).find(
					(name) => name.endsWith(".json") && !initialAuthoringFiles.has(name)
				);
				if (sessionFile === undefined)
					throw new Error("No authoring session was persisted.");
				sessionPath = join(authoringRoot, sessionFile);
				createdSessionPaths.add(sessionPath);
				const session = Schema.decodeUnknownSync(ReviewAuthoringSession)(
					await readOnlyJson(sessionPath)
				);
				return { identity: { sessionId: session.id } };
			}),
		tuneRig: () =>
			step("tuneRig", async () => {
				const page = currentWorkbench().page;
				const framing = page.locator("details").filter({ hasText: "VIEW PRESETS + RIG" });
				await framing.locator("summary").click();
				await framing
					.getByLabel("Context three-quarter exact camera count")
					.fill(String(contextCameraCount));
				await framing
					.locator("label")
					.filter({ hasText: "FIELD OF VIEW" })
					.getByRole("spinbutton")
					.fill("54");
				await framing
					.locator("label")
					.filter({ hasText: "FRAME MARGIN" })
					.getByRole("spinbutton")
					.fill("0.12");
				const candidates = page.getByRole("region", { name: "Framing candidates" });
				await expect(candidates.getByRole("button", { name: /^Select / })).toHaveCount(
					contextCameraCount + 6,
					{ timeout: 60_000 }
				);
				await candidates
					.getByRole("button", { exact: true, name: "Select Context three-quarter 1" })
					.click();
				await page.getByLabel("FOV OVERRIDE").fill("49");
				if (sessionPath === undefined) throw new Error("The session path is unavailable.");
				await expect
					.poll(
						async () => {
							if (sessionPath === undefined) return undefined;
							const session = Schema.decodeUnknownSync(ReviewAuthoringSession)(
								await readOnlyJson(sessionPath)
							);
							return session.candidateOverrides?.[0]?.overrides.fieldOfViewDegrees;
						},
						{ timeout: 30_000 }
					)
					.toBe(49);
				const session = Schema.decodeUnknownSync(ReviewAuthoringSession)(
					await readOnlyJson(sessionPath)
				);
				if (session.selectedCandidateId === undefined) {
					throw new Error("The tuned session has no selected candidate.");
				}
				return { identity: { candidateId: session.selectedCandidateId } };
			}),
		previewCandidate: () =>
			step("previewCandidate", async () => {
				const candidates = currentWorkbench().page.getByRole("region", {
					name: "Framing candidates"
				});
				if (flow === "high-count-rig") {
					await expect(candidates.getByText("RENDERING PREVIEW").first()).toBeVisible();
					return {};
				}
				const preview = candidates.locator("canvas, img").first();
				await expect(preview).toBeVisible({ timeout: 60_000 });
				const width = await preview.evaluate((node) => {
					const previewNode = node as unknown as {
						readonly naturalWidth: number;
						readonly tagName: string;
						readonly width: number;
					};
					return previewNode.tagName === "CANVAS"
						? previewNode.width
						: previewNode.naturalWidth;
				});
				expect(width).toBe(320);
				return {};
			}),
		approveView: () =>
			step("approveView", async () => {
				const page = currentWorkbench().page;
				await page
					.getByRole("textbox", { name: "MANUAL ADJUSTMENT NOTE" })
					.fill("Plan 39 recorded authoring round trip");
				await page.getByRole("button", { name: "KEEP VIEW" }).click();
				await expect(page.getByText("APPROVED + SAVED")).toBeVisible({ timeout: 60_000 });
				let saved = Schema.decodeUnknownSync(ReviewSet)(await readOnlyJson(reviewSetPath));
				expect(saved.views).toHaveLength(1);
				if (collection) {
					const additionalSubjects = [
						"compact",
						"tall",
						"wide",
						"asymmetric",
						"partial",
						"compound"
					] as const;
					for (const [index, key] of additionalSubjects.entries()) {
						const actorPath = fixtureContract.mapReviewGallery.subjects[key];
						if (actorPath === undefined)
							throw new Error(`Missing gallery subject ${key}.`);
						await selectActor(actorPath);
						await page
							.getByRole("button", { name: "ADD SELECTED ACTOR AS VIEW" })
							.click();
						await expect(page.getByRole("button", { name: "KEEP VIEW" })).toBeEnabled({
							timeout: 60_000
						});
						await page.getByRole("button", { name: "KEEP VIEW" }).click();
						await expect
							.poll(async () => {
								const current = Schema.decodeUnknownSync(ReviewSet)(
									await readOnlyJson(reviewSetPath)
								);
								return current.views.length;
							})
							.toBe(index + 2);
						saved = Schema.decodeUnknownSync(ReviewSet)(
							await readOnlyJson(reviewSetPath)
						);
						expect(saved.views).toHaveLength(index + 2);
					}
					const newFiles = (await readdir(authoringRoot)).filter(
						(name) => name.endsWith(".json") && !initialAuthoringFiles.has(name)
					);
					for (const file of newFiles) createdSessionPaths.add(join(authoringRoot, file));
				}
				return {
					identity: {
						viewId: saved.views[0]!.id,
						viewRevisionId: saved.views[0]!.revision.id
					}
				};
			}),
		verifyPersistence: () =>
			step("verifyPersistence", async () => {
				if (sessionPath === undefined) throw new Error("The session path is unavailable.");
				const persistedRoot = join(args.artifactRoot, "persisted");
				await mkdir(persistedRoot, { recursive: true });
				await copyFile(sessionPath, join(persistedRoot, "authoring-session.json"));
				await copyFile(reviewSetPath, join(persistedRoot, "review-set.json"));
				const session = Schema.decodeUnknownSync(ReviewAuthoringSession)(
					await readOnlyJson(sessionPath)
				);
				expect(session.lifecycle).toBe("approved");
				return {
					attachments: [
						{ kind: "persisted-json", path: "persisted/authoring-session.json" },
						{ kind: "persisted-json", path: "persisted/review-set.json" }
					],
					identity: { sessionId: session.id }
				};
			}),
		relaunchWorkbench: () =>
			step("relaunchWorkbench", async () => {
				await closeWorkbench();
				await launch();
				await currentWorkbench().expectShowcaseReady();
				return {};
			}),
		loadView: () =>
			step("loadView", async () => {
				const current = currentWorkbench();
				await current.openRoute("Map Review");
				await current.page.getByRole("tab", { name: "LIVE WORLD" }).click();
				const status = current.page.getByRole("region", { name: "Review set status" });
				await expect(status).toContainText("Map Review Flow Gallery", { timeout: 60_000 });
				await expect(status).toContainText(collection ? "7" : "1");
				const stop = current.page.getByRole("button", { exact: true, name: "STOP" });
				if (await stop.isVisible()) {
					await stop.click();
					await expect(
						current.page.getByRole("button", { exact: true, name: "PLAY" })
					).toBeVisible({ timeout: 30_000 });
				}
				const saved = Schema.decodeUnknownSync(ReviewSet)(
					await readOnlyJson(reviewSetPath)
				);
				return {
					identity: {
						viewId: saved.views[0]!.id,
						viewRevisionId: saved.views[0]!.revision.id
					}
				};
			}),
		captureView: () =>
			step("captureView", async () => {
				firstRunPath = await captureCurrentSet();
				if (collection) {
					const changedScale = {
						x: compoundTransform.scale.x * 1.15,
						y: compoundTransform.scale.y,
						z: compoundTransform.scale.z
					};
					try {
						await remoteCall({
							endpoint: args.endpoint,
							functionName: "SetActorScale3D",
							objectPath: compoundSubject,
							parameters: {
								NewScale3D: {
									X: changedScale.x,
									Y: changedScale.y,
									Z: changedScale.z
								}
							}
						});
						runPath = await captureCurrentSet();
					} finally {
						await remoteCall({
							endpoint: args.endpoint,
							functionName: "SetActorScale3D",
							objectPath: compoundSubject,
							parameters: {
								NewScale3D: {
									X: compoundTransform.scale.x,
									Y: compoundTransform.scale.y,
									Z: compoundTransform.scale.z
								}
							}
						});
					}
				} else {
					runPath = firstRunPath;
				}
				const run = Schema.decodeUnknownSync(CaptureRun)(await readOnlyJson(runPath));
				return { identity: { invocationId: run.invocation.id, runId: run.id } };
			}),
		inspectEvidence: () =>
			step("inspectEvidence", async () => {
				if (runPath === undefined) throw new Error("The capture run path is unavailable.");
				const run = Schema.decodeUnknownSync(CaptureRun)(await readOnlyJson(runPath));
				const result = run.results.find((candidate) => candidate.status === "captured");
				if (result?.status !== "captured")
					throw new Error("The flow has no captured result.");
				const artifact = result.artifacts.find((candidate) => candidate.variant === "pure");
				if (artifact === undefined)
					throw new Error("The captured result omitted Natural evidence.");
				const source = join(dirname(runPath), artifact.relativePath);
				const capturesRoot = join(args.artifactRoot, "captures");
				await mkdir(capturesRoot, { recursive: true });
				const destination = join(capturesRoot, "run-b-natural.png");
				await copyFile(source, destination);
				const dimensions = pngDimensions(await readFile(destination));
				expect(dimensions).toEqual({ height: 720, width: 1280 });
				const selected = currentWorkbench().page.getByRole("region", {
					name: "Selected capture"
				});
				const image = selected.getByRole("img", { name: /Natural capture/ });
				await expect(image).toHaveJSProperty("naturalWidth", 1280);
				if (collection) {
					await currentWorkbench()
						.page.getByRole("button", { name: "COMPARE PREVIOUS RUN" })
						.click();
					await expect(
						selected.getByRole("img", { name: /Previous run capture/ })
					).toHaveJSProperty("naturalWidth", 1280);
				}
				const attachments: MapReviewFlowAttachment[] = [
					{
						height: dimensions.height,
						kind: "raw-capture",
						path: "captures/run-b-natural.png",
						width: dimensions.width
					}
				];
				if (collection && firstRunPath !== undefined) {
					const first = Schema.decodeUnknownSync(CaptureRun)(
						await readOnlyJson(firstRunPath)
					);
					const firstResult = first.results.find(
						(candidate) => candidate.status === "captured"
					);
					const firstArtifact =
						firstResult?.status === "captured"
							? firstResult.artifacts.find(
									(candidate) => candidate.variant === "pure"
								)
							: undefined;
					if (firstArtifact === undefined)
						throw new Error("Run A omitted Natural evidence.");
					const firstDestination = join(capturesRoot, "run-a-natural.png");
					await copyFile(
						join(dirname(firstRunPath), firstArtifact.relativePath),
						firstDestination
					);
					const firstDimensions = pngDimensions(await readFile(firstDestination));
					attachments.unshift({
						height: firstDimensions.height,
						kind: "raw-capture",
						path: "captures/run-a-natural.png",
						width: firstDimensions.width
					});
					await expect(
						currentWorkbench().page.getByRole("region", { name: "Capture history" })
					).toContainText("captured");
				}
				return {
					attachments: [...attachments],
					identity: { artifactId: artifact.id }
				};
			}),
		cleanup: () =>
			Effect.tryPromise({
				try: async (): Promise<MapReviewFlowCleanup> => {
					if (cleaned) {
						return {
							mapDirtyAfter: false,
							provisionedCameraCountAfter: 0,
							status: "verified"
						};
					}
					cleaned = true;
					await remoteCall({
						endpoint: args.endpoint,
						functionName: "StopPlaySession",
						objectPath: playSessionLibrary
					}).catch(() => undefined);
					await closeWorkbench().catch(() => undefined);
					await remoteCall({
						endpoint: args.endpoint,
						functionName: "ClearProvisionedCameras",
						objectPath: cameraLibrary
					});
					const statusResponse = await remoteCall({
						endpoint: args.endpoint,
						functionName: "GetStatus",
						objectPath: cameraLibrary
					});
					const status = JSON.parse(String(statusResponse.ResultJson)) as {
						readonly cameras?: ReadonlyArray<unknown>;
					};
					const dirtyResponse = await remoteCall({
						endpoint: args.endpoint,
						functionName: "GetDirtyMapPackages",
						objectPath: editorLoadingLibrary
					});
					const dirtyMaps = Array.isArray(dirtyResponse.OutDirtyPackages)
						? dirtyResponse.OutDirtyPackages
						: [];
					await remoteCall({
						endpoint: args.endpoint,
						functionName: "SelectNothing",
						objectPath: editorActorSubsystem
					});
					await Promise.all(
						[...createdSessionPaths].map((path) => rm(path, { force: true }))
					);
					await Promise.all(
						[...createdRunPaths].map((path) =>
							rm(dirname(path), { force: true, recursive: true })
						)
					);
					await rm(tempProjectRoot, { force: true, recursive: true });
					const cameraCount = status.cameras?.length ?? 0;
					const mapDirty = dirtyMaps.some((entry) => String(entry).includes(galleryMap));
					return mapDirty || cameraCount !== 0
						? {
								message: `Cleanup left mapDirty=${mapDirty} and ${cameraCount} cameras.`,
								status: "failed"
							}
						: {
								mapDirtyAfter: false,
								provisionedCameraCountAfter: 0,
								status: "verified"
							};
				},
				catch: (cause) => flowError("cleanup", cause)
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed({ message: error.message, status: "failed" as const })
				)
			)
	};

	return {
		artifactRoot: args.artifactRoot,
		driver,
		fixtureMap: galleryMap,
		flow,
		page: () => currentWorkbench().page,
		subjectActorPath: compoundSubject,
		subjectKey,
		subjectScale: compoundTransform.scale,
		tempProjectRoot
	};
}

export function makeMapReviewCheckpointCollector(args: {
	readonly harness: MapReviewFlowHarness;
	readonly recording: boolean;
	readonly testInfo: TestInfo;
}): {
	readonly checkpoints: ReadonlyArray<MapReviewFlowCheckpoint>;
	readonly sink: MapReviewFlowCheckpointSink;
} {
	const checkpoints: MapReviewFlowCheckpoint[] = [];
	return {
		checkpoints,
		sink: {
			checkpoint: (checkpoint) =>
				Effect.tryPromise({
					try: async () => {
						if (checkpoint.id === "cleanup-verified") {
							checkpoints.push(checkpoint);
							return;
						}
						const page = args.harness.page();
						if (args.recording) {
							await page.screencast.showChapter(checkpoint.title, {
								description: checkpoint.description,
								duration: 900
							});
						}
						const sequence = String(checkpoints.length + 1).padStart(2, "0");
						const relativePath = `chapters/${sequence}-${checkpoint.id}.png`;
						const absolutePath = join(args.harness.artifactRoot, relativePath);
						await mkdir(dirname(absolutePath), { recursive: true });
						await page.screenshot({ fullPage: true, path: absolutePath });
						checkpoints.push({
							...checkpoint,
							attachments: [
								...checkpoint.attachments,
								{ kind: "ui-screenshot", path: relativePath }
							]
						});
					},
					catch: (cause) => flowError("checkpoint", cause)
				})
		}
	};
}
