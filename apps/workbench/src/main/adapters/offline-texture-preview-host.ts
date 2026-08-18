import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Context, Effect, Exit, Layer, Schema } from "effect";

export class OfflineTexturePreviewHostError extends Schema.TaggedErrorClass<OfflineTexturePreviewHostError>()(
	"Workbench.OfflineTexturePreviewHostError",
	{
		causeText: Schema.String,
		message: Schema.String,
		operation: Schema.Literals([
			"create_directory",
			"list_directories",
			"list_project_files",
			"read_file",
			"run_commandlet",
			"stat_file",
			"write_file"
		]),
		path: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface OfflineTexturePreviewHostFile {
	readonly modifiedMs: number;
	readonly size: number;
}

export interface OfflineTexturePreviewHostRunOptions {
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	readonly executable: string;
}

export interface OfflineTexturePreviewHostRunResult {
	readonly exitCode: number | null;
	readonly stderr: string;
}

export interface OfflineTexturePreviewHostApi {
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly listDirectories: (
		path: string
	) => Effect.Effect<ReadonlyArray<string>, OfflineTexturePreviewHostError>;
	readonly listProjectFiles: (
		path: string
	) => Effect.Effect<ReadonlyArray<string>, OfflineTexturePreviewHostError>;
	readonly makeDirectory: (path: string) => Effect.Effect<void, OfflineTexturePreviewHostError>;
	readonly programFiles: string;
	readonly readFile: (
		path: string,
		maxBytes: number
	) => Effect.Effect<Uint8Array, OfflineTexturePreviewHostError>;
	readonly runCommandlet: (
		options: OfflineTexturePreviewHostRunOptions
	) => Effect.Effect<OfflineTexturePreviewHostRunResult, OfflineTexturePreviewHostError>;
	readonly statFile: (
		path: string
	) => Effect.Effect<OfflineTexturePreviewHostFile, OfflineTexturePreviewHostError>;
	readonly writeFile: (
		path: string,
		bytes: Uint8Array
	) => Effect.Effect<void, OfflineTexturePreviewHostError>;
}

export class OfflineTexturePreviewHost extends Context.Service<
	OfflineTexturePreviewHost,
	OfflineTexturePreviewHostApi
>()("@ue-shed/workbench/OfflineTexturePreviewHost") {}

function hostError(
	operation: OfflineTexturePreviewHostError["operation"],
	path: string,
	cause: unknown,
	retrySafe = true
): OfflineTexturePreviewHostError {
	const causeText = cause instanceof Error ? cause.message : String(cause);
	return new OfflineTexturePreviewHostError({
		causeText,
		message: `${operation.replaceAll("_", " ")} failed for ${path}: ${causeText}`,
		operation,
		path,
		retrySafe
	});
}

function terminateChild(child: ChildProcess): void {
	if (!child.killed && child.exitCode === null) child.kill();
}

export const offlineTexturePreviewHostLayer = (
	environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<OfflineTexturePreviewHost> =>
	Layer.succeed(
		OfflineTexturePreviewHost,
		OfflineTexturePreviewHost.of({
			exists: Effect.fn("Workbench.OfflineTexturePreviewHost.exists")((path: string) =>
				Effect.sync(() => existsSync(path))
			),
			listDirectories: Effect.fn("Workbench.OfflineTexturePreviewHost.listDirectories")(
				(path: string) =>
					Effect.tryPromise({
						try: async () =>
							(await readdir(path, { withFileTypes: true }))
								.filter((entry) => entry.isDirectory())
								.map((entry) => join(path, entry.name)),
						catch: (cause) => hostError("list_directories", path, cause)
					})
			),
			listProjectFiles: Effect.fn("Workbench.OfflineTexturePreviewHost.listProjectFiles")(
				(path: string) =>
					Effect.tryPromise({
						try: async () =>
							(await readdir(path, { withFileTypes: true }))
								.filter(
									(entry) =>
										entry.isFile() &&
										extname(entry.name).toLowerCase() === ".uproject"
								)
								.map((entry) => join(path, entry.name)),
						catch: (cause) => hostError("list_project_files", path, cause)
					})
			),
			makeDirectory: Effect.fn("Workbench.OfflineTexturePreviewHost.makeDirectory")(
				(path: string) =>
					Effect.tryPromise({
						try: () => mkdir(path, { recursive: true }).then(() => undefined),
						catch: (cause) => hostError("create_directory", path, cause)
					})
			),
			programFiles: environment.ProgramFiles ?? "C:\\Program Files",
			readFile: Effect.fn("Workbench.OfflineTexturePreviewHost.readFile")(
				(path: string, maxBytes: number) =>
					Effect.tryPromise({
						try: async () => {
							const bytes = await readFile(path);
							if (bytes.byteLength > maxBytes) {
								throw new Error(`File exceeds the ${maxBytes} byte read limit.`);
							}
							return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
						},
						catch: (cause) => hostError("read_file", path, cause)
					})
			),
			runCommandlet: Effect.fn("Workbench.OfflineTexturePreviewHost.runCommandlet")(
				(options: OfflineTexturePreviewHostRunOptions) =>
					Effect.scoped(
						Effect.acquireRelease(
							Effect.try({
								try: () =>
									spawn(options.executable, [...options.args], {
										cwd: options.cwd,
										stdio: ["ignore", "ignore", "pipe"],
										windowsHide: true
									}),
								catch: (cause) =>
									hostError("run_commandlet", options.executable, cause)
							}),
							(child, exit) =>
								Effect.sync(() => {
									if (Exit.hasInterrupts(exit) || Exit.isFailure(exit)) {
										terminateChild(child);
									}
								})
						).pipe(
							Effect.flatMap((child) =>
								Effect.callback<
									OfflineTexturePreviewHostRunResult,
									OfflineTexturePreviewHostError
								>((resume) => {
									let settled = false;
									let stderr = "";
									child.stderr?.setEncoding("utf8");
									child.stderr?.on("data", (chunk: string) => {
										stderr = (stderr + chunk).slice(-16_384);
									});
									child.once("error", (cause) => {
										if (settled) return;
										settled = true;
										resume(
											Effect.fail(
												hostError(
													"run_commandlet",
													options.executable,
													cause
												)
											)
										);
									});
									child.once("exit", (code) => {
										if (settled) return;
										settled = true;
										resume(
											Effect.succeed({
												exitCode: code,
												stderr: stderr.trim()
											})
										);
									});
									return Effect.sync(() => terminateChild(child));
								})
							)
						)
					)
			),
			statFile: Effect.fn("Workbench.OfflineTexturePreviewHost.statFile")((path: string) =>
				Effect.tryPromise({
					try: async () => {
						const result = await stat(path);
						return { modifiedMs: result.mtimeMs, size: result.size };
					},
					catch: (cause) => hostError("stat_file", path, cause)
				})
			),
			writeFile: Effect.fn("Workbench.OfflineTexturePreviewHost.writeFile")(
				(path: string, bytes: Uint8Array) =>
					Effect.tryPromise({
						try: () => writeFile(path, bytes),
						catch: (cause) => hostError("write_file", path, cause)
					})
			)
		})
	);
