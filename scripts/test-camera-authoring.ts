import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, Schedule, Schema } from "effect";
import {
	makeRemoteControlClient,
	RemoteControlClient
} from "../packages/unreal-connection/dist/index.js";
import * as Cameras from "../packages/cameras/dist/index.js";
import {
	prepareUnrealPlugins,
	unrealEngineTools,
	unrealEngineVersion
} from "./unreal-plugin-host.ts";
import { unrealRemoteControlLaunchArguments } from "./workbench-tools.ts";

const engineRoot = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
const output = process.argv[2];
if (!engineRoot || !output)
	throw new Error("Set UE_SHED_UNREAL_ENGINE_ROOT and supply a new evidence directory.");
const root = resolve(output);
mkdirSync(root, { recursive: false });
const version = unrealEngineVersion(engineRoot);
if (!version) throw new Error("Engine version unavailable.");
const tools = unrealEngineTools(engineRoot),
	project = join(root, "CameraAuthoringFixture.uproject");
writeFileSync(project, JSON.stringify({ FileVersion: 3, EngineAssociation: version.label }));
mkdirSync(join(root, "Content"));
copyFileSync(
	join(engineRoot, "Engine", "Content", "Maps", "Templates", "Template_Default.umap"),
	join(root, "Content", "Fixture.umap")
);
const descriptors = prepareUnrealPlugins({ engineRoot, projectPath: project, tools });
const port = await new Promise<number>((resolvePort, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || Schema.is(Schema.String)(address)) {
			server.close();
			reject(new Error("No test port"));
			return;
		}
		server.close(() => resolvePort(address.port));
	});
});
const endpoint = `http://127.0.0.1:${port}`;
const client = makeRemoteControlClient({ defaultTimeout: "3 seconds" });
const bridge = Cameras.makeCameraAuthoringBridge(client, endpoint);
const renderer = Cameras.makeCameraRenderer(client, endpoint);
let editor: ChildProcess | undefined;
async function stop() {
	const running = editor;
	editor = undefined;
	if (running && running.exitCode === null)
		await new Promise<void>((done) => {
			running.once("exit", () => done());
			running.kill();
		});
}
async function launch(ids: readonly string[], label: string) {
	editor = spawn(
		tools.editorCommandlet,
		[
			project,
			"/Game/Fixture",
			...descriptors
				.filter((path) => ids.includes(basename(dirname(path))))
				.map((path) => `-PLUGIN=${path}`),
			...unrealRemoteControlLaunchArguments(ids, port),
			// Fixture setup only; production launch never grants this editor subsystem access.
			...(["SelectAll", "SetSelectedLevelActors"] as const).map(
				(name) =>
					`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:+CustomAllowedRemoteFunctionCalls=(ClassPath=/Script/UnrealEd.EditorActorSubsystem,FunctionName=${name},bAllowChildClasses=False)`
			),
			`-abslog=${join(root, `${label}.log`)}`,
			"-unattended",
			"-nop4",
			"-nosplash",
			"-RenderOffscreen",
			"-NoSound",
			"-ResX=640",
			"-ResY=480"
		],
		{ windowsHide: true, stdio: "ignore" }
	);
	await Effect.runPromise(
		renderer
			.capabilities()
			.pipe(
				Effect.retry(
					Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "120 seconds" }))
				)
			)
	);
}
try {
	await launch(
		["UEShedCore", "UEShedCameras", "UEShedCameraAuthoringBridge"],
		"authoring-editor"
	);
	const capabilities = await Effect.runPromise(renderer.capabilities());
	const readiness = await Effect.runPromise(
		client.request({
			endpoint,
			objectPath: "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary",
			functionName: "InspectMapCaptureReadiness",
			parameters: { ExpectedMapPath: "/Game/Fixture" }
		})
	);
	const { actualMapPath: mapPath } = Schema.decodeUnknownSync(
		Schema.Struct({ actualMapPath: Schema.String })
	)(readiness);
	// Select a real fixture actor instead of assuming an editor label is its object path.
	await Effect.runPromise(
		client
			.request({
				endpoint,
				objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
				functionName: "SelectAll",
				parameters: { InWorld: `${mapPath}.Fixture` }
			})
			.pipe(
				Effect.catch((error) =>
					error.message.startsWith(
						"Invalid Remote Control envelope: SchemaError(Missing key"
					)
						? Effect.void
						: Effect.fail(error)
				)
			)
	);
	const selectedMap = await Effect.runPromise(
		Cameras.inspectMapCaptureSelection(endpoint).pipe(
			Effect.provideService(RemoteControlClient, client)
		)
	);
	assert.equal(selectedMap.status, "ready");
	const subjectPath =
		selectedMap.actors.find((actor) => actor.label === "Floor")?.path ??
		selectedMap.actors[0]!.path;
	const arrangement = Schema.decodeUnknownSync(Cameras.CameraArrangement)({
		version: 1,
		id: "fixture-arrangement",
		revision: 0,
		projectName: capabilities.projectName,
		mapPath,
		subject: {
			kind: "actor_path",
			actorPath: subjectPath
		},
		bounds: {
			center: { x: 0, y: 0, z: 0 },
			extent: { x: 100, y: 100, z: 100 },
			rotation: { pitch: 0, yaw: 0, roll: 0 }
		},
		settings: { fieldOfViewDegrees: 60, distanceScale: 1, heightOffset: 100, margin: 0.1 },
		cameras: [
			{
				id: "camera-a",
				viewId: "view-a",
				displayName: "Fixture camera",
				yawDegrees: 45,
				overrides: {}
			}
		],
		retiredCameraIds: [],
		captureProfileId: "hd",
		visibilityPolicyId: "default-natural-only"
	});
	const set = await Effect.runPromise(
		Cameras.decodeReviewSet({
			contract: { name: "ue-shed-review-set", version: { major: 1, minor: 2 } },
			id: Cameras.ReviewSetId.make("fixture"),
			displayName: "Camera fixture",
			project: { id: "fixture", mapPath },
			captureProfiles: [
				{
					id: Cameras.CaptureProfileId.make("hd"),
					imageFormat: "png",
					renderProfile: "full_fidelity",
					resolution: { width: 1280, height: 720 },
					variantPolicy: "pure_only"
				}
			],
			visibilityPolicies: [Cameras.defaultNaturalOnlyVisibilityPolicy()],
			views: []
		})
	);
	const draftPath = join(root, "draft.json"),
		destination = join(root, "approved.json");
	const store = Cameras.makeCameraAuthoringStore(draftPath);
	await Effect.runPromise(store.create(arrangement, set));
	const attachment = await Effect.runPromise(
		Cameras.attachArrangementCamera(store, bridge, Cameras.ArrangementCameraId.make("camera-a"))
	);
	const scope = {
		version: 1 as const,
		sessionId: attachment.sessionId,
		producerId: attachment.producerId
	};
	await Effect.runPromise(
		bridge
			.call({ ...scope, operation: "pilot" })
			.pipe(Effect.flatMap(Cameras.readyCameraBridge))
	);
	const edited = await Effect.runPromise(
		bridge
			.call({
				...scope,
				operation: "edit",
				expectedRevision: attachment.revision,
				sequence: attachment.sequence,
				pose: {
					...attachment.pose,
					location: { x: 950, y: -750, z: 650 },
					rotation: { pitch: -25, yaw: 140, roll: 0 },
					fieldOfViewDegrees: 40
				}
			})
			.pipe(Effect.flatMap(Cameras.readyCameraBridge))
	);
	assert.equal(edited.pending, true);
	await Effect.runPromise(bridge.call({ ...scope, operation: "save" }));
	const synced = await Effect.runPromise(
		Cameras.synchronizeArrangementCamera({
			store,
			bridge,
			attachment,
			approvalDestination: destination
		})
	);
	assert.equal(synced.pending, false);
	const panel = await Effect.runPromise(
		Cameras.makeCameraAuthoringPanelSession({
			store,
			bridge,
			attachment: synced,
			draftPath,
			approvalPath: destination
		})
	);
	await Effect.runPromise(panel.tick());
	const action = async (event: Cameras.CameraPanelAction) => {
		const queued = await Effect.runPromise(
			bridge
				.call({ ...scope, operation: "enqueue", action: event })
				.pipe(Effect.flatMap(Cameras.readyCameraBridge))
		);
		assert.ok(queued.panelEvent);
		const result = await Effect.runPromise(panel.tick());
		assert.equal(result.panelEvent, undefined);
		return result;
	};
	await action({
		kind: "layout",
		layout: { kind: "arc", count: 3, startDegrees: 0, spanDegrees: 160, orientation: "world" },
		retainExisting: true
	});
	assert.equal((await Effect.runPromise(store.load())).arrangement.cameras.length, 1);
	await action({ kind: "accept_proposal" });
	const command = async (fields: Schema.JsonObject) => {
		const doc = await Effect.runPromise(store.load());
		return action({
			kind: "command",
			command: Schema.decodeUnknownSync(Cameras.CameraArrangementCommand)({
				arrangementId: doc.arrangement.id,
				expectedRevision: doc.arrangement.revision,
				operationId: `journey-${doc.arrangement.revision}`,
				...fields
			})
		});
	};
	await command({
		kind: "batch",
		scope: { kind: "arrangement" },
		settings: { fieldOfViewDegrees: 50, distanceScale: 1.4, heightOffset: 160 },
		resetFields: []
	});
	const editedDraft = await Effect.runPromise(store.load());
	assert.deepEqual(
		Cameras.resolveArrangementCamera(editedDraft.arrangement, "camera-a"),
		edited.pose
	);
	await action({ kind: "activate", cameraId: editedDraft.arrangement.cameras[1]!.id });
	await action({ kind: "activate", cameraId: Cameras.ArrangementCameraId.make("camera-a") });
	await action({
		kind: "export_recipe",
		path: join(root, "recipe.json"),
		name: "Studio starting arc"
	});
	await Effect.runPromise(
		client
			.request({
				endpoint,
				objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
				functionName: "SetSelectedLevelActors",
				parameters: {
					ActorsToSelect: [
						arrangement.subject.kind === "actor_path"
							? arrangement.subject.actorPath
							: ""
					]
				}
			})
			.pipe(
				Effect.catch((error) => {
					// Unreal's built-in selection setter returns void, unlike UE Shed's ResultJson calls.
					// The following bridge selection assertion confirms the actual editor-side effect.
					return error.message.startsWith(
						"Invalid Remote Control envelope: SchemaError(Missing key"
					)
						? Effect.void
						: Effect.fail(error);
				})
			)
	);
	assert.ok(arrangement.subject.kind === "actor_path");
	const selection = await Effect.runPromise(bridge.call({ ...scope, operation: "selection" }));
	assert.equal(selection.status, "selection");
	if (selection.status === "selection") {
		assert.equal(selection.actors.length, 1);
		await command({
			kind: "edit_visibility",
			scope: { kind: "arrangement" },
			list: "hide",
			operation: "add",
			entries: selection.actors
		});
		const resolution = await Effect.runPromise(
			bridge.call({
				...scope,
				operation: "resolve_visibility",
				actors: {
					hide: selection.actors,
					protect: [{ label: "Subject path alias", locator: arrangement.subject }]
				}
			})
		);
		assert.equal(resolution.status, "visibility");
		if (resolution.status === "visibility") assert.equal(resolution.valid, true);
	}
	await command({ kind: "output", output: "natural_and_authored" });
	await command({
		kind: "render_policy",
		policy: {
			...Cameras.legacyReviewRenderPolicy,
			exposure: { mode: "fixed_ev100", ev100: 10, compensation: "project" }
		}
	});
	await action({
		kind: "approve",
		cameraIds: editedDraft.arrangement.cameras.map((camera) => camera.id),
		removeRetiredViewIds: []
	});
	const saved = await Effect.runPromise(Cameras.makeCameraAuthoringStore(draftPath).load());
	const view = saved.reviewSet.views[0];
	assert.ok(view && view.viewpoint.kind === "world_fixed");
	assert.deepEqual(view.viewpoint.approvedPose, edited.pose);
	await Effect.runPromise(bridge.call({ ...scope, operation: "detach" }));
	await stop();
	// Restart the editor without either authoring plugin; the saved pose remains capture-only input.
	await launch(["UEShedCore", "UEShedCameras"], "capture-only-editor");
	const absent = await Effect.runPromise(
		bridge.call({ version: 1, operation: "discover" }).pipe(Effect.flip)
	);
	assert.equal(absent.code, "missing_plugin");
	const persisted = await Effect.runPromise(
		Cameras.decodeReviewSet(JSON.parse(await readFile(destination, "utf8")))
	);
	assert.deepEqual(persisted, saved.reviewSet);
	assert.ok(view.authoredVisibility);
	const profile = persisted.captureProfiles.find((entry) => entry.id === view.captureProfileId)!;
	const authoredCapture = await Effect.runPromise(
		Cameras.captureReviewView({
			endpoint,
			request: Schema.decodeUnknownSync(Cameras.ReviewCaptureRequestCurrent)({
				contract: { name: "ue-shed-review-capture", version: { major: 1, minor: 7 } },
				operationId: randomUUID(),
				viewId: view.id,
				expectedMapPath: mapPath,
				viewpoint: view.viewpoint,
				subject: arrangement.subject,
				resolution: { width: 640, height: 360 },
				assessment: { method: "automatic" },
				clearCompanion: { status: "not_requested" },
				renderPolicy: profile.renderPolicy,
				authoredVisibility: view.authoredVisibility
			})
		}).pipe(Effect.provideService(RemoteControlClient, client))
	);
	assert.equal(authoredCapture.status, "captured");
	if (authoredCapture.status === "captured" && "stagedArtifacts" in authoredCapture)
		assert.deepEqual(
			authoredCapture.stagedArtifacts.map((entry) => entry.variant),
			["pure", "authored"]
		);
	await writeFile(
		join(root, "authored-capture.json"),
		JSON.stringify(authoredCapture, null, "\t")
	);
	const pose = view.viewpoint.approvedPose;
	const sessionId = Cameras.CameraRenderSessionId.make("approved-camera");
	const frame = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const session = yield* renderer.open({
					contract: Cameras.cameraRenderContract,
					sessionId,
					expectedProjectName: capabilities.projectName,
					expectedMapPath: mapPath,
					leaseMs: 120000,
					maximumFrames: 1,
					policy: Cameras.legacyReviewRenderPolicy
				});
				return yield* session.capture({
					contract: Cameras.cameraRenderContract,
					sessionId,
					operationId: Cameras.CameraFrameOperationId.make("approved"),
					size: { width: 640, height: 360 },
					camera: {
						location: pose.location,
						rotation: pose.rotation,
						projection: {
							kind: "perspective",
							horizontalFieldOfView: pose.fieldOfViewDegrees
						}
					}
				});
			})
		)
	);
	assert.deepEqual(frame.evidence.camera.location, pose.location);
	assert.deepEqual(frame.evidence.camera.rotation, pose.rotation);
	assert.deepEqual(frame.evidence.camera.projection, {
		kind: "perspective",
		horizontalFieldOfView: 40
	});
	assert.equal(
		frame.evidence.editorState.mapPackageDirtyAfter,
		frame.evidence.editorState.mapPackageDirtyBefore
	);
	const artifact = await Effect.runPromise(
		Cameras.readCameraFrameArtifact({ projectRoot: root, frame })
	);
	await writeFile(join(root, "approved-camera.png"), artifact.bytes);
	await writeFile(
		join(root, "evidence.json"),
		JSON.stringify(
			{
				status: "passed",
				endpoint,
				edited,
				synced,
				frame,
				captureOnlyRestart: true,
				authoringCapabilityAbsent: true
			},
			null,
			"\t"
		)
	);
	console.log(`Camera authoring round trip passed: ${root}`);
} finally {
	await stop();
}
