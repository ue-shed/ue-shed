import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { ElectronApp } from "./electron-app.js";

export class ProjectInventoryCacheError extends Schema.TaggedErrorClass<ProjectInventoryCacheError>()(
	"Workbench.ProjectInventoryCacheError",
	{
		causeText: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["read", "write"]),
		projectRoot: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ProjectInventoryCacheShape {
	readonly read: (
		projectRoot: string
	) => Effect.Effect<unknown | undefined, ProjectInventoryCacheError>;
	readonly write: (
		projectRoot: string,
		value: unknown
	) => Effect.Effect<void, ProjectInventoryCacheError>;
}

export class ProjectInventoryCache extends Context.Service<
	ProjectInventoryCache,
	ProjectInventoryCacheShape
>()("@ue-shed/workbench/ProjectInventoryCache") {}

function cacheError(
	operation: ProjectInventoryCacheError["operation"],
	projectRoot: string,
	cause: unknown
): ProjectInventoryCacheError {
	return new ProjectInventoryCacheError({
		causeText: cause instanceof Error ? cause.message : String(cause),
		message: `Project inventory cache ${operation} failed.`,
		operation,
		projectRoot,
		recovery:
			"The project can be scanned again; retry after checking the Workbench user-data directory.",
		retrySafe: true
	});
}

function isNotFound(cause: unknown): boolean {
	return (
		typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
	);
}

function inventoryFileName(projectRoot: string): string {
	return `${createHash("sha256").update(projectRoot).digest("hex")}.json`;
}

export const ProjectInventoryCacheLive = Layer.effect(
	ProjectInventoryCache,
	Effect.gen(function* () {
		const app = yield* ElectronApp;
		const cacheDirectory = join(yield* app.getPath("userData"), "project-inventories-v1");
		const cachePath = (projectRoot: string) =>
			join(cacheDirectory, inventoryFileName(projectRoot));

		return ProjectInventoryCache.of({
			read: Effect.fn("Workbench.ProjectInventoryCache.read")(function* (projectRoot) {
				const path = cachePath(projectRoot);
				return yield* Effect.tryPromise({
					try: async () => {
						try {
							return JSON.parse(await readFile(path, "utf8")) as unknown;
						} catch (cause) {
							if (isNotFound(cause)) return undefined;
							throw cause;
						}
					},
					catch: (cause) => cacheError("read", projectRoot, cause)
				});
			}),
			write: Effect.fn("Workbench.ProjectInventoryCache.write")(
				function* (projectRoot, value) {
					const path = cachePath(projectRoot);
					const temporaryPath = `${path}.${randomUUID()}.tmp`;
					yield* Effect.tryPromise({
						try: async () => {
							await mkdir(cacheDirectory, { recursive: true });
							await writeFile(temporaryPath, JSON.stringify(value), "utf8");
							await rename(temporaryPath, path);
						},
						catch: (cause) => cacheError("write", projectRoot, cause)
					});
				}
			)
		});
	})
);
