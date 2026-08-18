import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

export class LocalFilesError extends Schema.TaggedErrorClass<LocalFilesError>()(
	"Workbench.LocalFilesError",
	{
		causeText: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["exists", "readFile", "writeFile"]),
		path: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface LocalFilesApi {
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly readFile: (
		path: string,
		options?: { readonly maxBytes?: number }
	) => Effect.Effect<Uint8Array, LocalFilesError>;
	readonly readFileWithin: (
		directory: string,
		relativePath: string,
		options?: { readonly maxBytes?: number }
	) => Effect.Effect<Uint8Array, LocalFilesError>;
	readonly writeFile: (
		path: string,
		bytes: Uint8Array,
		options?: { readonly maxBytes?: number }
	) => Effect.Effect<void, LocalFilesError>;
}

export class LocalFiles extends Context.Service<LocalFiles, LocalFilesApi>()(
	"@ue-shed/workbench/LocalFiles"
) {}

const defaultMaxBytes = 32 * 1_024 * 1_024;
const maximumHostReadBytes = 512 * 1_024 * 1_024;

function containedPath(directory: string, candidate: string): string | undefined {
	const root = resolve(directory);
	const target = resolve(root, candidate);
	const fromRoot = relative(root, target);
	return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)
		? undefined
		: target;
}

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
	LocalFiles.of(
		(() => {
			const readBounded = Effect.fn("Workbench.LocalFiles.readFile")(function* (
				path: string,
				options?: { readonly maxBytes?: number }
			) {
				const maxBytes = options?.maxBytes ?? defaultMaxBytes;
				if (
					!Number.isSafeInteger(maxBytes) ||
					maxBytes < 0 ||
					maxBytes > maximumHostReadBytes
				) {
					return yield* Effect.fail(
						filesError(
							"readFile",
							path,
							`The maximum byte count must be between 0 and ${maximumHostReadBytes}.`,
							"Pass a valid bounded host read limit.",
							false
						)
					);
				}
				return yield* Effect.scoped(
					Effect.acquireRelease(
						Effect.tryPromise({
							try: () => open(path, "r"),
							catch: (cause) =>
								filesError(
									"readFile",
									path,
									cause,
									"Verify the artifact path still exists on disk."
								)
						}),
						(handle) => Effect.promise(() => handle.close())
					).pipe(
						Effect.flatMap((handle) =>
							Effect.tryPromise({
								try: async () => {
									const stats = await handle.stat();
									if (stats.size > maxBytes)
										return { status: "too_large" as const };
									const chunks: Array<Buffer> = [];
									let total = 0;
									while (total <= maxBytes) {
										const buffer = Buffer.allocUnsafe(
											Math.min(64 * 1_024, maxBytes + 1 - total)
										);
										const { bytesRead } = await handle.read(
											buffer,
											0,
											buffer.byteLength,
											total
										);
										if (bytesRead === 0) break;
										chunks.push(buffer.subarray(0, bytesRead));
										total += bytesRead;
									}
									const bytes = Buffer.concat(chunks, total);
									return total > maxBytes
										? ({ status: "too_large" } as const)
										: {
												status: "ready" as const,
												bytes: new Uint8Array(
													bytes.buffer,
													bytes.byteOffset,
													bytes.byteLength
												)
											};
								},
								catch: (cause) =>
									filesError(
										"readFile",
										path,
										cause,
										"Verify the artifact path still exists on disk."
									)
							})
						),
						Effect.flatMap((result) =>
							result.status === "ready"
								? Effect.succeed(result.bytes)
								: Effect.fail(
										filesError(
											"readFile",
											path,
											`File exceeds the ${maxBytes} byte host read limit.`,
											"Use a smaller artifact or raise the bounded read limit deliberately.",
											false
										)
									)
						)
					)
				);
			});

			return {
				exists: Effect.fn("Workbench.LocalFiles.exists")((path: string) =>
					Effect.sync(() => existsSync(path))
				),
				readFile: readBounded,
				readFileWithin: Effect.fn("Workbench.LocalFiles.readFileWithin")(
					function* (directory, relativePath, options) {
						const path = containedPath(directory, relativePath);
						if (!path) {
							return yield* Effect.fail(
								filesError(
									"readFile",
									relativePath,
									"Artifact path escapes its capture-run directory.",
									"Regenerate or repair the capture-run document before loading it.",
									false
								)
							);
						}
						return yield* readBounded(path, options);
					}
				),
				writeFile: Effect.fn("Workbench.LocalFiles.writeFile")(
					function* (path, bytes, options) {
						const maxBytes = options?.maxBytes ?? defaultMaxBytes;
						if (
							!Number.isSafeInteger(maxBytes) ||
							maxBytes < 0 ||
							maxBytes > maximumHostReadBytes ||
							bytes.byteLength > maxBytes
						) {
							return yield* Effect.fail(
								filesError(
									"writeFile",
									path,
									`File exceeds the ${maxBytes} byte host write limit.`,
									"Reduce the rule document before saving.",
									false
								)
							);
						}
						const temporaryPath = `${path}.${randomUUID()}.tmp`;
						return yield* Effect.tryPromise({
							try: async () => {
								try {
									await writeFile(temporaryPath, bytes, { flag: "wx" });
									await rename(temporaryPath, path);
								} catch (cause) {
									await rm(temporaryPath, { force: true }).catch(() => undefined);
									throw cause;
								}
							},
							catch: (cause) =>
								filesError(
									"writeFile",
									path,
									cause,
									"Verify the rule file is writable and retry."
								)
						});
					}
				)
			};
		})()
	)
);

export const makeLocalFilesTestLayer = (
	files: Map<string, Uint8Array> = new Map()
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
			}),
			readFileWithin: Effect.fn("Workbench.LocalFiles.Test.readFileWithin")(
				function* (directory, relativePath, options) {
					const path = containedPath(directory, relativePath);
					if (!path) {
						return yield* Effect.fail(
							filesError(
								"readFile",
								relativePath,
								"Artifact path escapes its capture-run directory.",
								"Regenerate or repair the capture-run document before loading it.",
								false
							)
						);
					}
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
					return bytes.byteLength > maxBytes
						? yield* Effect.fail(
								filesError(
									"readFile",
									path,
									`File exceeds the ${maxBytes} byte host read limit.`,
									"Use a smaller artifact or raise the bounded read limit deliberately.",
									false
								)
							)
						: bytes;
				}
			),
			writeFile: Effect.fn("Workbench.LocalFiles.Test.writeFile")(
				function* (path, bytes, options) {
					const maxBytes = options?.maxBytes ?? defaultMaxBytes;
					if (bytes.byteLength > maxBytes) {
						return yield* Effect.fail(
							filesError(
								"writeFile",
								path,
								`File exceeds the ${maxBytes} byte host write limit.`,
								"Reduce the rule document before saving.",
								false
							)
						);
					}
					files.set(path, bytes);
				}
			)
		})
	);
