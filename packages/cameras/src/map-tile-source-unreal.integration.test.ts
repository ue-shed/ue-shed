import { randomUUID } from "node:crypto";
import { Effect, Layer, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RemoteControlClient, RemoteControlClientLive } from "@ue-shed/unreal-connection";
import {
	CameraRenderer,
	CameraFrameOperationId,
	CameraRenderSessionId,
	CameraRenderCapabilitiesV1,
	cameraRenderContract,
	cameraRendererLayer,
	readCameraFrameArtifact,
	type CameraRenderSessionRequest
} from "./index.js";
import { createMapTileGrid } from "./map-tile-pyramid.js";
import { createMapTileSource, planMapTileSources, type MapTileSource } from "./map-tile-source.js";

const decodeCameraRenderCapabilitiesV1 = Schema.decodeUnknownEffect(CameraRenderCapabilitiesV1);
const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const projectRoot = process.env.UE_SHED_RENDER_FIXTURE_ROOT;
const mapPath = process.env.UE_SHED_RENDER_FIXTURE_MAP_PATH ?? "/Game/Fixture/Cameras/L_CameraLoad";
const projectName = process.env.UE_SHED_RENDER_FIXTURE_PROJECT_NAME ?? "UEShedFixture";

describe.skipIf(!endpoint || !projectRoot)("composable map sources in a rendering editor", () => {
	it("renders caller-selected 4K, 1K and rectangular sources in one restored session", async () => {
		const grid = createMapTileGrid({
			requestedBounds: { minX: -1024, minY: -1024, maxX: 1024, maxY: 1024 },
			tilePixelSize: 1024,
			coarsestUnitsPerPixel: 2,
			levelCount: 3
		});
		const request: CameraRenderSessionRequest = {
			contract: cameraRenderContract,
			sessionId: CameraRenderSessionId.make(randomUUID()),
			expectedMapPath: mapPath,
			expectedProjectName: projectName,
			leaseMs: 120000,
			maximumFrames: 3,
			policy: {
				renderer: {
					kind: "editor_viewport",
					strategy: "high_resolution_screenshot",
					profile: "lit",
					vignette: "disabled",
					fog: false,
					volumetricFog: false,
					screenshotWarmupFrames: 32
				},
				exposure: { mode: "fixed_ev100", ev100: 8, compensation: "project" },
				settling: { minimumFrames: 4, timeoutMs: 120000 },
				time: "freeze_materials_and_ticks",
				preparation: { geometry: { mode: "preserve_loading" }, dataLayers: [] }
			}
		};
		const layer = cameraRendererLayer(endpoint!).pipe(
			Layer.provideMerge(RemoteControlClientLive)
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const renderer = yield* CameraRenderer;
				const capabilities = yield* renderer.capabilities();
				expect(capabilities.highResolutionScreenshot?.maximumWarmupFrames).toBe(256);
				const client = yield* RemoteControlClient;
				const previousSdkCapabilities = yield* client
					.request({
						endpoint: endpoint!,
						objectPath:
							"/Script/UEShedCamerasEditor.Default__UEShedCameraRenderingLibrary",
						functionName: "GetCameraRenderCapabilities",
						parameters: {},
						operation: "camera.render.legacy-capabilities"
					})
					.pipe(
						Effect.flatMap((value) =>
							decodeCameraRenderCapabilitiesV1(value, {
								onExcessProperty: "error"
							})
						)
					);
				expect(previousSdkCapabilities).not.toHaveProperty("highResolutionScreenshot");
				const capability = capabilities.renderers.find(
					(entry) => entry.kind === "editor_viewport"
				);
				if (!capability)
					throw new Error("The fixture must support editor-viewport rendering.");
				const settings = {
					captureZ: 1500,
					gutterPixels: 16,
					limits: {
						maximumDimension: capability.maximumDimension,
						maximumDecodedBytes: 128 * 1024 * 1024
					}
				};
				const sources: MapTileSource[] = [];
				for (const tilesPerSourceSide of [4, 1]) {
					const layout = yield* Effect.fromResult(
						planMapTileSources({
							grid,
							options: { ...settings, zoom: 2, tilesPerSourceSide }
						})
					);
					const first = layout.sources[Symbol.iterator]().next().value;
					if (!first) throw new Error("Expected a source descriptor.");
					sources.push(first);
				}
				sources.push(
					yield* Effect.fromResult(
						createMapTileSource({
							grid,
							settings,
							block: {
								firstTile: { zoom: 2, row: 1, column: 1 },
								rows: 2,
								columns: 3
							}
						})
					)
				);
				expect(sources.map((source) => source.size)).toEqual([
					{ width: 4128, height: 4128 },
					{ width: 1056, height: 1056 },
					{ width: 3104, height: 2080 }
				]);
				const tooLarge = planMapTileSources({
					grid,
					options: {
						...settings,
						zoom: 2,
						tilesPerSourceSide: 4,
						limits: { ...settings.limits, maximumDimension: 4096 }
					}
				});
				expect(Result.isFailure(tooLarge)).toBe(true);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const session = yield* renderer.open(request);
						for (const source of sources) {
							const frame = yield* session.capture({
								contract: cameraRenderContract,
								sessionId: session.id,
								operationId: CameraFrameOperationId.make(randomUUID()),
								camera: source.camera,
								size: source.size
							});
							const artifact = yield* readCameraFrameArtifact({
								projectRoot: projectRoot!,
								frame
							});
							expect(frame.evidence.camera).toEqual(source.camera);
							expect(frame.evidence.policy).toEqual(request.policy);
							expect(frame.evidence.settling.renderedFrames).toBeGreaterThanOrEqual(
								4
							);
							expect(frame.evidence.editorState.mapPackageDirtyAfter).toBe(
								frame.evidence.editorState.mapPackageDirtyBefore
							);
							const header = new DataView(
								artifact.bytes.buffer,
								artifact.bytes.byteOffset,
								artifact.bytes.byteLength
							);
							expect(header.getUint32(16)).toBe(source.size.width);
							expect(header.getUint32(20)).toBe(source.size.height);
						}
					})
				);
				expect(
					yield* renderer.preflight({
						...request,
						sessionId: CameraRenderSessionId.make(randomUUID())
					})
				).toEqual({ status: "ready", issues: [] });
			}).pipe(Effect.provide(layer))
		);
	}, 180000);
});
