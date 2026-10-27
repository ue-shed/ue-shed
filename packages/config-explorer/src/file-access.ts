import { ErrorGuidanceFields as ConfigErrorGuidanceFields } from "@ue-shed/protocol/errors";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { Context, Effect, Layer, Schema } from "effect";

export class ConfigFileAccessError extends Schema.TaggedError<ConfigFileAccessError>()(
	"ConfigFileAccessError",
	{
		operation: Schema.Literals(["read", "list", "stat"]),
		...ConfigErrorGuidanceFields,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

export interface ConfigDirectoryEntry {
	readonly name: string;
	readonly kind: "file" | "directory" | "other";
}

export interface ConfigFileAccessApi {
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly isFile: (path: string) => Effect.Effect<boolean, ConfigFileAccessError>;
	readonly list: (
		path: string
	) => Effect.Effect<readonly ConfigDirectoryEntry[], ConfigFileAccessError>;
	readonly readText: (path: string) => Effect.Effect<string, ConfigFileAccessError>;
}

export class ConfigFileAccess extends Context.Service<ConfigFileAccess, ConfigFileAccessApi>()(
	"@ue-shed/config-explorer/ConfigFileAccess"
) {}

/** Filesystem reads are repeatable; a transient lock or share violation may clear. */
function fileError(
	operation: ConfigFileAccessError["operation"],
	message: string,
	cause?: unknown
): ConfigFileAccessError {
	return new ConfigFileAccessError({
		...(cause === undefined ? undefined : { cause }),
		operation,
		message,
		recovery: "Check that the path exists and is readable, then read it again.",
		retrySafe: true,
		nextStep: "retry"
	});
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
				catch: (cause) =>
					fileError("stat", "The selected project path could not be inspected.", cause)
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
				catch: (cause) =>
					fileError("list", "A required config directory could not be listed.", cause)
			})
		),
		readText: Effect.fn("ConfigFileAccess.readText")((path: string) =>
			Effect.tryPromise({
				try: (signal) => readFile(path, { encoding: "utf8", signal }),
				catch: (cause) =>
					fileError("read", "A selected config file could not be read.", cause)
			})
		)
	})
);

export function makeConfigFileAccessTestLayer(
	service: ConfigFileAccessApi
): Layer.Layer<ConfigFileAccess> {
	return Layer.succeed(ConfigFileAccess, ConfigFileAccess.of(service));
}

export { ErrorGuidanceFields as ConfigErrorGuidanceFields } from "@ue-shed/protocol/errors";
