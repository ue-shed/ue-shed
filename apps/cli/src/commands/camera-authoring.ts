import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { Cause, Effect, Ref, Schedule, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";

const readInput = Effect.fn("Cli.camera_authoring.read")(
	(path: string) =>
		Effect.tryPromise(async () => {
			if ((await stat(path)).size > 4 * 1024 * 1024)
				throw new Error("Authoring input exceeds 4 MiB.");
			return JSON.parse(await readFile(path, "utf8"));
		}),
	Effect.flatMap((input) =>
		Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
			Effect.mapError((cause) => new Cause.UnknownError(cause))
		)
	)
);
const draft = { draftPath: Argument.String("draft-json") };
const create = Command.make(
	"create",
	{ ...draft, inputPath: Argument.String("input-json") },
	(args) =>
		observeCliOperation(
			"CameraAuthoringCreate",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const input = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						arrangement: cameras.CameraArrangement,
						reviewSet: Schema.Json
					})
				)(yield* readInput(args.inputPath), { onExcessProperty: "error" });
				const reviewSet = yield* cameras.decodeReviewSet(input.reviewSet);
				yield* printJson(
					yield* cameras
						.makeCameraAuthoringStore(args.draftPath)
						.create(input.arrangement, reviewSet)
				);
			})
		)
);
const fromSelection = Command.make(
	"from-selection",
	{ ...draft, endpoint: Flag.String("endpoint") },
	(args) =>
		observeCliOperation(
			"CameraAuthoringFromSelection",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const connection = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				yield* Effect.gen(function* () {
					const client = yield* connection.RemoteControlClient;
					const selection = yield* cameras.inspectReviewSelection(args.endpoint);
					if (selection.status !== "selected")
						return yield* new cameras.CameraBridgeError({
							code: "unavailable",
							message: selection.message,
							recovery: selection.recovery,
							nextStep: "fix_input",
							retrySafe: true
						});
					const capabilities = yield* cameras.makeCameraRenderer(client, args.endpoint)
						.capabilities;
					const input = cameras.createCameraArrangementFromSelection({
						id: cameras.CameraArrangementId.make(randomUUID()),
						projectName: capabilities.projectName,
						selection
					});
					yield* printJson(
						yield* cameras
							.makeCameraAuthoringStore(args.draftPath)
							.create(input.arrangement, input.reviewSet)
					);
				}).pipe(Effect.provide(connection.RemoteControlClientLive));
			})
		)
).pipe(
	Command.withDescription(
		"Create a single fitted camera for the selected Unreal actor. Attach camera-1 to tune its arrangement."
	)
);
const show = Command.make("show", draft, (args) =>
	observeCliOperation(
		"CameraAuthoringShow",
		Effect.gen(function* () {
			const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
			yield* printJson(yield* cameras.makeCameraAuthoringStore(args.draftPath).load);
		})
	)
);
const patch = Command.make(
	"patch",
	{ ...draft, inputPath: Argument.String("command-json") },
	(args) =>
		observeCliOperation(
			"CameraAuthoringPatch",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const input = yield* Schema.decodeUnknownEffect(cameras.CameraArrangementCommand)(
					yield* readInput(args.inputPath),
					{ onExcessProperty: "error" }
				);
				yield* printJson(
					yield* cameras.makeCameraAuthoringStore(args.draftPath).mutate(input)
				);
			})
		)
);
const approve = Command.make(
	"approve",
	{ ...draft, inputPath: Argument.String("approval-json") },
	(args) =>
		observeCliOperation(
			"CameraAuthoringApprove",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const input = yield* Schema.decodeUnknownEffect(cameras.CameraApproval)(
					yield* readInput(args.inputPath),
					{ onExcessProperty: "error" }
				);
				yield* printJson(
					yield* cameras.makeCameraAuthoringStore(args.draftPath).approve(input)
				);
			})
		)
);
const bridge = Command.make(
	"bridge",
	{ inputPath: Argument.String("request-json"), endpoint: Flag.String("endpoint") },
	(args) =>
		observeCliOperation(
			"CameraAuthoringBridge",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const connection = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const input = yield* Schema.decodeUnknownEffect(cameras.CameraBridgeRequest)(
					yield* readInput(args.inputPath),
					{ onExcessProperty: "error" }
				);
				const program = Effect.gen(function* () {
					const client = yield* connection.RemoteControlClient;
					yield* printJson(
						yield* cameras.makeCameraAuthoringBridge(client, args.endpoint).call(input)
					);
				});
				yield* program.pipe(Effect.provide(connection.RemoteControlClientLive));
			})
		)
);
const attach = Command.make(
	"attach",
	{
		...draft,
		cameraId: Argument.String("camera-id"),
		endpoint: Flag.String("endpoint"),
		output: Flag.String("output")
	},
	(args) =>
		observeCliOperation(
			"CameraAuthoringAttach",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const connection = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const program = Effect.gen(function* () {
					const client = yield* connection.RemoteControlClient;
					const port = cameras.makeCameraAuthoringBridge(client, args.endpoint),
						store = cameras.makeCameraAuthoringStore(args.draftPath);
					const capability = yield* port.call({ version: 1, operation: "discover" });
					if (capability.status !== "available" || !capability.arrangementPanel)
						return yield* new cameras.CameraBridgeError({
							code: "unavailable",
							message:
								"The installed authoring bridge lacks arrangement panel support.",
							recovery:
								"Install a matching CameraAuthoringBridge plugin before attaching this arrangement.",
							retrySafe: true,
							nextStep: "fix_input"
						});
					const attachment = yield* cameras.attachArrangementCamera(
						store,
						port,
						cameras.ArrangementCameraId.make(args.cameraId)
					);
					const latest = yield* Ref.make(attachment);
					const panel = yield* cameras.makeCameraAuthoringPanelSession({
						store,
						bridge: port,
						attachment,
						draftPath: args.draftPath,
						approvalPath: args.output
					});
					yield* Effect.addFinalizer(() =>
						Effect.gen(function* () {
							const snapshot = yield* port
								.call({
									version: 1,
									operation: "inspect",
									sessionId: attachment.sessionId,
									producerId: attachment.producerId
								})
								.pipe(
									Effect.flatMap(cameras.readyCameraBridge),
									Effect.catchTag("CameraBridgeError", () => Ref.get(latest))
								);
							// Preserve the last native state before releasing the ephemeral proxy, including unresolved edits.
							yield* Effect.tryPromise(() =>
								writeFile(
									`${args.draftPath}.native-recovery.json`,
									`${JSON.stringify(snapshot, null, "\t")}\n`
								)
							).pipe(
								Effect.catchTag("UnknownError", (error) =>
									Effect.logError(
										"Could not preserve native camera recovery",
										error
									)
								)
							);
							yield* port
								.call({
									version: 1,
									operation: "detach",
									sessionId: attachment.sessionId,
									producerId: attachment.producerId
								})
								.pipe(Effect.catchTag("CameraBridgeError", () => Effect.void));
						})
					);
					yield* printJson(
						yield* port.call({
							version: 1,
							operation: "select",
							sessionId: attachment.sessionId,
							producerId: attachment.producerId
						})
					);
					const previousOutput = yield* Ref.make("");
					yield* Effect.gen(function* () {
						const result = yield* panel.tick().pipe(
							Effect.tap((snapshot) => Ref.set(latest, snapshot)),
							Effect.catchTag(
								["CameraArrangementError", "CameraBridgeError"],
								(error) => Effect.succeed({ status: "blocked", error })
							)
						);
						const text = JSON.stringify(result);
						if (text !== (yield* Ref.get(previousOutput))) {
							yield* printJson(result);
							yield* Ref.set(previousOutput, text);
						}
					}).pipe(Effect.repeat(Schedule.spaced("200 millis")));
				});
				yield* program.pipe(
					Effect.scoped,
					Effect.provide(connection.RemoteControlClientLive)
				);
			})
		)
).pipe(
	Command.withDescription(
		"Select a camera in Unreal and synchronize until interrupted. Native Save writes --output; exit preserves a native recovery snapshot."
	)
);

const recovery = Command.make(
	"recovery",
	{
		...draft,
		inputPath: Argument.String("proposal-or-snapshot-json"),
		endpoint: Flag.String("endpoint"),
		choice: Flag.Literals("choice", ["inspect", "saved", "native"]).pipe(
			Flag.withDefault("inspect")
		)
	},
	(args) =>
		observeCliOperation(
			"CameraAuthoringRecovery",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const connection = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const input = yield* readInput(args.inputPath);
				yield* Effect.gen(function* () {
					const client = yield* connection.RemoteControlClient;
					const port = cameras.makeCameraAuthoringBridge(client, args.endpoint);
					const store = cameras.makeCameraAuthoringStore(args.draftPath);
					if (args.choice === "inspect") {
						const snapshot = yield* Schema.decodeUnknownEffect(
							cameras.CameraBridgeSnapshot
						)(input);
						yield* printJson(
							yield* cameras.inspectCameraRecovery(store, port, snapshot)
						);
					} else {
						const proposal = yield* Schema.decodeUnknownEffect(
							cameras.CameraRecoveryProposal
						)(input);
						yield* printJson(
							yield* cameras.resolveCameraRecovery(store, port, proposal, args.choice)
						);
					}
				}).pipe(Effect.provide(connection.RemoteControlClientLive));
			})
		)
).pipe(
	Command.withDescription(
		"Inspect saved and pending native edits, then resolve the exact reviewed proposal with --choice saved or native."
	)
);

const recoveryFile = Command.make(
	"recovery-file",
	{
		...draft,
		inputPath: Argument.String("proposal-or-snapshot-json"),
		choice: Flag.Literals("choice", ["inspect", "saved", "native"]).pipe(
			Flag.withDefault("inspect")
		)
	},
	(args) =>
		observeCliOperation(
			"CameraAuthoringRecoveryFile",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const store = cameras.makeCameraAuthoringStore(args.draftPath);
				const input = yield* readInput(args.inputPath);
				if (args.choice === "inspect") {
					const snapshot = yield* Schema.decodeUnknownEffect(
						cameras.CameraBridgeSnapshot
					)(input);
					yield* printJson(yield* cameras.prepareCameraRecovery(store, snapshot));
				} else {
					const proposal = yield* Schema.decodeUnknownEffect(
						cameras.CameraRecoveryProposal
					)(input);
					yield* printJson(
						yield* cameras.restoreCameraRecovery(store, proposal, args.choice)
					);
				}
			})
		)
).pipe(
	Command.withDescription(
		"Review a preserved native snapshot, then explicitly restore its edits to a draft while detached."
	)
);

export const cameraArrangementCommand = Command.make("arrangement").pipe(
	Command.withDescription(
		"Author an actor-scoped camera arrangement through public headless services."
	),
	Command.withSubcommands([
		create,
		fromSelection,
		show,
		patch,
		approve,
		bridge,
		attach,
		recovery,
		recoveryFile
	])
);
