import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Context, Effect, Layer, Schema } from "effect";

export class LocalFilesError extends Schema.TaggedErrorClass<LocalFilesError>()(
	"Workbench.LocalFilesError",
	{
		causeText: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["exists", "readFile"]),
		path: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface LocalFilesShape {
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly readFile: (
		path: string,
		options?: { readonly maxBytes?: number }
	) => Effect.Effect<Uint8Array, LocalFilesError>;
}

export class LocalFiles extends Context.Service<LocalFiles, LocalFilesShape>()(
	"@ue-shed/workbench/LocalFiles"
) {}

const defaultMaxBytes = 32 * 1_024 * 1_024;

function filesError(
	operation: LocalFilesError["operation"],
	path: string,
	cause: unknown,
	recovery: string,
	retrySafe = true
): LocalFilesError {
	return new LocalFilesError({
		causeText: cause instanceof Error ? cause.message : String(cause),
		message: `Local file ${operation} failed.`,
		operation,
		path,
		recovery,
		retrySafe
	});
}

export const LocalFilesLive = Layer.succeed(
	LocalFiles,
	LocalFiles.of({
		exists: Effect.fn("Workbench.LocalFiles.exists")((path: string) =>
			Effect.sync(() => existsSync(path))
		),
		readFile: Effect.fn("Workbench.LocalFiles.readFile")(function* (
			path: string,
			options?: { readonly maxBytes?: number }
		) {
			const maxBytes = options?.maxBytes ?? defaultMaxBytes;
			const bytes = yield* Effect.tryPromise({
				try: () => readFile(path),
				catch: (cause) =>
					filesError(
						"readFile",
						path,
						cause,
						"Verify the artifact path still exists on disk."
					)
			});
			if (bytes.byteLength > maxBytes) {
				return yield* Effect.fail(
					filesError(
						"readFile",
						path,
						`File exceeds the ${maxBytes} byte host read limit.`,
						"Use a smaller artifact or raise the bounded read limit deliberately.",
						false
					)
				);
			}
			return new Uint8Array(bytes);
		})
	})
);

export const makeLocalFilesTestLayer = (
	files: ReadonlyMap<string, Uint8Array> = new Map()
): Layer.Layer<LocalFiles> =>
	Layer.succeed(
		LocalFiles,
		LocalFiles.of({
			exists: Effect.fn("Workbench.LocalFiles.Test.exists")((path: string) =>
				Effect.succeed(files.has(path))
			),
			readFile: Effect.fn("Workbench.LocalFiles.Test.readFile")(function* (
				path: string,
				options?: { readonly maxBytes?: number }
			) {
				const bytes = files.get(path);
				if (!bytes) {
					return yield* Effect.fail(
						filesError(
							"readFile",
							path,
							"File does not exist",
							"Verify the artifact path still exists on disk."
						)
					);
				}
				const maxBytes = options?.maxBytes ?? defaultMaxBytes;
				if (bytes.byteLength > maxBytes) {
					return yield* Effect.fail(
						filesError(
							"readFile",
							path,
							`File exceeds the ${maxBytes} byte host read limit.`,
							"Use a smaller artifact or raise the bounded read limit deliberately.",
							false
						)
					);
				}
				return bytes;
			})
		})
	);
