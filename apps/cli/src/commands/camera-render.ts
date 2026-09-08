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
						frame: cameras.CameraFrameRequest
					})
				)(input, { onExcessProperty: "error" });
				const frame = yield* cameras
					.renderCamera(request)
					.pipe(
						Effect.provide(
							cameras
								.cameraRendererLayer(args.endpoint)
								.pipe(Layer.provide(RemoteControlClientLive))
						)
					);
				const artifact = yield* cameras.readCameraFrameArtifact({
					projectRoot: args.projectRoot,
					frame
				});
				const output = resolve(args.output);
				yield* Effect.tryPromise(() => writeFile(output, artifact.bytes, { flag: "wx" }));
				yield* printJson({ output, contentHash: artifact.contentHash, frame });
			})
		)
).pipe(
	Command.withDescription(
		"Render an absolute editor-world camera from a validated {session, frame} request; restore editor state before writing a new PNG."
	)
);

export const cameraCommand = Command.make("camera").pipe(Command.withSubcommands([render]));
