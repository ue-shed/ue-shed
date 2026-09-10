import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, Schedule, Schema } from "effect";
import { makeRemoteControlClient } from "../packages/unreal-connection/dist/index.js";
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
	const arrangement = Schema.decodeUnknownSync(Cameras.CameraArrangement)({
		version: 1,
		id: "fixture-arrangement",
		revision: 0,
		projectName: capabilities.projectName,
		mapPath,
		subject: {
			kind: "actor_path",
			actorPath: `${mapPath}.${mapPath.split("/").at(-1)}:PersistentLevel.Floor`
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
