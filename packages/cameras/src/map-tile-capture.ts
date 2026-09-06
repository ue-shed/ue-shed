import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	makeRemoteControlClient,
	RemoteControlClient,
	type RemoteControlClientApi
} from "@ue-shed/unreal-connection";
import { Clock, Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import {
	createMapTileGrid,
	mapTileKeyId,
	mapTileRelativePath,
	mapTileWorldBounds,
	type MapTileGrid,
	type MapTileKey
} from "./map-tile-pyramid.js";
import { CAMERAS_PACKAGE_VERSION } from "./version.js";
import { mapCaptureBackendIssue } from "./map-tile-authoring.js";
import {
	MapCaptureRepository,
	MapCaptureRepositoryLive,
	MapCaptureArtifactSourceRejected,
	projectLocalMapCaptureDestination,
	validateMapCaptureProjectRoot,
	type MapCaptureDestination,
	type MapCaptureRepositoryApi,
	type MapCaptureStorageError
} from "./map-tile-repository.js";
import {
	MapCaptureOperationId,
	type MapCaptureBackend,
	MapCaptureRunId,
	MapTileCaptureRequest,
	MapTileCaptureOperation,
	decodeMapTileCaptureResponse,
	decodeMapTilePyramidManifest,
	type MapCapturePlan,
	type MapTileCaptureRequest as MapTileCaptureRequestValue,
	type MapTileCaptureResponse,
	type MapTilePyramidManifest as MapTilePyramidManifestValue
} from "./map-tile-schema.js";

const mapTileReviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";
const maximumTilesPerRequest = 64;
const litCameraTilesPerBatch = 4;
const maximumEnumeratedTiles = 1_000_000;

export class MapCaptureRunError extends Schema.TaggedErrorClass<MapCaptureRunError>()(
	"MapCaptureRunError",
	{
		message: Schema.String,
		operation: Schema.Literals(["inspect", "prepare", "capture", "publish"]),
		recovery: Schema.String,
		runId: Schema.optionalKey(Schema.String)
	}
) {}

export interface MapTileCapturePortApi {
	/** Release a run's viewport, camera and scene freeze on completion or interruption. */
	readonly release?: (runId: string) => Effect.Effect<void, unknown>;
	readonly capture: (
		request: MapTileCaptureRequestValue
	) => Effect.Effect<MapTileCaptureResponse, unknown>;
}

/** @deprecated Use `MapTileCapturePortApi`. */
export type MapTileCapturePortShape = MapTileCapturePortApi;

export class MapTileCapturePort extends Context.Service<
	MapTileCapturePort,
	MapTileCapturePortApi
>()("@ue-shed/cameras/MapTileCapturePort") {}

export function makeMapTileCaptureRemotePort(
	client: RemoteControlClientApi,
	endpoint: string
): MapTileCapturePortApi {
	return {
		release: Effect.fn("MapCapture.remoteRelease")(function* (runId: string) {
			yield* client
				.request({
					endpoint,
					timeout: "5 seconds",
					functionName: "EndMapTileCapture",
					objectPath: mapTileReviewLibraryPath,
					operation: "camera.map_tile.release.remote",
					parameters: { RunId: runId }
				})
				.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.Struct({ released: Schema.Boolean }))
					)
				);
		}),
		capture: Effect.fn("MapCapture.remoteCapture")(function* (request) {
			if ((request.captureBackend ?? "lit_camera_tiles") !== "lit_camera_tiles") {
				return yield* client
					.request({
						endpoint,
						functionName: "CaptureMapTiles",
						objectPath: mapTileReviewLibraryPath,
						operation: "camera.map_tile.capture.remote",
						parameters: { RequestJson: JSON.stringify(request) }
					})
					.pipe(Effect.flatMap(decodeMapTileCaptureResponse));
			}
			const decode = (value: Schema.Json) =>
				Schema.decodeUnknownEffect(MapTileCaptureOperation)(value).pipe(
					Effect.flatMap((status) => {
						const operationId =
							status.state === "running"
								? status.operationId
								: status.response.operationId;
						return operationId === request.operationId
							? Effect.succeed(status)
							: Effect.fail(
									new MapCaptureRunError({
										message:
											"Editor capture response belongs to a different operation.",
										operation: "capture",
										recovery:
											"Reconnect and inspect the active editor capture before retrying."
									})
								);
					})
				);
			const start = yield* client
				.request({
					endpoint,
					functionName: "BeginMapTileCapture",
					objectPath: mapTileReviewLibraryPath,
					operation: "camera.map_tile.begin.remote",
					parameters: { RequestJson: JSON.stringify(request) }
				})
				.pipe(Effect.flatMap(decode));
			if (start.state === "finished") return start.response;
			const finished = yield* client
				.request({
					endpoint,
					functionName: "PollMapTileCapture",
					timeout: "30 seconds",
					objectPath: mapTileReviewLibraryPath,
					operation: "camera.map_tile.poll.remote",
					parameters: { RunId: request.runId, OperationId: request.operationId }
				})
				.pipe(
					Effect.flatMap(decode),
					Effect.repeat({
						schedule: Schedule.spaced("200 millis"),
						while: (status) => status.state === "running"
					}),
					Effect.timeout("15 minutes")
				);
			if (finished.state !== "finished")
				return yield* Effect.die("Map capture polling ended without a terminal response.");
			return finished.response;
		})
	};
}

export function mapTileCaptureRemotePortLayer(
	endpoint: string
): Layer.Layer<MapTileCapturePort, never, RemoteControlClient> {
	return Layer.effect(
		MapTileCapturePort,
		Effect.gen(function* () {
			const client = yield* RemoteControlClient;
			return MapTileCapturePort.of(makeMapTileCaptureRemotePort(client, endpoint));
		})
	);
}

export function mapTileCapturePortLayer(
	service: MapTileCapturePortApi
): Layer.Layer<MapTileCapturePort> {
	return Layer.succeed(MapTileCapturePort, MapTileCapturePort.of(service));
}

export interface InspectMapCapturePlanResult {
	readonly grid: MapTileGrid;
	readonly plan: MapCapturePlan;
	readonly tileCount: number;
}

export function inspectMapCapturePlan(
	plan: MapCapturePlan
): Effect.Effect<InspectMapCapturePlanResult, MapCaptureRunError> {
	return Effect.try({
		try: () => {
			const grid = createMapTileGrid({
				coarsestUnitsPerPixel: plan.levels.coarsestUnitsPerPixel,
				levelCount: plan.levels.count,
				requestedBounds: plan.requestedBounds,
				tilePixelSize: plan.tilePixelSize
			});
			const tileCount = grid.levels.reduce(
				(count, level) => count + level.rows * level.columns,
				0
			);
			if (tileCount > maximumEnumeratedTiles) {
				throw new RangeError(
					`Plan expands to ${tileCount} tiles; the v1 host limit is ${maximumEnumeratedTiles}.`
				);
			}
			return { grid, plan, tileCount };
		},
		catch: (cause) =>
			new MapCaptureRunError({
				message: String(cause),
				operation: "inspect",
				recovery: "Reduce bounds or levels, or increase coarsest world-units-per-pixel."
			})
	});
}

export interface RunMapCaptureOptions {
	readonly captureBackend?: MapCaptureBackend;
	readonly correlationId?: string;
	/**
	 * Final and retained-attempt storage. Omit this to use
	 * `<project>/.ue-shed/map-capture`.
	 */
	readonly destination?: MapCaptureDestination;
	readonly endpoint: string;
	readonly levels?: ReadonlyArray<number>;
	readonly onProgress?: (progress: MapCaptureRunProgress) => Effect.Effect<void>;
	readonly planPath: string;
	readonly projectRoot: string;
	readonly runId?: string;
	readonly tiles?: ReadonlyArray<MapTileKey>;
}

export interface RunMapCapturePlanOptions extends Omit<RunMapCaptureOptions, "planPath"> {
	readonly plan: MapCapturePlan;
}

export interface MapCaptureRunOutcome {
	readonly manifest: MapTilePyramidManifestValue;
	readonly manifestPath: string;
	readonly published: boolean;
}

export interface MapCaptureRunProgress {
	readonly failedTiles: number;
	readonly phase: "capturing" | "publishing";
	readonly processedTiles: number;
	readonly totalTiles: number;
}

function allTileKeys(grid: MapTileGrid): ReadonlyArray<MapTileKey> {
	return grid.levels.flatMap((level) => {
		const keys: MapTileKey[] = [];
		for (let row = 0; row < level.rows; row += 1) {
			for (let column = 0; column < level.columns; column += 1) {
				keys.push({ zoom: level.zoom, row, column });
			}
		}
		return keys;
	});
}

function selectedTileKeys(args: {
	readonly grid: MapTileGrid;
	readonly levels?: ReadonlyArray<number>;
	readonly tiles?: ReadonlyArray<MapTileKey>;
}): Effect.Effect<ReadonlyArray<MapTileKey>, MapCaptureRunError> {
	return Effect.try({
		try: () => {
			if (args.levels !== undefined && args.tiles !== undefined) {
				throw new RangeError("Select levels or explicit tiles, not both.");
			}
			const keys = args.tiles
				? [...args.tiles]
				: allTileKeys(args.grid).filter(
						(key) => args.levels === undefined || args.levels.includes(key.zoom)
					);
			if (keys.length === 0) throw new RangeError("The capture selection is empty.");
			const identities = new Set<string>();
			for (const key of keys) {
				const level = args.grid.levels[key.zoom];
				if (
					!level ||
					!Number.isInteger(key.row) ||
					key.row < 0 ||
					key.row >= level.rows ||
					!Number.isInteger(key.column) ||
					key.column < 0 ||
					key.column >= level.columns
				) {
					throw new RangeError(`Tile ${mapTileKeyId(key)} is outside the plan grid.`);
				}
				const identity = mapTileKeyId(key);
				if (identities.has(identity)) throw new RangeError(`Duplicate tile ${identity}.`);
				identities.add(identity);
			}
			return keys;
		},
		catch: (cause) =>
			new MapCaptureRunError({
				message: String(cause),
				operation: "prepare",
				recovery: "Inspect the plan grid and request a valid bounded level or tile subset."
			})
	});
}

function batches<T>(values: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> {
	const result: Array<ReadonlyArray<T>> = [];
	for (let index = 0; index < values.length; index += size) {
		result.push(values.slice(index, index + size));
	}
	return result;
}

function sha256(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readPngDimensions(bytes: Uint8Array) {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
		throw new Error("Staged artifact is not a PNG file.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { height: view.getUint32(20), width: view.getUint32(16) };
}

function isoNow(millis: number): string {
	return new Date(millis).toISOString();
}

function makeRequest(args: {
	readonly batch: ReadonlyArray<MapTileKey>;
	readonly captureBackend: MapCaptureBackend;
	readonly correlationId: string;
	readonly grid: MapTileGrid;
	readonly operationId: string;
	readonly plan: MapCapturePlan;
	readonly runId: string;
}): MapTileCaptureRequestValue {
	return MapTileCaptureRequest.make({
		capture: args.plan.capture,
		captureBackend: args.captureBackend,
		overviewBounds: args.grid.snappedBounds,
		contract: { name: "ue-shed-map-tile-capture", version: { major: 1, minor: 0 } },
		correlationId: args.correlationId,
		expectedMapPath: args.plan.project.mapPath,
		gutterPixels: args.plan.gutterPixels,
		operationId: MapCaptureOperationId.make(args.operationId),
		planId: args.plan.id,
		runId: MapCaptureRunId.make(args.runId),
		tilePixelSize: args.plan.tilePixelSize,
		tiles: args.batch.map((key) => ({
			key,
			unitsPerPixel: args.grid.levels[key.zoom]!.unitsPerPixel,
			worldBounds: mapTileWorldBounds(args.grid, key)
		}))
	});
}

function viewportLevelBatches(args: {
	readonly grid: MapTileGrid;
	readonly keys: ReadonlyArray<MapTileKey>;
}): Effect.Effect<ReadonlyArray<ReadonlyArray<MapTileKey>>, MapCaptureRunError> {
	return Effect.try({
		try: () => {
			const selected = new Set(args.keys.map(mapTileKeyId));
			const zooms = [...new Set(args.keys.map((key) => key.zoom))].toSorted((a, b) => a - b);
			return zooms.map((zoom) => {
				const level = args.grid.levels[zoom];
				if (level === undefined)
					throw new RangeError(`Zoom ${zoom} is outside the plan grid.`);
				const levelKeys: MapTileKey[] = [];
				for (let row = 0; row < level.rows; row += 1) {
					for (let column = 0; column < level.columns; column += 1) {
						const key = { zoom, row, column };
						if (!selected.has(mapTileKeyId(key))) {
							throw new RangeError(
								"Viewport High Resolution capture requires complete zoom levels."
							);
						}
						levelKeys.push(key);
					}
				}
				if (levelKeys.length > maximumTilesPerRequest) {
					throw new RangeError(
						`Viewport High Resolution test supports at most ${maximumTilesPerRequest} tiles per zoom; Z${zoom} has ${levelKeys.length}.`
					);
				}
				return levelKeys;
			});
		},
		catch: (cause) =>
			new MapCaptureRunError({
				message: String(cause),
				operation: "prepare",
				recovery:
					"Capture complete levels no larger than 8 x 8 tiles, or use the tiled Scene Capture backend."
			})
	});
}

function captureFailure(args: {
	readonly code: "capture_failed" | "dirty_state_changed" | "invalid_request" | "write_failed";
	readonly message: string;
	readonly retrySafe: boolean;
}) {
	return {
		code: args.code,
		message: args.message,
		recovery:
			"Inspect the attempt manifest and editor state before retrying the failed tile subset.",
		retrySafe: args.retrySafe
	} as const;
}

function runMapCaptureWith(args: {
	readonly options: RunMapCaptureOptions | RunMapCapturePlanOptions;
	readonly port: MapTileCapturePortApi;
	readonly repository: MapCaptureRepositoryApi;
}): Effect.Effect<MapCaptureRunOutcome, MapCaptureRunError | MapCaptureStorageError> {
	return Effect.scoped(
		Effect.gen(function* () {
			const captureBackend = args.options.captureBackend ?? "lit_camera_tiles";
			const plan =
				"plan" in args.options
					? args.options.plan
					: yield* args.repository.loadPlan(args.options.planPath);
			const backendIssue = mapCaptureBackendIssue(plan, captureBackend);
			if (backendIssue !== undefined)
				return yield* new MapCaptureRunError({
					message: backendIssue,
					operation: "prepare",
					recovery:
						"Update the plan's render settings or select a compatible capture backend."
				});
			const projectRoot = yield* validateMapCaptureProjectRoot(args.options.projectRoot);
			const inspected = yield* inspectMapCapturePlan(plan);
			const keys = yield* selectedTileKeys({
				grid: inspected.grid,
				...(args.options.levels === undefined
					? undefined
					: { levels: args.options.levels }),
				...(args.options.tiles === undefined ? undefined : { tiles: args.options.tiles })
			});
			const runId = yield* Schema.decodeUnknownEffect(MapCaptureRunId)(
				args.options.runId ?? randomUUID()
			).pipe(
				Effect.mapError(
					(cause) =>
						new MapCaptureRunError({
							message: String(cause),
							operation: "prepare",
							recovery: "Use a safe run identity of at most 128 characters."
						})
				)
			);
			const correlationId = yield* Schema.decodeUnknownEffect(MapCaptureOperationId)(
				args.options.correlationId ?? runId
			).pipe(
				Effect.mapError(
					(cause) =>
						new MapCaptureRunError({
							message: String(cause),
							operation: "prepare",
							recovery: "Use a safe correlation identity of at most 128 characters.",
							runId
						})
				)
			);
			const destination =
				args.options.destination ?? projectLocalMapCaptureDestination(projectRoot);
			const release = args.port.release;
			if (captureBackend === "lit_camera_tiles" && release !== undefined) {
				yield* Effect.addFinalizer(() =>
					release(runId).pipe(
						Effect.tapError((error) =>
							Effect.logError(
								"Map capture release failed; the editor lease will restore state.",
								error
							)
						),
						Effect.orElseSucceed(() => undefined)
					)
				);
			}
			const unrealStagingRoot = resolve(projectRoot, "Saved", "UEShed", "MapTileStaging");
			const attempt = yield* destination.prepare({ planId: plan.id, runId });
			yield* Effect.addFinalizer(() =>
				attempt.discard().pipe(Effect.orElseSucceed(() => undefined))
			);
			const startedAt = isoNow(yield* Clock.currentTimeMillis);

			const captured: Array<MapTilePyramidManifestValue["tiles"][number]> = [];
			const failures: Array<MapTilePyramidManifestValue["failures"][number]> = [];
			let cancelled = false;
			const tileBatches =
				captureBackend === "viewport_high_resolution"
					? yield* viewportLevelBatches({ grid: inspected.grid, keys })
					: batches(
							keys,
							captureBackend === "lit_camera_tiles"
								? litCameraTilesPerBatch
								: maximumTilesPerRequest
						);
			yield* (
				args.options.onProgress?.({
					failedTiles: 0,
					phase: "capturing",
					processedTiles: 0,
					totalTiles: keys.length
				}) ?? Effect.void
			);
			const captureBatch = Effect.fn("MapCapture.captureBatch")(function* (input: {
				readonly batch: ReadonlyArray<MapTileKey>;
				readonly batchIndex: number;
			}) {
				const request = makeRequest({
					batch: input.batch,
					captureBackend,
					correlationId,
					grid: inspected.grid,
					operationId: randomUUID(),
					plan,
					runId
				});
				return yield* args.port.capture(request).pipe(
					Effect.mapError(
						(cause) =>
							new MapCaptureRunError({
								message: String(cause),
								operation: "capture",
								recovery:
									"Reconnect to the expected editor map and retry this run or tile subset.",
								runId
							})
					),
					Effect.withSpan("camera.map_tile.capture_batch", {
						attributes: {
							"camera.map_tile.batch.index": input.batchIndex,
							"camera.map_tile.batch.tiles": input.batch.length
						}
					})
				);
			});
			const ingestBatch = Effect.fn("MapCapture.ingestBatch")(
				(input: {
					readonly batch: ReadonlyArray<MapTileKey>;
					readonly batchIndex: number;
					readonly response: MapTileCaptureResponse;
				}) =>
					Effect.gen(function* () {
						const { batch, response } = input;
						const resultByKey = new Map(
							response.results.map((result) => [mapTileKeyId(result.key), result])
						);
						if (response.status === "cancelled") cancelled = true;
						for (const key of batch) {
							const result = resultByKey.get(mapTileKeyId(key));
							if (!result) {
								failures.push({
									failure:
										response.failure ??
										captureFailure({
											code: "invalid_request",
											message:
												"Editor response did not inventory the requested tile.",
											retrySafe: false
										}),
									key
								});
								continue;
							}
							if (result.status === "failed") {
								failures.push({ failure: result.failure, key });
								continue;
							}
							if (
								response.dirtyState.before !== response.dirtyState.after ||
								response.actualMapPath !== plan.project.mapPath
							) {
								failures.push({
									failure: captureFailure({
										code: "dirty_state_changed",
										message:
											"Editor map identity or package dirty state changed during capture.",
										retrySafe: false
									}),
									key
								});
								continue;
							}
							const relativePath = mapTileRelativePath(key);
							const stored = yield* attempt
								.storeTile({
									relativePath,
									sourceAuthorizationRoot: projectRoot,
									sourcePath: result.stagedPath,
									sourceRoot: unrealStagingRoot
								})
								.pipe(
									Effect.catchTag(
										"MapCaptureArtifactSourceRejected",
										(cause: MapCaptureArtifactSourceRejected) =>
											Effect.succeed(cause)
									)
								);
							if (stored instanceof MapCaptureArtifactSourceRejected) {
								failures.push({
									failure: captureFailure({
										code: "write_failed",
										message: stored.message,
										retrySafe: false
									}),
									key
								});
								continue;
							}
							const bytes = stored;
							const dimensions = yield* Effect.try({
								try: () => readPngDimensions(bytes),
								catch: (cause) =>
									new MapCaptureRunError({
										message: String(cause),
										operation: "capture",
										recovery:
											"Quarantine the invalid staged artifact and retry its tile.",
										runId
									})
							});
							if (
								dimensions.width !== plan.tilePixelSize ||
								dimensions.height !== plan.tilePixelSize
							) {
								failures.push({
									failure: captureFailure({
										code: "write_failed",
										message:
											"Staged PNG dimensions do not match the fixed tile pixel size.",
										retrySafe: true
									}),
									key
								});
								continue;
							}
							captured.push({
								bytes: bytes.byteLength,
								hash: sha256(bytes),
								height: dimensions.height,
								key,
								relativePath,
								width: dimensions.width,
								worldBounds: mapTileWorldBounds(inspected.grid, key)
							});
						}
						yield* (
							args.options.onProgress?.({
								failedTiles: failures.length,
								phase: "capturing",
								processedTiles: captured.length + failures.length,
								totalTiles: keys.length
							}) ?? Effect.void
						);
					}).pipe(
						Effect.withSpan("camera.map_tile.ingest_batch", {
							attributes: {
								"camera.map_tile.batch.index": input.batchIndex,
								"camera.map_tile.batch.tiles": input.batch.length
							}
						})
					)
			);
			const capturedBatches = Stream.paginate(0, (batchIndex) => {
				const batch = tileBatches[batchIndex];
				if (batch === undefined) {
					return Effect.succeed([[], Option.none<number>()] as const);
				}
				return captureBatch({ batch, batchIndex }).pipe(
					Effect.map((response) => {
						const hasNext = tileBatches[batchIndex + 1] !== undefined;
						return [
							[{ batch, batchIndex, response }],
							response.status !== "cancelled" && hasNext
								? Option.some(batchIndex + 1)
								: Option.none<number>()
						] as const;
					})
				);
			}).pipe(Stream.buffer({ capacity: 1, strategy: "suspend" }));
			yield* capturedBatches.pipe(Stream.runForEach(ingestBatch));
			yield* (
				args.options.onProgress?.({
					failedTiles: failures.length,
					phase: "publishing",
					processedTiles: captured.length + failures.length,
					totalTiles: keys.length
				}) ?? Effect.void
			);

			const selectedAllTiles = keys.length === inspected.tileCount;
			const state = cancelled
				? "cancelled"
				: failures.length === 0 && selectedAllTiles
					? "complete"
					: "partial";
			const manifest = yield* decodeMapTilePyramidManifest({
				addressing: {
					children: "z+1: (2r,2c),(2r,2c+1),(2r+1,2c),(2r+1,2c+1)",
					parent: "z-1: (floor(r/2),floor(c/2))",
					path: "Z{zoom:02}/R{row:03}_C{column:03}.png"
				},
				capturePolicy: plan.capture,
				completedAt: isoNow(yield* Clock.currentTimeMillis),
				contract: { name: "ue-shed-map-tile-pyramid", version: { major: 1, minor: 0 } },
				failures,
				grid: {
					orientation: {
						name: "rows_max_x_to_min_x_columns_min_y_to_max_y",
						version: 1
					},
					origin: inspected.grid.origin,
					requestedBounds: inspected.grid.requestedBounds,
					snappedBounds: inspected.grid.snappedBounds
				},
				gutter: {
					pixels: plan.gutterPixels,
					rule: "render_overdraw_then_crop",
					textureAddress: "clamp_to_edge"
				},
				levels: inspected.grid.levels,
				planId: plan.id,
				project: plan.project,
				provenance: {
					producer:
						captureBackend === "lit_camera_tiles"
							? "unreal-editor-lit-camera-tiles"
							: captureBackend === "viewport_high_resolution"
								? "unreal-editor-viewport-high-resolution-experimental"
								: "unreal-editor",
					tool: "ue-shed",
					toolVersion: CAMERAS_PACKAGE_VERSION
				},
				runId: MapCaptureRunId.make(runId),
				startedAt,
				state,
				tilePixelSize: plan.tilePixelSize,
				tiles: captured
			}).pipe(
				Effect.mapError(
					(cause) =>
						new MapCaptureRunError({
							message: String(cause),
							operation: "publish",
							recovery:
								"Inspect grid and artifact inventory invariants before retrying.",
							runId
						})
				)
			);
			if (manifest.state === "complete") {
				const manifestPath = yield* attempt.publish(manifest).pipe(Effect.uninterruptible);
				return {
					manifest,
					manifestPath,
					published: true
				};
			}
			const manifestPath = yield* attempt.retain(manifest).pipe(Effect.uninterruptible);
			return { manifest, manifestPath, published: false };
		}).pipe(
			Effect.withSpan("camera.map_tile.run", {
				attributes: {
					"camera.map_tile.batch.maximum": maximumTilesPerRequest,
					"camera.map_tile.capture_backend":
						args.options.captureBackend ?? "lit_camera_tiles"
				}
			})
		)
	);
}

export interface MapCaptureApi {
	readonly inspect: (
		plan: MapCapturePlan
	) => Effect.Effect<InspectMapCapturePlanResult, MapCaptureRunError>;
	readonly run: (
		options: RunMapCaptureOptions | RunMapCapturePlanOptions
	) => Effect.Effect<MapCaptureRunOutcome, MapCaptureRunError | MapCaptureStorageError>;
}

/** @deprecated Use `MapCaptureApi`. */
export type MapCaptureShape = MapCaptureApi;

export class MapCapture extends Context.Service<MapCapture, MapCaptureApi>()(
	"@ue-shed/cameras/MapCapture"
) {}

export const MapCaptureLive = Layer.effect(
	MapCapture,
	Effect.gen(function* () {
		const repository = yield* MapCaptureRepository;
		const port = yield* MapTileCapturePort;
		return MapCapture.of({
			inspect: Effect.fn("MapCapture.inspect")(inspectMapCapturePlan),
			run: Effect.fn("MapCapture.run")((options) =>
				runMapCaptureWith({ options, port, repository })
			)
		});
	})
);

export function runMapCapture(
	options: RunMapCaptureOptions
): Effect.Effect<MapCaptureRunOutcome, MapCaptureRunError | MapCaptureStorageError> {
	const remoteClient = Layer.sync(RemoteControlClient, () =>
		makeRemoteControlClient({ defaultTimeout: "5 minutes" })
	);
	return Effect.flatMap(MapCapture, (service) => service.run(options)).pipe(
		Effect.provide(MapCaptureLive),
		Effect.provide(MapCaptureRepositoryLive),
		Effect.provide(mapTileCaptureRemotePortLayer(options.endpoint)),
		Effect.provide(remoteClient)
	);
}

export function runMapCapturePlan(
	options: RunMapCapturePlanOptions
): Effect.Effect<MapCaptureRunOutcome, MapCaptureRunError | MapCaptureStorageError> {
	const remoteClient = Layer.sync(RemoteControlClient, () =>
		makeRemoteControlClient({ defaultTimeout: "5 minutes" })
	);
	return Effect.flatMap(MapCapture, (service) => service.run(options)).pipe(
		Effect.provide(MapCaptureLive),
		Effect.provide(MapCaptureRepositoryLive),
		Effect.provide(mapTileCaptureRemotePortLayer(options.endpoint)),
		Effect.provide(remoteClient)
	);
}
