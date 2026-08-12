import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	unlink
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
	decodeMapCapturePlan,
	MapTilePyramidManifest,
	type MapCapturePlan,
	type MapTilePyramidManifest as MapTilePyramidManifestValue
} from "./map-tile-schema.js";

export const DEFAULT_MAP_CAPTURE_ROOT = ".ue-shed/map-capture";

export class MapCaptureStorageError extends Schema.TaggedErrorClass<MapCaptureStorageError>()(
	"MapCaptureStorageError",
	{
		message: Schema.String,
		operation: Schema.Literals([
			"discard_staging",
			"finalize",
			"list_runs",
			"load_plan",
			"prepare",
			"quarantine",
			"store_tile",
			"validate_project",
			"write_manifest"
		]),
		path: Schema.String,
		recovery: Schema.String
	}
) {}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (cause) {
		await rm(temporary, { force: true });
		throw cause;
	}
}

export function mapCaptureRoot(projectRoot: string): string {
	return resolve(projectRoot, DEFAULT_MAP_CAPTURE_ROOT);
}

export function mapCaptureRunsRoot(projectRoot: string, planId?: string): string {
	return planId === undefined
		? join(mapCaptureRoot(projectRoot), "runs")
		: join(mapCaptureRoot(projectRoot), "runs", planId);
}

export function mapCaptureAttemptsRoot(projectRoot: string, planId?: string): string {
	return planId === undefined
		? join(mapCaptureRoot(projectRoot), "attempts")
		: join(mapCaptureRoot(projectRoot), "attempts", planId);
}

export function validateMapCaptureProjectRoot(
	projectRoot: string
): Effect.Effect<string, MapCaptureStorageError> {
	const root = resolve(projectRoot);
	return Effect.tryPromise({
		try: async () => {
			const details = await stat(root);
			if (!details.isDirectory())
				throw new Error("Map capture requires a project directory.");
			const descriptors = (await readdir(root, { withFileTypes: true })).filter(
				(entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".uproject")
			);
			if (descriptors.length !== 1) {
				throw new Error(
					`Project root must contain exactly one .uproject descriptor; found ${descriptors.length}.`
				);
			}
			return root;
		},
		catch: (cause) =>
			storageError({
				cause,
				operation: "validate_project",
				path: root,
				recovery:
					"Pass a readable Unreal project root containing exactly one .uproject file."
			})
	}).pipe(Effect.withSpan("MapCaptureRepository.validateProjectRoot"));
}

export interface MapCaptureRunSummary {
	readonly completedAt: string;
	readonly manifestPath: string;
	readonly planId: string;
	readonly runId: string;
	readonly tileCount: number;
}

export interface MapCaptureRepositoryShape {
	readonly discardStaging: (args: {
		readonly stagingRoot: string;
	}) => Effect.Effect<void, MapCaptureStorageError>;
	readonly finalize: (args: {
		readonly finalRoot: string;
		readonly manifest: MapTilePyramidManifestValue;
		readonly stagingRoot: string;
	}) => Effect.Effect<void, MapCaptureStorageError>;
	readonly listRuns: (args: {
		readonly planId?: string;
		readonly projectRoot: string;
	}) => Effect.Effect<ReadonlyArray<MapCaptureRunSummary>, MapCaptureStorageError>;
	readonly loadPlan: (path: string) => Effect.Effect<MapCapturePlan, MapCaptureStorageError>;
	readonly prepare: (args: {
		readonly root: string;
		readonly stagingRoot: string;
	}) => Effect.Effect<void, MapCaptureStorageError>;
	readonly quarantine: (args: {
		readonly attemptRoot: string;
		readonly manifest: MapTilePyramidManifestValue;
		readonly stagingRoot: string;
	}) => Effect.Effect<void, MapCaptureStorageError>;
	readonly storeTile: (args: {
		readonly destinationPath: string;
		readonly sourcePath: string;
	}) => Effect.Effect<Uint8Array, MapCaptureStorageError>;
}

export class MapCaptureRepository extends Context.Service<
	MapCaptureRepository,
	MapCaptureRepositoryShape
>()("@ue-shed/cameras/MapCaptureRepository") {}

function storageError(args: {
	readonly cause: unknown;
	readonly operation: MapCaptureStorageError["operation"];
	readonly path: string;
	readonly recovery: string;
}): MapCaptureStorageError {
	return new MapCaptureStorageError({
		message: String(args.cause),
		operation: args.operation,
		path: args.path,
		recovery: args.recovery
	});
}

const makeMapCaptureRepository = (): MapCaptureRepositoryShape => ({
	discardStaging: Effect.fn("MapCaptureRepository.discardStaging")(function* (args) {
		yield* Effect.tryPromise({
			try: () => rm(args.stagingRoot, { force: true, recursive: true }),
			catch: (cause) =>
				storageError({
					cause,
					operation: "discard_staging",
					path: args.stagingRoot,
					recovery: "Remove the abandoned project-local .staging directory manually."
				})
		});
	}),
	finalize: Effect.fn("MapCaptureRepository.finalize")(function* (args) {
		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(args.finalRoot), { recursive: true });
				await writeJsonAtomically(join(args.stagingRoot, "manifest.json"), args.manifest);
				await rename(args.stagingRoot, args.finalRoot);
			},
			catch: (cause) =>
				storageError({
					cause,
					operation: "finalize",
					path: args.finalRoot,
					recovery: "Inspect the staged run and retry atomic finalization."
				})
		});
	}),
	listRuns: Effect.fn("MapCaptureRepository.listRuns")(function* (args) {
		const root = mapCaptureRunsRoot(args.projectRoot, args.planId);
		return yield* Effect.tryPromise({
			try: async () => {
				await mkdir(root, { recursive: true });
				const planDirectories = args.planId
					? [{ name: args.planId, path: root }]
					: (await readdir(root, { withFileTypes: true }))
							.filter((entry) => entry.isDirectory())
							.map((entry) => ({ name: entry.name, path: join(root, entry.name) }));
				const summaries: MapCaptureRunSummary[] = [];
				for (const plan of planDirectories) {
					const runs = (await readdir(plan.path, { withFileTypes: true })).filter(
						(entry) => entry.isDirectory()
					);
					for (const run of runs) {
						const manifestPath = join(plan.path, run.name, "manifest.json");
						const input = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
						const manifest = Schema.decodeUnknownSync(MapTilePyramidManifest)(input);
						if (manifest.state !== "complete") {
							throw new Error(`Published manifest ${manifestPath} is not complete.`);
						}
						summaries.push({
							completedAt: manifest.completedAt,
							manifestPath,
							planId: manifest.planId,
							runId: manifest.runId,
							tileCount: manifest.tiles.length
						});
					}
				}
				return summaries.toSorted((left, right) =>
					right.completedAt.localeCompare(left.completedAt)
				);
			},
			catch: (cause) =>
				storageError({
					cause,
					operation: "list_runs",
					path: root,
					recovery: "Repair or quarantine the malformed completed map-capture bundle."
				})
		});
	}),
	loadPlan: Effect.fn("MapCaptureRepository.loadPlan")(function* (path) {
		const input = yield* Effect.tryPromise({
			try: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
			catch: (cause) =>
				storageError({
					cause,
					operation: "load_plan",
					path,
					recovery: "Check the Map Capture Plan path and JSON, then retry."
				})
		});
		return yield* decodeMapCapturePlan(input).pipe(
			Effect.mapError((cause) =>
				storageError({
					cause,
					operation: "load_plan",
					path,
					recovery: "Validate the Map Capture Plan against contract v1.0."
				})
			)
		);
	}),
	prepare: Effect.fn("MapCaptureRepository.prepare")(function* (args) {
		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(args.root, { recursive: true });
				await mkdir(args.stagingRoot);
			},
			catch: (cause) =>
				storageError({
					cause,
					operation: "prepare",
					path: args.stagingRoot,
					recovery: "Check the project-local map-capture directory and retry."
				})
		});
	}),
	quarantine: Effect.fn("MapCaptureRepository.quarantine")(function* (args) {
		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(args.attemptRoot), { recursive: true });
				await writeJsonAtomically(join(args.stagingRoot, "manifest.json"), args.manifest);
				await rename(args.stagingRoot, args.attemptRoot);
			},
			catch: (cause) =>
				storageError({
					cause,
					operation: "quarantine",
					path: args.attemptRoot,
					recovery: "Inspect the .staging run and move it to the attempts tree manually."
				})
		});
	}),
	storeTile: Effect.fn("MapCaptureRepository.storeTile")(function* (args) {
		return yield* Effect.tryPromise({
			try: async () => {
				await mkdir(dirname(args.destinationPath), { recursive: true });
				await copyFile(args.sourcePath, args.destinationPath);
				const file = await stat(args.destinationPath);
				if (file.size <= 0) throw new Error("Staged PNG is empty.");
				const bytes = new Uint8Array(await readFile(args.destinationPath));
				await unlink(args.sourcePath).catch(() => undefined);
				return bytes;
			},
			catch: (cause) =>
				storageError({
					cause,
					operation: "store_tile",
					path: args.destinationPath,
					recovery: "Check contained Unreal staging and project evidence permissions."
				})
		});
	})
});

export const MapCaptureRepositoryLive = Layer.sync(MapCaptureRepository, makeMapCaptureRepository);

export function makeMapCaptureRepositoryTestLayer(
	service: MapCaptureRepositoryShape
): Layer.Layer<MapCaptureRepository> {
	return Layer.succeed(MapCaptureRepository, MapCaptureRepository.of(service));
}
