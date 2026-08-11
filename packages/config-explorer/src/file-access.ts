import { access, readdir, readFile, stat } from "node:fs/promises";
import { Context, Effect, Layer, Schema } from "effect";

export class ConfigFileAccessError extends Schema.TaggedErrorClass<ConfigFileAccessError>()(
	"ConfigFileAccessError",
	{
		operation: Schema.Literals(["read", "list", "stat"]),
		message: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ConfigDirectoryEntry {
	readonly name: string;
	readonly kind: "file" | "directory" | "other";
}

export interface ConfigFileAccessShape {
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly isFile: (path: string) => Effect.Effect<boolean, ConfigFileAccessError>;
	readonly list: (
		path: string
	) => Effect.Effect<readonly ConfigDirectoryEntry[], ConfigFileAccessError>;
	readonly readText: (path: string) => Effect.Effect<string, ConfigFileAccessError>;
}

export class ConfigFileAccess extends Context.Service<ConfigFileAccess, ConfigFileAccessShape>()(
	"@ue-shed/config-explorer/ConfigFileAccess"
) {}

function fileError(
	operation: ConfigFileAccessError["operation"],
	message: string,
	retrySafe = true
): ConfigFileAccessError {
	return new ConfigFileAccessError({ operation, message, retrySafe });
}

export const ConfigFileAccessLive = Layer.succeed(
	ConfigFileAccess,
	ConfigFileAccess.of({
		exists: Effect.fn("ConfigFileAccess.exists")((path: string) =>
			Effect.tryPromise({ try: () => access(path), catch: () => undefined }).pipe(
				Effect.match({ onFailure: () => false, onSuccess: () => true })
			)
		),
		isFile: Effect.fn("ConfigFileAccess.isFile")((path: string) =>
			Effect.tryPromise({
				try: () => stat(path).then((value) => value.isFile()),
				catch: () => fileError("stat", "The selected project path could not be inspected.")
			})
		),
		list: Effect.fn("ConfigFileAccess.list")((path: string) =>
			Effect.tryPromise({
				try: () =>
					readdir(path, { withFileTypes: true }).then((entries) =>
						entries.map((entry) => ({
							name: entry.name,
							kind: entry.isFile()
								? ("file" as const)
								: entry.isDirectory()
									? ("directory" as const)
									: ("other" as const)
						}))
					),
				catch: () => fileError("list", "A required config directory could not be listed.")
			})
		),
		readText: Effect.fn("ConfigFileAccess.readText")((path: string) =>
			Effect.tryPromise({
				try: (signal) => readFile(path, { encoding: "utf8", signal }),
				catch: () => fileError("read", "A selected config file could not be read.")
			})
		)
	})
);

export function makeConfigFileAccessTestLayer(
	service: ConfigFileAccessShape
): Layer.Layer<ConfigFileAccess> {
	return Layer.succeed(ConfigFileAccess, ConfigFileAccess.of(service));
}
