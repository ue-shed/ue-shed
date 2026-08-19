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
	CaptureArtifactSourceRejected,
	makeFilesystemCaptureDestination,
	type FilesystemCaptureDestination
} from "./capture-destination.js";
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
			"save_plan",
			"store_tile",
			"validate_project",
			"write_manifest"
		]),
		path: Schema.String,
		recovery: Schema.String
	}
) {}

export class MapCaptureArtifactSourceRejected extends Schema.TaggedErrorClass<MapCaptureArtifactSourceRejected>()(
	"MapCaptureArtifactSourceRejected",
	{
		message: Schema.String,
		path: Schema.String,
		root: Schema.String
	}
) {}

function writeJsonAtomically<Value>(path: string, value: Value): Effect.Effect<void, unknown> {
	return Effect.tryPromise({
		try: async () => {
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
		},
		catch: (cause) => cause
	});
}

export function mapCaptureRoot(projectRoot: string): string {
	return resolve(projectRoot, DEFAULT_MAP_CAPTURE_ROOT);
}

export function mapCapturePlansRoot(projectRoot: string): string {
	return join(mapCaptureRoot(projectRoot), "plans");
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

export interface MapCaptureAttempt {
	readonly discard: () => Effect.Effect<void, MapCaptureStorageError>;
	readonly publish: (
		manifest: MapTilePyramidManifestValue
	) => Effect.Effect<string, MapCaptureStorageError>;
	readonly retain: (
		manifest: MapTilePyramidManifestValue
	) => Effect.Effect<string, MapCaptureStorageError>;
	readonly storeTile: (args: {
		readonly relativePath: string;
		readonly sourceAuthorizationRoot: string;
		readonly sourcePath: string;
		readonly sourceRoot: string;
	}) => Effect.Effect<Uint8Array, MapCaptureArtifactSourceRejected | MapCaptureStorageError>;
}

export interface MapCaptureDestination {
	readonly prepare: (args: {
		readonly planId: MapCapturePlan["id"];
		readonly runId: MapTilePyramidManifestValue["runId"];
	}) => Effect.Effect<MapCaptureAttempt, MapCaptureStorageError>;
	readonly runManifestPath: (args: {
		readonly planId: MapCapturePlan["id"];
		readonly runId: MapTilePyramidManifestValue["runId"];
	}) => string;
}

function mapDestinationStorageError(args: {
	readonly cause: { readonly message: string; readonly path: string };
	readonly operation: MapCaptureStorageError["operation"];
	readonly recovery: string;
}): MapCaptureStorageError {
	return new MapCaptureStorageError({
		message: args.cause.message,
		operation: args.operation,
		path: args.cause.path,
		recovery: args.recovery
	});
}

function mapCaptureDestination(filesystem: FilesystemCaptureDestination): MapCaptureDestination {
	const completedDestination = (planId: string, runId: string) => `runs/${planId}/${runId}`;
	const retainedDestination = (planId: string, runId: string) => `attempts/${planId}/${runId}`;
	return {
		prepare: Effect.fn("MapCaptureDestination.prepare")(function* (args) {
			const attempt = yield* filesystem
				.prepare({
					attemptName: `.staging-${args.runId}`,
					reservedDestinations: [
						completedDestination(args.planId, args.runId),
						retainedDestination(args.planId, args.runId)
					]
				})
				.pipe(
					Effect.mapError((cause) =>
						mapDestinationStorageError({
							cause,
							operation: "prepare",
							recovery:
								"Choose a new run identity or inspect the existing map-capture attempt."
						})
					)
				);
			const promote = (
				manifest: MapTilePyramidManifestValue,
				relativeDestination: string,
				operation: "finalize" | "quarantine"
			) =>
				attempt
					.promote({
						documentName: "manifest.json",
						documentValue: manifest,
						relativeDestination
					})
					.pipe(
						Effect.mapError((cause) =>
							mapDestinationStorageError({
								cause,
								operation,
								recovery:
									operation === "finalize"
										? "Inspect the staged run and retry atomic finalization."
										: "Inspect the staged run and retry retaining the partial attempt."
							})
						)
					);
			return {
				discard: () =>
					attempt.discard().pipe(
						Effect.mapError((cause) =>
							mapDestinationStorageError({
								cause,
								operation: "discard_staging",
								recovery: "Remove the owned staging attempt manually if it remains."
							})
						)
					),
				publish: (manifest) =>
					manifest.state === "complete"
						? promote(
								manifest,
								completedDestination(args.planId, args.runId),
								"finalize"
							)
						: Effect.fail(
								new MapCaptureStorageError({
									message:
										"Only exhaustive successful Map Capture runs can publish.",
									operation: "finalize",
									path: filesystem.documentPath(
										completedDestination(args.planId, args.runId),
										"manifest.json"
									),
									recovery: "Retain non-complete runs as attempts instead."
								})
							),
				retain: (manifest) =>
					manifest.state !== "complete"
						? promote(
								manifest,
								retainedDestination(args.planId, args.runId),
								"quarantine"
							)
						: Effect.fail(
								new MapCaptureStorageError({
									message:
										"Complete Map Capture runs must publish, not remain attempts.",
									operation: "quarantine",
									path: filesystem.documentPath(
										retainedDestination(args.planId, args.runId),
										"manifest.json"
									),
									recovery: "Publish the exhaustive successful run."
								})
							),
				storeTile: (input) =>
					attempt.storeArtifact(input).pipe(
						Effect.map((stored) => stored.bytes),
						Effect.mapError((cause) =>
							cause instanceof CaptureArtifactSourceRejected
								? new MapCaptureArtifactSourceRejected({
										message: cause.message,
										path: cause.path,
										root: cause.root
									})
								: mapDestinationStorageError({
										cause,
										operation: "store_tile",
										recovery:
											"Check contained Unreal staging and capture destination permissions."
									})
						)
					)
			} satisfies MapCaptureAttempt;
		}),
		runManifestPath: (args) =>
			filesystem.documentPath(completedDestination(args.planId, args.runId), "manifest.json")
	};
}

/** The compatibility adapter beneath `<project>/.ue-shed/map-capture`. */
export function projectLocalMapCaptureDestination(projectRoot: string): MapCaptureDestination {
	const absoluteProjectRoot = resolve(projectRoot);
	return mapCaptureDestination(
		makeFilesystemCaptureDestination({
			authorizationRoot: absoluteProjectRoot,
			createRoot: true,
			destinationRoot: mapCaptureRoot(absoluteProjectRoot),
			recovery: "Check that the project and its map-capture directory are writable.",
			rejectAuthorizationRootLink: false
		})
	);
}

/** A trusted-host adapter rooted at one existing absolute caller-owned directory. */
export function callerOwnedMapCaptureDestination(root: string): MapCaptureDestination {
	return mapCaptureDestination(
		makeFilesystemCaptureDestination({
			authorizationRoot: root,
			createRoot: false,
			destinationRoot: root,
			recovery:
				"Select an existing absolute directory that the caller authorizes for Map Capture runs.",
			rejectAuthorizationRootLink: true
		})
	);
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

export interface MapCaptureRepositoryApi {
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
	readonly savePlan: (
		path: string,
		plan: MapCapturePlan
	) => Effect.Effect<void, MapCaptureStorageError>;
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

/** @deprecated Use `MapCaptureRepositoryApi`. */
export type MapCaptureRepositoryShape = MapCaptureRepositoryApi;

export class MapCaptureRepository extends Context.Service<
	MapCaptureRepository,
	MapCaptureRepositoryApi
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

const makeMapCaptureRepository = (): MapCaptureRepositoryApi => ({
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
		yield* Effect.gen(function* () {
			yield* Effect.tryPromise({
				try: () => mkdir(dirname(args.finalRoot), { recursive: true }),
				catch: (cause) => cause
			});
			yield* writeJsonAtomically(join(args.stagingRoot, "manifest.json"), args.manifest);
			yield* Effect.tryPromise({
				try: () => rename(args.stagingRoot, args.finalRoot),
				catch: (cause) => cause
			});
		}).pipe(
			Effect.mapError((cause) =>
				storageError({
					cause,
					operation: "finalize",
					path: args.finalRoot,
					recovery: "Inspect the staged run and retry atomic finalization."
				})
			)
		);
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
						const input = Schema.decodeUnknownSync(Schema.Json)(
							JSON.parse(await readFile(manifestPath, "utf8"))
						);
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
			try: async () =>
				Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8"))),
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
	savePlan: Effect.fn("MapCaptureRepository.savePlan")(function* (path, plan) {
		yield* writeJsonAtomically(path, plan).pipe(
			Effect.mapError((cause) =>
				storageError({
					cause,
					operation: "save_plan",
					path,
					recovery: "Check the plan destination permissions and retry Save or Save As."
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
		yield* Effect.gen(function* () {
			yield* Effect.tryPromise({
				try: () => mkdir(dirname(args.attemptRoot), { recursive: true }),
				catch: (cause) => cause
			});
			yield* writeJsonAtomically(join(args.stagingRoot, "manifest.json"), args.manifest);
			yield* Effect.tryPromise({
				try: () => rename(args.stagingRoot, args.attemptRoot),
				catch: (cause) => cause
			});
		}).pipe(
			Effect.mapError((cause) =>
				storageError({
					cause,
					operation: "quarantine",
					path: args.attemptRoot,
					recovery: "Inspect the .staging run and move it to the attempts tree manually."
				})
			)
		);
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
	service: MapCaptureRepositoryApi
): Layer.Layer<MapCaptureRepository> {
	return Layer.succeed(MapCaptureRepository, MapCaptureRepository.of(service));
}
