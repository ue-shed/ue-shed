import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Effect, Schedule, Schema, Semaphore } from "effect";
import {
	FramingCandidateId,
	ensureProvisionedCameras,
	clearProvisionedCameras,
	CameraArrangement,
	CameraArrangementId,
	CameraOperationId,
	ReviewAuthoring,
	ReviewRepository,
	attachArrangementCamera,
	createCameraArrangementFromSelection,
	makeCameraAuthoringBridge,
	makeCameraAuthoringPanelSession,
	makeCameraAuthoringStore,
	readyCameraBridge,
	type CameraBridgeSnapshot
} from "@ue-shed/cameras";
import {
	CameraWorkspaceRequest,
	type CameraWorkspaceResult
} from "@ue-shed/cameras/review-contracts";
import { RemoteControlClient } from "@ue-shed/unreal-connection";

export class CameraWorkspaceError extends Schema.TaggedErrorClass<CameraWorkspaceError>()(
	"CameraWorkspaceError",
	{ message: Schema.String }
) {}
const failure = (cause: unknown) =>
	new CameraWorkspaceError({ message: cause instanceof Error ? cause.message : String(cause) });

/** Workbench composition of public camera ports. No independent synchronization protocol. */
export const makeCameraWorkspace = Effect.fn("Workbench.CameraWorkspace.make")(function* () {
	const authoring = yield* ReviewAuthoring;
	const repository = yield* ReviewRepository;
	const client = yield* RemoteControlClient;
	const gate = yield* Semaphore.make(1);
	type Panel = Effect.Success<ReturnType<typeof makeCameraAuthoringPanelSession>>;
	let active:
		| {
				owner: string;
				endpoint: string;
				previewKey?: string;
				bridge: ReturnType<typeof makeCameraAuthoringBridge>;
				snapshot: CameraBridgeSnapshot;
				panel: Panel;
				store: ReturnType<typeof makeCameraAuthoringStore>;
		  }
		| undefined;
	let error: string | null = null;
	let savedSets: CameraWorkspaceResult["sets"] = [];
	const close = Effect.fn("Workbench.CameraWorkspace.close")(function* () {
		if (!active) return;
		const current = active;
		const detached = yield* current.bridge.call({
			version: 1,
			operation: "detach",
			sessionId: current.snapshot.sessionId,
			producerId: current.snapshot.producerId
		});
		if (detached.status !== "detached" && detached.status !== "unavailable")
			return yield* Effect.fail(failure(detached.message));
		active = undefined;
		yield* clearProvisionedCameras(current.endpoint).pipe(
			Effect.provideService(RemoteControlClient, client)
		);
		active = undefined;
	});
	const tick = Effect.fn("Workbench.CameraWorkspace.tick")(function* () {
		if (active) active.snapshot = yield* active.panel.tick();
		if (active?.snapshot.panel) {
			const panel = active.snapshot.panel;
			const camera = panel.cameras.find((item) => item.id === panel.activeCameraId)!;
			const key = JSON.stringify(camera);
			if (active.previewKey !== key) {
				yield* ensureProvisionedCameras(
					active.endpoint,
					[
						{
							correlation: {
								type: "framing_candidate",
								candidateId: FramingCandidateId.make(camera.id)
							},
							width: 960,
							height: 540,
							location: camera.pose.location,
							rotation: camera.pose.rotation,
							projection: {
								type: "perspective",
								fieldOfViewDegrees: camera.pose.fieldOfViewDegrees
							},
							visibility: camera.visibility
						}
					],
					{ expectedMapPath: panel.arrangement.mapPath, previewFps: 5 }
				).pipe(Effect.provideService(RemoteControlClient, client));
				active.previewKey = key;
			}
		}
		error = null;
	});
	yield* tick().pipe(
		Effect.catch((cause) =>
			Effect.sync(() => {
				error = cause.message;
			})
		),
		gate.withPermits(1),
		Effect.repeat(Schedule.spaced("250 millis")),
		Effect.forkScoped
	);
	yield* Effect.addFinalizer(() =>
		close().pipe(
			Effect.catch((cause) => Effect.logWarning("Camera workspace detach failed", cause))
		)
	);
	const request = Effect.fn("Workbench.CameraWorkspace.request")(
		function* (
			context: { projectRoot: string; reviewSetPath: string; endpoint: string },
			input: CameraWorkspaceRequest
		) {
			const intent = yield* Schema.decodeUnknownEffect(CameraWorkspaceRequest)(input);
			const owner = JSON.stringify(context);
			if (active && active.owner !== owner) yield* close();
			const set = yield* repository.loadSet(context.reviewSetPath);
			const root = join(
				context.projectRoot,
				".ue-shed",
				"camera-sets",
				createHash("sha256").update(set.id).digest("hex").slice(0, 20)
			);
			if (intent.kind === "close") yield* close();
			if (intent.kind === "open") {
				const id = intent.id ?? CameraArrangementId.make(randomUUID());
				const path = join(root, `${id}.json`);
				const store = makeCameraAuthoringStore(path);
				if (!intent.id) {
					const inspected = intent.actorPath
						? yield* authoring.inspectSubject({
								endpoint: context.endpoint,
								subject: { kind: "actor_path", actorPath: intent.actorPath }
							})
						: yield* authoring.inspectSelection(context.endpoint);
					if (inspected.status !== "selected")
						return yield* Effect.fail(failure("Select an actor in Unreal first."));
					if (inspected.mapPath !== set.project.mapPath)
						return yield* Effect.fail(
							failure("Open a Review Set for the selected actor's map.")
						);
					const projects = yield* Effect.tryPromise({
						try: () => readdir(context.projectRoot),
						catch: failure
					});
					const projectFile = projects.find((name) => name.endsWith(".uproject"));
					if (!projectFile)
						return yield* Effect.fail(failure("No Unreal project found."));
					const created = createCameraArrangementFromSelection({
						id,
						projectName: basename(projectFile, ".uproject"),
						selection: { ...inspected, status: "selected" }
					});
					const profile = set.captureProfiles[0];
					const visibility = set.visibilityPolicies[0];
					if (!profile || !visibility)
						return yield* Effect.fail(
							failure("The Review Set needs a capture profile and visibility policy.")
						);
					yield* store.create(
						CameraArrangement.make({
							...created.arrangement,
							displayName: intent.name ?? inspected.displayName,
							captureProfileId: profile.id,
							visibilityPolicyId: visibility.id,
							output: "authored_only"
						}),
						set
					);
				}
				const doc = yield* store.load();
				if (doc.reviewSet.id !== set.id || doc.arrangement.mapPath !== set.project.mapPath)
					return yield* Effect.fail(
						failure("This camera set belongs to another Review Set.")
					);
				yield* close();
				const bridge = makeCameraAuthoringBridge(client, context.endpoint);
				const snapshot = yield* attachArrangementCamera(
					store,
					bridge,
					doc.arrangement.cameras[0]!.id
				);
				const panel = yield* makeCameraAuthoringPanelSession({
					store,
					bridge,
					attachment: snapshot,
					draftPath: path,
					approvalPath: context.reviewSetPath
				});
				active = { owner, endpoint: context.endpoint, bridge, snapshot, panel, store };
			}
			if (intent.kind === "action" || intent.kind === "native") {
				if (!active || active.snapshot.sessionId !== intent.id)
					return yield* Effect.fail(failure("Load this camera set before editing it."));
				yield* tick();
				const current = active;
				const scope = {
					version: 1 as const,
					sessionId: current.snapshot.sessionId,
					producerId: current.snapshot.producerId
				};
				if (intent.kind === "action") {
					if (intent.expectedRevision !== current.snapshot.revision)
						return yield* Effect.fail(
							failure("The set changed. Review the updated values and retry.")
						);
					if (
						[
							"import_recipe",
							"export_recipe",
							"import_visibility",
							"export_visibility"
						].includes(intent.action.kind)
					)
						return yield* Effect.fail(
							failure("File operations require a host-selected path.")
						);
					yield* current.bridge
						.call({ ...scope, operation: "enqueue", action: intent.action })
						.pipe(Effect.flatMap(readyCameraBridge));
				} else if (
					intent.operation === "hide_selection" ||
					intent.operation === "protect_selection"
				) {
					const selected = yield* current.bridge.call({
						...scope,
						operation: "selection"
					});
					if (selected.status !== "selection" || !selected.actors.length)
						return yield* Effect.fail(failure("Select actors in Unreal first."));
					yield* current.bridge
						.call({
							...scope,
							operation: "enqueue",
							action: {
								kind: "command",
								command: {
									kind: "edit_visibility",
									arrangementId: current.snapshot.sessionId,
									operationId: CameraOperationId.make(randomUUID()),
									expectedRevision: current.snapshot.revision,
									scope: intent.scope,
									list:
										intent.operation === "hide_selection" ? "hide" : "protect",
									operation: "add",
									entries: selected.actors
								}
							}
						})
						.pipe(Effect.flatMap(readyCameraBridge));
				} else
					yield* current.bridge
						.call({ ...scope, operation: intent.operation })
						.pipe(Effect.flatMap(readyCameraBridge));
			}
			if (active) yield* tick();
			const document = active ? yield* active.store.load() : undefined;
			const savedViews =
				document?.reviewSet.views
					.filter((view) => view.authoring?.arrangementId === document.arrangement.id)
					.map((view) => ({ id: view.id, revision: view.revision.number })) ?? [];
			if (intent.kind === "state")
				return {
					panel: active?.snapshot.panel ?? null,
					sets: savedSets,
					savedViews,
					error
				};
			const names = yield* Effect.tryPromise({
				try: async () => {
					try {
						return await readdir(root);
					} catch (cause) {
						if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
							return [];
						throw cause;
					}
				},
				catch: failure
			});
			const sets = yield* Effect.forEach(
				names.filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(name)),
				(name) =>
					Effect.gen(function* () {
						const { arrangement: a } = yield* makeCameraAuthoringStore(
							join(root, name)
						).load();
						return {
							id: a.id,
							name: a.displayName ?? "Camera set",
							actorPath:
								a.subject.kind === "actor_path"
									? a.subject.actorPath
									: (a.subject.lastKnownActorPath ?? ""),
							cameras: a.cameras.length
						};
					})
			);
			savedSets = sets;
			return {
				panel: active?.snapshot.panel ?? null,
				sets,
				savedViews,
				error
			} satisfies CameraWorkspaceResult;
		},
		gate.withPermits(1),
		Effect.catch((cause) =>
			Effect.succeed({
				panel: active?.snapshot.panel ?? null,
				sets: savedSets,
				error: failure(cause).message
			})
		)
	);
	return { request, close: () => close().pipe(gate.withPermits(1)) };
});
