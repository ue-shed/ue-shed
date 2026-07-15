import {
	approveFramingCandidate,
	captureReviewSet,
	configureCameras,
	decodeApproveReviewCandidateIntent,
	generateFramingCandidates,
	getCameraStatus,
	inspectReviewSelection,
	listCaptureRuns,
	loadCaptureRun,
	loadReviewSet,
	openCameraFeedServer,
	previewReviewCandidate,
	saveReviewSet,
	type CameraFeedServer,
	type CameraFrame
} from "@ue-shed/cameras";
import type {
	MapReviewApprovalResult,
	MapReviewAuthoringResult,
	MapReviewCandidatePreviewResult,
	MapReviewResult,
	MapReviewRunView
} from "@ue-shed/extension-camera-review/client";
import {
	readLiveTexturePreview,
	scanTextureAudit,
	type TexturePreviewResult,
	type TextureAuditRunResult,
	type TextureAuditScanError
} from "@ue-shed/asset-audits";
import { discoverAuthoringProjectCatalog } from "@ue-shed/authoring-catalog";
import {
	makeAuthoringSessionService,
	workingTable,
	type AuthoringSessionDocument,
	type AuthoringSessionService
} from "@ue-shed/authoring";
import {
	decodeAuthoringSetCellsIntent,
	type AuthoringSessionResult,
	type AuthoringSessionView
} from "@ue-shed/authoring-sdk";
import { scanTextCorpus, type TextCorpusRunResult } from "@ue-shed/game-text";
import { decodeCompanionCapabilityManifest, type CameraScheduleConfig } from "@ue-shed/protocol";
import { discoverSavedTables, readSavedTable } from "@ue-shed/unreal-assets";
import { connectUnrealAuthoring, type UnrealAuthoringConnection } from "@ue-shed/unreal-connection";
import { Effect } from "effect";
import {
	BrowserWindow,
	app,
	dialog,
	ipcMain,
	type BrowserWindow as BrowserWindowInstance
} from "electron/main";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FixtureLaunchResult, ShowcaseContext } from "./preload.js";

const remoteControlEndpoint =
	process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001";
let feed: CameraFeedServer | undefined;
let window: BrowserWindowInstance | undefined;
const pendingPresentationFrames = new Map<number, CameraFrame>();
let presentationTimer: NodeJS.Timeout | undefined;
let presentationFramesSent = 0;
let presentationReplacements = 0;
let presentationBudgetMbPerSecond = 80;
let nextPresentationAt = 0;
let fixtureLaunch: Promise<FixtureLaunchResult> | undefined;
let fixtureReviewLaunch: Promise<FixtureLaunchResult> | undefined;

function mapReviewConfiguration():
	| { readonly projectRoot: string; readonly reviewSetPath: string }
	| undefined {
	const projectRoot = process.env.UE_SHED_PROJECT_ROOT;
	if (!projectRoot) return undefined;
	return {
		projectRoot,
		reviewSetPath:
			process.env.UE_SHED_REVIEW_SET ??
			join(projectRoot, ".ue-shed", "review", "sets", "fixture-structure.json")
	};
}

function mapReviewFailure(cause: unknown): MapReviewResult {
	const error = cause as { readonly message?: string; readonly recovery?: string };
	return {
		error: {
			message: error.message ?? String(cause),
			recovery:
				error.recovery ??
				"Verify the Review Set, project directory, and local evidence store."
		},
		status: "failed"
	};
}

async function loadMapReview(): Promise<MapReviewResult> {
	const configuration = mapReviewConfiguration();
	if (!configuration) return { status: "not_configured" };
	try {
		const reviewSet = await Effect.runPromise(loadReviewSet(configuration.reviewSetPath));
		const summaries = await Effect.runPromise(listCaptureRuns(configuration.projectRoot));
		const runs = await Promise.all(
			summaries.map(async (summary): Promise<MapReviewRunView> => {
				const run = await Effect.runPromise(loadCaptureRun(summary.path));
				const captured = run.results.find((result) => result.status === "captured");
				const view = captured
					? reviewSet.views.find((candidate) => candidate.id === captured.viewId)
					: undefined;
				return {
					...summary,
					...(captured
						? {
								preview: {
									bytes: new Uint8Array(
										await readFile(
											join(
												dirname(summary.path),
												captured.artifact.relativePath
											)
										)
									),
									height: captured.artifact.height,
									viewName: view?.displayName ?? captured.viewId,
									width: captured.artifact.width
								}
							}
						: {})
				};
			})
		);
		return {
			reviewSet: {
				displayName: reviewSet.displayName,
				mapPath: reviewSet.project.mapPath,
				viewCount: reviewSet.views.length
			},
			runs,
			status: "ready"
		};
	} catch (cause) {
		return mapReviewFailure(cause);
	}
}

async function captureMapReview(): Promise<MapReviewResult> {
	const configuration = mapReviewConfiguration();
	if (!configuration) return { status: "not_configured" };
	try {
		await Effect.runPromise(
			captureReviewSet({
				endpoint: remoteControlEndpoint,
				projectRoot: configuration.projectRoot,
				reviewSetPath: configuration.reviewSetPath
			})
		);
		return await loadMapReview();
	} catch (cause) {
		return mapReviewFailure(cause);
	}
}

function mapReviewAuthoringFailure(
	cause: unknown
): Extract<MapReviewAuthoringResult, { status: "failed" }> {
	const error = cause as { readonly message?: string; readonly recovery?: string };
	return {
		error: {
			message: error.message ?? String(cause),
			recovery:
				error.recovery ??
				"Verify the editor selection and Map Review authoring capability, then retry."
		},
		status: "failed"
	};
}

async function authorMapReviewFromSelection(): Promise<MapReviewAuthoringResult> {
	const configuration = mapReviewConfiguration();
	if (!configuration) {
		return mapReviewAuthoringFailure(new Error("No review project is configured."));
	}
	try {
		const reviewSet = await Effect.runPromise(loadReviewSet(configuration.reviewSetPath));
		const selection = await Effect.runPromise(inspectReviewSelection(remoteControlEndpoint));
		if (selection.status === "failed") {
			return {
				error: { message: selection.message, recovery: selection.recovery },
				status: "failed"
			};
		}
		if (selection.mapPath !== reviewSet.project.mapPath) {
			return mapReviewAuthoringFailure({
				message: `The selected actor belongs to ${selection.mapPath}, not ${reviewSet.project.mapPath}.`,
				recovery: "Open the Review Set map and select exactly one subject actor."
			});
		}
		const view = reviewSet.views[0];
		if (!view) throw new Error("The configured Review Set has no Review View to reframe.");
		const profile = reviewSet.captureProfiles.find(
			(candidate) => candidate.id === view.captureProfileId
		);
		if (!profile) throw new Error(`Review View ${view.id} has no capture profile.`);
		const candidates = generateFramingCandidates(selection);
		const rendered = candidates.map((candidate) => ({
			diagnostics: candidate.diagnostics,
			displayName: candidate.displayName,
			id: candidate.id,
			pose: candidate.approvedPose,
			preset: candidate.recipe.preset,
			preview: { status: "pending" as const }
		}));
		return {
			candidates: rendered,
			selection: {
				actorPath: selection.actorPath,
				displayName: selection.displayName,
				mapPath: selection.mapPath
			},
			status: "ready",
			viewId: view.id
		};
	} catch (cause) {
		return mapReviewAuthoringFailure(cause);
	}
}

async function previewMapReviewCandidate(
	candidateId: unknown
): Promise<MapReviewCandidatePreviewResult> {
	const configuration = mapReviewConfiguration();
	if (!configuration) {
		return mapReviewAuthoringFailure(new Error("No review project is configured."));
	}
	try {
		if (typeof candidateId !== "string") throw new Error("Candidate ID must be a string.");
		const reviewSet = await Effect.runPromise(loadReviewSet(configuration.reviewSetPath));
		const selection = await Effect.runPromise(inspectReviewSelection(remoteControlEndpoint));
		if (selection.status === "failed") {
			return {
				error: { message: selection.message, recovery: selection.recovery },
				status: "failed"
			};
		}
		const candidate = generateFramingCandidates(selection).find(
			(candidate) => candidate.id === candidateId
		);
		if (!candidate) throw new Error(`Candidate ${candidateId} is no longer available.`);
		const view = reviewSet.views[0];
		const profile = view
			? reviewSet.captureProfiles.find((candidate) => candidate.id === view.captureProfileId)
			: undefined;
		if (!profile) throw new Error("The Review View has no capture profile for previews.");
		const preview = await Effect.runPromise(
			previewReviewCandidate({
				candidate,
				endpoint: remoteControlEndpoint,
				mapPath: selection.mapPath,
				profile: { ...profile, resolution: { height: 360, width: 640 } },
				subject: {
					actorPath: selection.actorPath,
					displayName: selection.displayName
				}
			})
		);
		return { ...preview, status: "ready" };
	} catch (cause) {
		return mapReviewAuthoringFailure(cause);
	}
}

async function approveMapReviewCandidate(intent: unknown): Promise<MapReviewApprovalResult> {
	const configuration = mapReviewConfiguration();
	if (!configuration) {
		return { ...mapReviewAuthoringFailure(new Error("No review project is configured.")) };
	}
	try {
		const approvedIntent = decodeApproveReviewCandidateIntent(intent);
		const reviewSet = await Effect.runPromise(loadReviewSet(configuration.reviewSetPath));
		const selection = await Effect.runPromise(inspectReviewSelection(remoteControlEndpoint));
		if (selection.status === "failed") {
			return {
				error: { message: selection.message, recovery: selection.recovery },
				status: "failed"
			};
		}
		if (selection.actorPath !== approvedIntent.sourceActorPath) {
			throw new Error(
				"The selected actor changed after these framing candidates were generated. Reframe the selected actor before keeping a view."
			);
		}
		const candidate = generateFramingCandidates(selection).find(
			(candidate) => candidate.id === approvedIntent.candidateId
		);
		if (!candidate)
			throw new Error(`Candidate ${approvedIntent.candidateId} is no longer available.`);
		if (
			JSON.stringify(candidate.approvedPose) !== JSON.stringify(approvedIntent.candidatePose)
		) {
			throw new Error(
				"The selected actor bounds or framing inputs changed after this preview was generated. Reframe before keeping the view so the saved pose matches what you reviewed."
			);
		}
		const approved = approveFramingCandidate({
			candidate,
			...(approvedIntent.manualPose ? { manualPose: approvedIntent.manualPose } : {}),
			...(approvedIntent.manualReason ? { manualReason: approvedIntent.manualReason } : {}),
			reviewSet,
			subject: {
				actorPath: selection.actorPath,
				diagnosticLabel: selection.displayName,
				kind: "actor_path"
			},
			viewId: approvedIntent.viewId
		});
		if (approved.status === "view_not_found") {
			throw new Error(`Review View ${approved.viewId} was not found.`);
		}
		await Effect.runPromise(
			saveReviewSet({ path: configuration.reviewSetPath, reviewSet: approved.reviewSet })
		);
		return { candidateId: candidate.id, status: "approved" };
	} catch (cause) {
		return mapReviewAuthoringFailure(cause);
	}
}

type AuthoringIpcResult =
	| { readonly status: "ready"; readonly snapshot: unknown }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly error: {
				readonly code: "reader_failure";
				readonly message: string;
				readonly recovery: string;
				readonly retrySafe: boolean;
			};
	  };

type AuthoringIpcFailure = Extract<AuthoringIpcResult, { readonly status: "failed" }>["error"];

type AuthoringCatalogIpcResult =
	| {
			readonly status: "ready";
			readonly tables: readonly {
				readonly completeness: "complete" | "partial";
				readonly kind: "data_table" | "composite_data_table";
				readonly objectPath: string;
				readonly parentTables: readonly string[];
				readonly rowStruct: string;
				readonly authorities: readonly ("saved" | "live")[];
				readonly divergence: readonly string[];
			}[];
			readonly diagnostics: readonly {
				readonly code: string;
				readonly message: string;
				readonly path?: string;
			}[];
	  }
	| { readonly status: "not_configured" }
	| { readonly status: "failed"; readonly error: AuthoringIpcFailure };

const authoringAssetPaths = new Map<string, string>();
const authoringSnapshots = new Map<string, import("@ue-shed/protocol").AuthoringTableSnapshot>();
const authoringLiveObjectPaths = new Set<string>();
let authoringLiveConnection: UnrealAuthoringConnection | undefined;
let authoringSessions: AuthoringSessionService | undefined;

function sessionService(): AuthoringSessionService {
	const projectRoot = process.env.UE_SHED_PROJECT_ROOT;
	if (!projectRoot) throw new Error("UE_SHED_PROJECT_ROOT is not configured");
	return (authoringSessions ??= Effect.runSync(makeAuthoringSessionService({ projectRoot })));
}

function sessionView(document: AuthoringSessionDocument, objectPath: string): AuthoringSessionView {
	const pending = document.pendingOperation;
	const pipeline: AuthoringSessionView["pipeline"] =
		pending.kind === "apply"
			? pending.status === "indeterminate"
				? { id: pending.request.operationId, kind: "indeterminate", operation: "apply" }
				: { kind: "applying", operationId: pending.request.operationId }
			: pending.kind === "save"
				? pending.status === "indeterminate"
					? { id: pending.request.requestId, kind: "indeterminate", operation: "save" }
					: { kind: "saving", requestId: pending.request.requestId }
				: document.draft.awaitingSave.length > 0
					? { kind: "applied", objectPaths: document.draft.awaitingSave }
					: document.draft.saveReceipts.length > 0
						? { kind: "saved" }
						: { canApply: document.draft.undoPointer > 0, kind: "draft" };
	return {
		canRedo: document.draft.undoPointer < document.draft.commands.length,
		canUndo: document.draft.undoPointer > 0,
		commandCount: document.draft.commands.length,
		dirty: document.draft.undoPointer > 0,
		lifecycle: document.lifecycle,
		pipeline,
		sessionId: document.draft.id,
		snapshot: workingTable(document.draft, objectPath),
		updatedAt: document.updatedAt
	};
}

function sessionFailure(cause: unknown): AuthoringSessionResult {
	const error = cause as {
		readonly _tag?: string;
		readonly message?: string;
		readonly recovery?: string;
	};
	return {
		error: {
			code: error._tag ?? "authoring_session_failure",
			message: error.message ?? String(cause),
			recovery: error.recovery ?? "Retry the operation or create a new draft session.",
			retrySafe: error._tag === "AuthoringSessionStorageError"
		},
		status: "failed"
	};
}

async function beginAuthoringSession(objectPath: string): Promise<AuthoringSessionResult> {
	try {
		const service = sessionService();
		const listed = await Effect.runPromise(service.list());
		const existing = listed.sessions.find((candidate) =>
			candidate.tableObjectPaths.includes(objectPath)
		);
		const document = existing
			? await Effect.runPromise(
					existing.lifecycle === "closed"
						? service.resume(existing.id)
						: service.open(existing.id)
				)
			: await Effect.runPromise(
					service.create([
						authoringSnapshots.get(objectPath) ??
							(() => {
								throw new Error(`No loaded snapshot exists for ${objectPath}`);
							})()
					])
				);
		return { status: "ready", view: sessionView(document, objectPath) };
	} catch (cause) {
		return sessionFailure(cause);
	}
}

async function loadAuthoringTable(assetPath: string): Promise<AuthoringIpcResult> {
	try {
		const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
		const snapshot = await Effect.runPromise(
			readSavedTable({ assetPath, ...(executable ? { executable } : {}) })
		);
		authoringSnapshots.set(snapshot.table.objectPath, snapshot);
		return { status: "ready", snapshot };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			status: "failed",
			error: {
				code: "reader_failure",
				message: `Could not read the saved DataTable: ${message}`,
				recovery:
					"Choose a DataTable .uasset from a supported Unreal project and verify the saved-asset reader is available.",
				retrySafe: true
			}
		};
	}
}

async function loadLiveAuthoringTable(objectPath: string): Promise<AuthoringIpcResult> {
	try {
		if (!authoringLiveConnection)
			throw new Error("The live authoring connection is unavailable");
		const snapshot = await Effect.runPromise(
			authoringLiveConnection.getTableSnapshot(objectPath)
		);
		authoringSnapshots.set(objectPath, snapshot);
		return { status: "ready", snapshot };
	} catch (cause) {
		return {
			error: {
				code: "reader_failure",
				message: `Could not read the live DataTable: ${cause instanceof Error ? cause.message : String(cause)}`,
				recovery: "Verify Unreal is connected, then refresh the project catalog.",
				retrySafe: true
			},
			status: "failed"
		};
	}
}

async function loadAuthoringCatalog(projectRoot: string): Promise<AuthoringCatalogIpcResult> {
	try {
		const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
		const savedCatalog = await Effect.runPromise(
			discoverSavedTables({
				projectRoot,
				...(executable ? { executable } : {})
			})
		);
		authoringAssetPaths.clear();
		for (const table of savedCatalog.tables) {
			authoringAssetPaths.set(table.objectPath, table.assetPath);
		}
		const liveConnection = await Effect.runPromise(
			connectUnrealAuthoring(remoteControlEndpoint).pipe(Effect.either)
		);
		authoringLiveConnection =
			liveConnection._tag === "Right" ? liveConnection.right : undefined;
		const catalog = await Effect.runPromise(
			discoverAuthoringProjectCatalog({
				...(authoringLiveConnection ? { live: authoringLiveConnection } : {}),
				savedCatalog
			})
		);
		authoringLiveObjectPaths.clear();
		for (const table of catalog.tables) {
			if (table.authorities.some(({ authority }) => authority === "live")) {
				authoringLiveObjectPaths.add(table.objectPath);
			}
		}
		return {
			diagnostics: [
				...(liveConnection._tag === "Left"
					? [
							{
								code: "live_connection_unavailable",
								message: liveConnection.left.message
							}
						]
					: []),
				...catalog.diagnostics.map(({ code, message, path }) => ({
					code,
					message,
					...(path ? { path } : {})
				}))
			],
			status: "ready",
			tables: catalog.tables.map(
				({ authorities, divergence, kind, objectPath, parentTables, rowStruct }) => ({
					authorities: authorities.map(({ authority }) => authority),
					completeness:
						(
							authorities.find(({ authority }) => authority === "live") ??
							authorities[0]
						)?.completeness ?? "partial",
					divergence: divergence.status === "detected" ? divergence.fields : [],
					kind,
					objectPath,
					parentTables,
					rowStruct
				})
			)
		};
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			error: {
				code: "reader_failure",
				message: `Could not discover saved DataTables: ${message}`,
				recovery: "Verify the configured Unreal project and saved-asset reader.",
				retrySafe: true
			},
			status: "failed"
		};
	}
}

function unavailablePreview(
	objectPath: string,
	message: string,
	reason: "invalid_request" | "not_connected" = "not_connected"
): TexturePreviewResult {
	return {
		contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
		status: "unavailable",
		objectPath,
		reason,
		message,
		retrySafe: reason === "not_connected"
	};
}

async function remoteControlAvailable(requiredCapability?: "map-review"): Promise<boolean> {
	try {
		const response = await fetch(new URL("/remote/object/call", remoteControlEndpoint), {
			body: JSON.stringify({
				generateTransaction: false,
				functionName: "GetCapabilityManifest",
				objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
				parameters: {}
			}),
			headers: { "content-type": "application/json" },
			method: "PUT",
			signal: AbortSignal.timeout(1_500)
		});
		if (!response.ok) return false;
		const envelope: unknown = await response.json();
		if (
			typeof envelope !== "object" ||
			envelope === null ||
			!("ResultJson" in envelope) ||
			typeof envelope.ResultJson !== "string"
		) {
			return false;
		}
		const manifest = decodeCompanionCapabilityManifest(JSON.parse(envelope.ResultJson));
		const expectedProject = process.env.UE_SHED_PROJECT_NAME;
		const matchesFixture =
			manifest.producerKind === "unreal_editor" &&
			(!expectedProject || manifest.projectName === expectedProject);
		if (!matchesFixture || requiredCapability !== "map-review") return matchesFixture;

		const reviewResponse = await fetch(new URL("/remote/object/call", remoteControlEndpoint), {
			body: JSON.stringify({
				generateTransaction: false,
				functionName: "CaptureReviewView",
				objectPath: "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary",
				parameters: { RequestJson: "{}" }
			}),
			headers: { "content-type": "application/json" },
			method: "PUT",
			signal: AbortSignal.timeout(1_500)
		});
		return reviewResponse.ok;
	} catch {
		return false;
	}
}

async function launchConfiguredFixture(
	action: "launch" | "launch-authoring" = "launch"
): Promise<FixtureLaunchResult> {
	const requiredCapability = action === "launch-authoring" ? "map-review" : undefined;
	if (await remoteControlAvailable(requiredCapability)) return { status: "ready" };
	if (requiredCapability && (await remoteControlAvailable())) {
		return {
			status: "failed",
			message: "The configured endpoint is running Unreal without Map Review capture.",
			recovery:
				"Close the -game fixture or choose another endpoint, then launch the editor fixture."
		};
	}
	const repositoryRoot = process.env.UE_SHED_REPOSITORY_ROOT;
	const launchScript = repositoryRoot
		? join(repositoryRoot, "scripts", "unreal-fixture.mjs")
		: undefined;
	if (!launchScript || !existsSync(launchScript)) {
		return {
			status: "failed",
			message: "This Workbench session has no source-checkout fixture launcher.",
			recovery: "Start Workbench with pnpm showcase from the UE Shed repository."
		};
	}

	const launched = await new Promise<FixtureLaunchResult>((resolveLaunch) => {
		const child = spawn(process.execPath, [launchScript, action], {
			cwd: repositoryRoot,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true
		});
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-16_384);
		});
		child.once("error", (cause) =>
			resolveLaunch({
				status: "failed",
				message: `Could not start the fixture launcher: ${String(cause)}`,
				recovery: "Verify the configured Unreal installation and source checkout."
			})
		);
		child.once("exit", (code) => {
			if (code === 0) resolveLaunch({ status: "ready" });
			else {
				resolveLaunch({
					status: "failed",
					message:
						stderr.trim() || `Fixture launcher exited with code ${code ?? "unknown"}.`,
					recovery: "Check the Unreal build output and Saved/Logs/UEShedFixture.log."
				});
			}
		});
	});
	if (launched.status === "failed") return launched;

	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (await remoteControlAvailable(requiredCapability)) return { status: "ready" };
		await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
	}
	return {
		status: "failed",
		message: "Unreal launched, but Remote Control did not become ready within three minutes.",
		recovery: "Check the Unreal process and Saved/Logs/UEShedFixture.log."
	};
}

ipcMain.handle("fixture:launch", async (): Promise<FixtureLaunchResult> => {
	fixtureLaunch ??= launchConfiguredFixture().finally(() => {
		fixtureLaunch = undefined;
	});
	return fixtureLaunch;
});

ipcMain.handle("fixture:launch-review", async (): Promise<FixtureLaunchResult> => {
	fixtureReviewLaunch ??= launchConfiguredFixture("launch-authoring").finally(() => {
		fixtureReviewLaunch = undefined;
	});
	return fixtureReviewLaunch;
});

ipcMain.handle("showcase:context", (): ShowcaseContext => {
	const projectRoot = process.env.UE_SHED_PROJECT_ROOT;
	const ruleFile = process.env.UE_SHED_TEXTURE_AUDIT_RULES;
	const readerExecutable = process.env.UE_SHED_UASSET_EXECUTABLE;
	return {
		fixtureConfigured: Boolean(
			projectRoot && ruleFile && existsSync(projectRoot) && existsSync(ruleFile)
		),
		...(projectRoot ? { projectRoot } : {}),
		reader: readerExecutable ? "configured" : "path",
		...(ruleFile ? { ruleFile } : {})
	};
});

function schedulePresentationFrame() {
	if (presentationTimer || pendingPresentationFrames.size === 0) return;
	const delay = Math.max(0, nextPresentationAt - performance.now());
	presentationTimer = setTimeout(flushPresentationFrame, delay);
}

function flushPresentationFrame() {
	presentationTimer = undefined;
	const frame = pendingPresentationFrames.values().next().value;
	if (!frame) return;
	pendingPresentationFrames.delete(frame.cameraIndex);
	window?.webContents.send("camera:frame", {
		...frame,
		pixels: frame.pixels,
		sequence: frame.sequence.toString()
	});
	presentationFramesSent += 1;
	const now = performance.now();
	nextPresentationAt =
		Math.max(now, nextPresentationAt) +
		(frame.pixels.byteLength / (presentationBudgetMbPerSecond * 1_000_000)) * 1_000;
	schedulePresentationFrame();
}

async function createWindow() {
	feed = await Effect.runPromise(openCameraFeedServer());
	window = new BrowserWindow({
		backgroundColor: "#0b0d0d",
		height: 940,
		minHeight: 720,
		minWidth: 1120,
		show: false,
		title: "UE Shed Workbench",
		webPreferences: {
			contextIsolation: true,
			preload: join(import.meta.dirname, "preload.cjs"),
			sandbox: true
		},
		width: 1540
	});
	feed.subscribe((frame) => {
		if (pendingPresentationFrames.has(frame.cameraIndex)) presentationReplacements += 1;
		pendingPresentationFrames.set(frame.cameraIndex, frame);
		schedulePresentationFrame();
	});
	window.once("ready-to-show", () => window?.show());
	await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

async function runTextureScan(
	projectRoot: string,
	ruleFile: string
): Promise<TextureAuditRunResult> {
	try {
		const report = await Effect.runPromise(scanTextureAudit({ projectRoot, ruleFile }));
		return { status: "completed", report };
	} catch (cause) {
		const error = cause as Partial<TextureAuditScanError>;
		return {
			status: "failed",
			error: {
				code: error.code ?? "scan_failed",
				message: error.message ?? "Texture audit failed.",
				recovery: error.recovery ?? "Check the project, rule file, and saved-asset reader.",
				retrySafe: error.retrySafe ?? true
			}
		};
	}
}

async function runGameTextScan(projectRoot: string): Promise<TextCorpusRunResult> {
	try {
		const readerExecutable = process.env.UE_SHED_UASSET_EXECUTABLE;
		const corpus = await Effect.runPromise(
			scanTextCorpus({
				projectRoot,
				...(readerExecutable ? { readerExecutable } : {})
			})
		);
		return { status: "completed", corpus };
	} catch (cause) {
		const error = cause as {
			code?: "invalid_project" | "scan_limit_exceeded";
			message?: string;
			recovery?: string;
			retrySafe?: boolean;
		};
		return {
			status: "failed",
			error: {
				code: error.code ?? "invalid_project",
				message: error.message ?? "Game text scan failed.",
				recovery:
					error.recovery ??
					"Choose a readable Unreal project and verify the saved-asset reader.",
				retrySafe: error.retrySafe ?? true
			}
		};
	}
}

ipcMain.handle("game-text:configured-scan", async (): Promise<TextCorpusRunResult> => {
	const projectRoot = process.env.UE_SHED_PROJECT_ROOT;
	return projectRoot ? runGameTextScan(projectRoot) : { status: "not_configured" };
});

ipcMain.handle("game-text:choose-and-scan", async (): Promise<TextCorpusRunResult> => {
	const choice = await dialog.showOpenDialog(window!, {
		properties: ["openDirectory"],
		title: "Choose an Unreal project for Game Text"
	});
	const projectRoot = choice.filePaths[0];
	return choice.canceled || !projectRoot ? { status: "cancelled" } : runGameTextScan(projectRoot);
});

ipcMain.handle(
	"asset-audits:textures:configured-scan",
	async (): Promise<TextureAuditRunResult> => {
		const projectRoot = process.env.UE_SHED_PROJECT_ROOT;
		const ruleFile = process.env.UE_SHED_TEXTURE_AUDIT_RULES;
		if (!projectRoot || !ruleFile) return { status: "not_configured" };
		return runTextureScan(projectRoot, ruleFile);
	}
);

ipcMain.handle(
	"asset-audits:textures:preview",
	async (_event, objectPath: unknown): Promise<TexturePreviewResult> => {
		if (
			typeof objectPath !== "string" ||
			objectPath.length === 0 ||
			objectPath.length > 1_024 ||
			!objectPath.startsWith("/Game/")
		) {
			return unavailablePreview(
				"",
				"Texture preview requires a valid /Game object path.",
				"invalid_request"
			);
		}
		try {
			return await Effect.runPromise(
				readLiveTexturePreview({ endpoint: remoteControlEndpoint, objectPath })
			);
		} catch (cause) {
			return unavailablePreview(
				objectPath,
				`Live Unreal preview unavailable: ${String(cause)}`
			);
		}
	}
);

ipcMain.handle(
	"asset-audits:textures:choose-and-scan",
	async (): Promise<TextureAuditRunResult> => {
		const projectChoice = await dialog.showOpenDialog(window!, {
			properties: ["openDirectory"],
			title: "Choose an Unreal project"
		});
		const projectRoot = projectChoice.filePaths[0];
		if (projectChoice.canceled || !projectRoot) return { status: "cancelled" };
		let ruleFile = process.env.UE_SHED_TEXTURE_AUDIT_RULES;
		if (!ruleFile) {
			const ruleChoice = await dialog.showOpenDialog(window!, {
				filters: [{ name: "JSON rule set", extensions: ["json"] }],
				properties: ["openFile"],
				title: "Choose texture audit rules"
			});
			ruleFile = ruleChoice.filePaths[0];
			if (ruleChoice.canceled || !ruleFile) return { status: "cancelled" };
		}
		return runTextureScan(projectRoot, ruleFile);
	}
);

ipcMain.handle("authoring:configured-table", async (): Promise<AuthoringIpcResult> => {
	const assetPath = process.env.UE_SHED_AUTHORING_ASSET;
	return assetPath ? loadAuthoringTable(assetPath) : { status: "not_configured" };
});

ipcMain.handle("authoring:configured-catalog", async (): Promise<AuthoringCatalogIpcResult> => {
	const projectRoot = process.env.UE_SHED_PROJECT_ROOT;
	return projectRoot ? loadAuthoringCatalog(projectRoot) : { status: "not_configured" };
});

ipcMain.handle(
	"authoring:open-catalog-table",
	async (_event, objectPath: unknown): Promise<AuthoringIpcResult> => {
		if (
			typeof objectPath !== "string" ||
			objectPath.length === 0 ||
			objectPath.length > 1_024 ||
			!objectPath.startsWith("/Game/")
		) {
			return {
				status: "failed",
				error: {
					code: "reader_failure",
					message: "Catalog selection is not a valid /Game DataTable object path.",
					recovery: "Refresh the configured project catalog and choose a listed table.",
					retrySafe: false
				}
			};
		}
		let assetPath = authoringAssetPaths.get(objectPath);
		if (!assetPath && !authoringLiveObjectPaths.has(objectPath)) {
			const projectRoot = process.env.UE_SHED_PROJECT_ROOT;
			if (projectRoot) await loadAuthoringCatalog(projectRoot);
			assetPath = authoringAssetPaths.get(objectPath);
		}
		if (authoringLiveObjectPaths.has(objectPath)) return loadLiveAuthoringTable(objectPath);
		return assetPath
			? loadAuthoringTable(assetPath)
			: {
					status: "failed",
					error: {
						code: "reader_failure",
						message: `The configured project no longer contains ${objectPath}.`,
						recovery: "Refresh the catalog or choose another saved DataTable.",
						retrySafe: true
					}
				};
	}
);

ipcMain.handle("authoring:choose-table", async (): Promise<AuthoringIpcResult> => {
	const choice = await dialog.showOpenDialog(window!, {
		filters: [{ name: "Unreal saved assets", extensions: ["uasset"] }],
		properties: ["openFile"],
		title: "Open a saved Unreal DataTable"
	});
	const assetPath = choice.filePaths[0];
	return choice.canceled || !assetPath ? { status: "cancelled" } : loadAuthoringTable(assetPath);
});

ipcMain.handle(
	"authoring:session:begin",
	async (_event, objectPath: unknown): Promise<AuthoringSessionResult> =>
		typeof objectPath === "string"
			? beginAuthoringSession(objectPath)
			: sessionFailure("Session begin requires a table object path")
);

ipcMain.handle(
	"authoring:session:edit",
	async (_event, input: unknown): Promise<AuthoringSessionResult> => {
		try {
			const intent = decodeAuthoringSetCellsIntent(input);
			const document = await Effect.runPromise(
				sessionService().setCells({
					edits: intent.edits,
					sessionId: intent.sessionId,
					tableObjectPath: intent.tableObjectPath
				})
			);
			return { status: "ready", view: sessionView(document, intent.tableObjectPath) };
		} catch (cause) {
			return sessionFailure(cause);
		}
	}
);

async function moveAuthoringHistory(
	sessionId: unknown,
	direction: "undo" | "redo"
): Promise<AuthoringSessionResult> {
	try {
		if (typeof sessionId !== "string") throw new Error(`${direction} requires a session id`);
		const service = sessionService();
		const document = await Effect.runPromise(
			direction === "undo" ? service.undo(sessionId) : service.redo(sessionId)
		);
		const objectPath = Object.keys(document.draft.base)[0];
		if (!objectPath) throw new Error(`Session ${sessionId} has no table`);
		return { status: "ready", view: sessionView(document, objectPath) };
	} catch (cause) {
		return sessionFailure(cause);
	}
}

ipcMain.handle("authoring:session:undo", (_event, sessionId: unknown) =>
	moveAuthoringHistory(sessionId, "undo")
);
ipcMain.handle("authoring:session:redo", (_event, sessionId: unknown) =>
	moveAuthoringHistory(sessionId, "redo")
);

async function liveAuthoringConnection(): Promise<UnrealAuthoringConnection> {
	return (authoringLiveConnection ??= await Effect.runPromise(
		connectUnrealAuthoring(remoteControlEndpoint)
	));
}

function documentView(document: AuthoringSessionDocument): AuthoringSessionResult {
	const objectPath = Object.keys(document.draft.base)[0];
	if (!objectPath) return sessionFailure(`Session ${document.draft.id} has no table`);
	return { status: "ready", view: sessionView(document, objectPath) };
}

ipcMain.handle("authoring:session:apply", async (_event, sessionId: unknown) => {
	if (typeof sessionId !== "string") return sessionFailure("Apply requires a session id");
	const service = sessionService();
	try {
		const connection = await liveAuthoringConnection();
		const limits = connection.manifest.authoringLimits;
		if (!limits) throw new Error("The editor did not negotiate authoring mutation limits");
		const prepared = await Effect.runPromise(service.prepareApply(sessionId, limits));
		if (prepared.pendingOperation.kind !== "apply") throw new Error("Apply was not prepared");
		try {
			const result = await Effect.runPromise(
				connection.apply(prepared.pendingOperation.request)
			);
			return documentView(await Effect.runPromise(service.completeApply(sessionId, result)));
		} catch (cause) {
			await Effect.runPromise(service.markApplyIndeterminate(sessionId, String(cause)));
			throw cause;
		}
	} catch (cause) {
		return sessionFailure(cause);
	}
});

ipcMain.handle("authoring:session:reconcile", async (_event, sessionId: unknown) => {
	if (typeof sessionId !== "string") return sessionFailure("Reconcile requires a session id");
	try {
		const service = sessionService();
		const document = await Effect.runPromise(service.open(sessionId));
		if (document.pendingOperation.kind !== "apply") {
			throw new Error("Session has no unresolved Apply operation");
		}
		const result = await Effect.runPromise(
			(await liveAuthoringConnection()).lookupApplyResult(
				document.pendingOperation.request.operationId
			)
		);
		return documentView(await Effect.runPromise(service.completeApply(sessionId, result)));
	} catch (cause) {
		return sessionFailure(cause);
	}
});

ipcMain.handle("authoring:session:save", async (_event, sessionId: unknown) => {
	if (typeof sessionId !== "string") return sessionFailure("Save requires a session id");
	const service = sessionService();
	try {
		const existing = await Effect.runPromise(service.open(sessionId));
		const prepared =
			existing.pendingOperation.kind === "save" &&
			existing.pendingOperation.status === "indeterminate"
				? existing
				: await Effect.runPromise(service.prepareSave(sessionId));
		if (prepared.pendingOperation.kind !== "save") throw new Error("Save was not prepared");
		try {
			const result = await Effect.runPromise(
				(await liveAuthoringConnection()).save(prepared.pendingOperation.request)
			);
			return documentView(await Effect.runPromise(service.completeSave(sessionId, result)));
		} catch (cause) {
			await Effect.runPromise(service.markSaveIndeterminate(sessionId, String(cause)));
			throw cause;
		}
	} catch (cause) {
		return sessionFailure(cause);
	}
});

ipcMain.handle("camera:metrics", () => {
	const metrics = feed?.getMetrics();
	if (!metrics) return undefined;
	const processMetrics = app.getAppMetrics();
	const electronPrivateMemoryMb =
		processMetrics.reduce(
			(sum, metric) => sum + (metric.memory.privateBytes ?? metric.memory.workingSetSize),
			0
		) / 1024;
	const gpuProcessPrivateMemoryMb =
		(() => {
			const memory = processMetrics.find((metric) => metric.type === "GPU")?.memory;
			return memory ? (memory.privateBytes ?? memory.workingSetSize) : 0;
		})() / 1024;
	return {
		...metrics,
		electronPrivateMemoryMb,
		gpuProcessPrivateMemoryMb,
		presentationBudgetMbPerSecond,
		presentationFramesSent,
		presentationReplacements
	};
});
ipcMain.handle("camera:presentation-budget", (_event, value: unknown) => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError("Presentation budget must be a finite number");
	}
	presentationBudgetMbPerSecond = Math.min(500, Math.max(25, value));
	return presentationBudgetMbPerSecond;
});
ipcMain.handle("camera:status", () => getCameraStatus(remoteControlEndpoint));
ipcMain.handle("camera:configure", (_event, config: CameraScheduleConfig) =>
	configureCameras(remoteControlEndpoint, config)
);
ipcMain.handle("map-review:load", () => loadMapReview());
ipcMain.handle("map-review:capture", () => captureMapReview());
ipcMain.handle("map-review:author-from-selection", () => authorMapReviewFromSelection());
ipcMain.handle("map-review:preview-candidate", (_event, candidateId: unknown) =>
	previewMapReviewCandidate(candidateId)
);
ipcMain.handle("map-review:approve-candidate", (_event, intent: unknown) =>
	approveMapReviewCandidate(intent)
);

app.whenReady()
	.then(createWindow)
	.catch((error) => {
		console.error(error);
		app.quit();
	});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
	void feed?.close();
});
