import { readFile, stat } from "node:fs/promises";
import { Effect, Layer, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

/** Decoder for a schema from a lazily imported module, built once per command run. */
// Schemas arrive through this command's lazy import, so they can't be compiled at module scope.
const decodeLazySchema = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(schema);

const request = Command.make(
	"request",
	{
		requestPath: Argument.String("request-json"),
		endpoint: Flag.String("endpoint")
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
					return decodeJson(JSON.parse(await readFile(args.requestPath, "utf8")));
				});
				const decoded = yield* decodeLazySchema(world.WorldRequest)(input, {
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
