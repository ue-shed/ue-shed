import { readFile, stat } from "node:fs/promises";
import { Effect, Layer, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";

const request = Command.make(
	"request",
	{
		requestPath: Argument.string("request-json"),
		endpoint: Flag.string("endpoint")
	},
	(args) =>
		observeCliOperation(
			"WorldPreparation",
			Effect.gen(function* () {
				const world = yield* Effect.promise(() => import("@ue-shed/world"));
				const { RemoteControlClientLive } = yield* Effect.promise(
					() => import("@ue-shed/unreal-connection")
				);
				const input = yield* Effect.tryPromise(async () => {
					if ((await stat(args.requestPath)).size > 1024 * 1024)
						throw new Error("World request exceeds 1 MiB.");
					return Schema.decodeUnknownSync(Schema.Json)(
						JSON.parse(await readFile(args.requestPath, "utf8"))
					);
				});
				const decoded = yield* Schema.decodeUnknownEffect(world.WorldRequest)(input, {
					onExcessProperty: "error"
				});
				const result = yield* Effect.gen(function* () {
					return yield* (yield* world.WorldPreparation).execute(decoded);
				}).pipe(
					Effect.provide(
						world
							.worldPreparationLayer(args.endpoint)
							.pipe(Layer.provide(RemoteControlClientLive))
					)
				);
				yield* printJson(result);
			})
		)
).pipe(
	Command.withDescription(
		"Execute a validated world preparation request. Plan is read-only; poll renews; release restores; abandoned leases expire."
	)
);

export const worldCommand = Command.make("world").pipe(Command.withSubcommands([request]));
