import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";

const render = Command.make(
	"render",
	{
		requestPath: Argument.string("request-json"),
		endpoint: Flag.string("endpoint"),
		projectRoot: Flag.string("project"),
		output: Flag.string("output")
	},
	(args) =>
		observeCliOperation(
			"CameraRender",
			Effect.gen(function* () {
				const cameras = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const world = yield* Effect.promise(() => import("@ue-shed/world"));
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const input = yield* Effect.tryPromise(async () => {
					if ((await stat(args.requestPath)).size > 131072)
						throw new Error("Camera render request exceeds 128 KiB.");
					return Schema.decodeUnknownSync(Schema.Json)(
						JSON.parse(await readFile(args.requestPath, "utf8"))
					);
				});
				const request = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						session: cameras.CameraRenderSessionRequest,
						frame: cameras.CameraFrameRequest,
						preparation: Schema.optionalKey(world.WorldRequirements)
					})
				)(input, { onExcessProperty: "error" });
				const live = Layer.merge(
					cameras.cameraRendererLayer(args.endpoint),
					world.worldPreparationLayer(args.endpoint)
				).pipe(Layer.provide(RemoteControlClientLive));
				const rendered =
					request.preparation === undefined
						? yield* cameras.renderCamera(request).pipe(
								Effect.map((frame) => ({
									frame,
									preparation: null,
									afterCapture: null
								})),
								Effect.provide(live)
							)
						: yield* cameras
								.renderPreparedCamera({
									...request,
									preparation: request.preparation
								})
								.pipe(Effect.provide(live));
				const frame = rendered.frame;
				const artifact = yield* cameras.readCameraFrameArtifact({
					projectRoot: args.projectRoot,
					frame
				});
				const output = resolve(args.output);
				yield* Effect.tryPromise(() => writeFile(output, artifact.bytes, { flag: "wx" }));
				yield* printJson({
					output,
					contentHash: artifact.contentHash,
					frame,
					...(rendered.preparation === null
						? undefined
						: {
								worldPreparation: {
									before: rendered.preparation,
									after: rendered.afterCapture
								}
							})
				});
			})
		)
).pipe(
	Command.withDescription(
		"Render an editor-world camera from {session, frame, preparation?}; optional preparation loads actor context or explicit areas and restores ownership before writing a new PNG."
	)
);

export const cameraCommand = Command.make("camera").pipe(Command.withSubcommands([render]));
