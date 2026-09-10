import { readFile, stat, writeFile } from "node:fs/promises";
import { Effect, Ref, Schedule, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";

const readInput = Effect.fn("Cli.camera_authoring.read")(function* (path: string) {
	return yield* Effect.tryPromise(async () => {
		if ((await stat(path)).size > 4 * 1024 * 1024)
			throw new Error("Authoring input exceeds 4 MiB.");
		return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8")));
	});
});
const draft = { draftPath: Argument.string("draft-json") };
const create = Command.make(
	"create",
	{ ...draft, inputPath: Argument.string("input-json") },
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
const show = Command.make("show", draft, (args) =>
	observeCliOperation(
		"CameraAuthoringShow",
		Effect.gen(function* () {
			const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
			yield* printJson(yield* cameras.makeCameraAuthoringStore(args.draftPath).load());
		})
	)
);
const patch = Command.make(
	"patch",
	{ ...draft, inputPath: Argument.string("command-json") },
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
	{ ...draft, inputPath: Argument.string("approval-json") },
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
	{ inputPath: Argument.string("request-json"), endpoint: Flag.string("endpoint") },
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
		cameraId: Argument.string("camera-id"),
		endpoint: Flag.string("endpoint"),
		output: Flag.string("output")
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
					const attachment = yield* cameras.attachArrangementCamera(
						store,
						port,
						cameras.ArrangementCameraId.make(args.cameraId)
					);
					const latest = yield* Ref.make(attachment);
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
									Effect.catch(() => Ref.get(latest))
								);
							// Preserve the last native state before releasing the ephemeral proxy, including unresolved edits.
							yield* Effect.tryPromise(() =>
								writeFile(
									`${args.draftPath}.native-recovery.json`,
									`${JSON.stringify(snapshot, null, "\t")}\n`
								)
							).pipe(
								Effect.catch((error) =>
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
								.pipe(Effect.catch(() => Effect.void));
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
						const result = yield* cameras
							.synchronizeArrangementCamera({
								store,
								bridge: port,
								attachment,
								approvalDestination: args.output
							})
							.pipe(
								Effect.tap((snapshot) => Ref.set(latest, snapshot)),
								Effect.catch((error) =>
									Effect.succeed({ status: "blocked", error })
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

export const cameraArrangementCommand = Command.make("arrangement").pipe(
	Command.withDescription(
		"Author an actor-scoped camera arrangement through public headless services."
	),
	Command.withSubcommands([create, show, patch, approve, bridge, attach])
);
