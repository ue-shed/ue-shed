import {
	NiagaraPreviewRunManifest,
	makeNiagaraPreviewTestLayer,
	type NiagaraPreviewError,
	type NiagaraPreviewRunOutcome,
	type RunNiagaraPreviewOptions
} from "@ue-shed/niagara";
import { it } from "@effect/vitest";
import {
	makeAssetReaderTestLayer,
	type AssetReaderError,
	type AssetReaderTestApi,
	type SavedAssetScan,
	type SavedAssetScanOptions
} from "@ue-shed/unreal-assets";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import {
	makeWorkbenchConfiguration,
	makeWorkbenchConfigurationLayer
} from "../workbench-config.js";
import { WorkbenchNiagaraPreview, WorkbenchNiagaraPreviewLive } from "./niagara-preview.js";
import { WorkbenchProjectUnavailable, makeWorkbenchProjectTestLayer } from "./project-workspace.js";

const fixtureManifestUrl = new URL(
	"../../../../../packages/protocol/contracts/niagara/preview/v1/fixtures/manifest.json",
	import.meta.url
);

function configuration(sourceCheckout: string | undefined) {
	return makeWorkbenchConfigurationLayer(
		makeWorkbenchConfiguration({
			authoringAsset: Option.none(),
			authoringSessionRoot: Option.none(),
			expectedProjectName: Option.none(),
			projectRoot: Option.none(),
			remoteControlEndpoint: "http://127.0.0.1:30001",
			repositoryRoot:
				sourceCheckout === undefined ? Option.none() : Option.some(sourceCheckout),
			reviewSet: Option.none(),
			textureAuditRules: Option.none()
		})
	);
}

function project(
	projectRoot: string,
	options?: {
		readonly candidates?: () => Effect.Effect<SavedAssetScan, WorkbenchProjectUnavailable>;
		readonly currentStatus?: "ready" | "not_configured";
	}
) {
	return makeWorkbenchProjectTestLayer({
		choose: () => Effect.die("not used"),
		current: () =>
			Effect.succeed(
				options?.currentStatus === "not_configured"
					? { status: "not_configured" as const }
					: {
							project: {
								inputAtlas: "deferred" as const,
								mapCount: 0,
								packageCount: 0,
								projectName: "Fixture",
								projectRoot
							},
							status: "ready" as const
						}
			),
		candidates:
			options?.candidates ??
			(() => Effect.die("project candidates are not used by this test")),
		inputAtlas: () => Effect.die("not used"),
		savedProject: () => Effect.die("not used"),
		savedTables: () => Effect.die("not used"),
		selectedProject: () => Effect.succeed({ projectName: "Fixture", projectRoot })
	});
}

const unusedReader = (operation: string) =>
	Effect.die(new Error(`Unexpected AssetReader ${operation} call`));

function serviceLayer(options: {
	readonly projectRoot: string;
	readonly run: (
		input: RunNiagaraPreviewOptions
	) => Effect.Effect<NiagaraPreviewRunOutcome, NiagaraPreviewError>;
	readonly scanProject?: (
		request: SavedAssetScanOptions
	) => Effect.Effect<SavedAssetScan, AssetReaderError>;
	readonly sourceCheckout?: string;
	readonly candidates?: () => Effect.Effect<SavedAssetScan, WorkbenchProjectUnavailable>;
	readonly currentStatus?: "ready" | "not_configured";
}) {
	const reader: AssetReaderTestApi = {
		discoverAssets: () => unusedReader("discoverAssets"),
		discoverTables: () => unusedReader("discoverTables"),
		readAsset: () => unusedReader("readAsset"),
		readTable: () => unusedReader("readTable"),
		scanProject:
			options.scanProject ??
			(() => Effect.die(new Error("Unexpected AssetReader scanProject call"))),
		source: () => Effect.succeed("configured")
	};
	return WorkbenchNiagaraPreviewLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				configuration(options.sourceCheckout),
				project(options.projectRoot, options),
				makeNiagaraPreviewTestLayer(options.run),
				makeAssetReaderTestLayer(reader)
			)
		)
	);
}

function headerEntry(
	path: string,
	packageName: string,
	objectPath: string
): SavedAssetScan["assets"][number] {
	return {
		depth: "header" as const,
		fileBytes: 0,
		header: {
			exports: [{ class_path: "/Script/Niagara.NiagaraSystem", object_path: objectPath }],
			package: { name: packageName },
			path,
			schema_version: 8 as const
		}
	};
}

it.effect("composes the selected project with a matching staged source-checkout plugin", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-niagara-workbench-"))),
				(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
			);
			const projectRoot = join(root, "Project");
			const sourceCheckout = join(root, "Source");
			const descriptor = join(projectRoot, "Fixture.uproject");
			const stagedPlugin = join(
				sourceCheckout,
				"out",
				"workbench-plugin-host",
				"5.7",
				"RuntimePlugins",
				"UEShedNiagara",
				"UEShedNiagara.uplugin"
			);
			yield* Effect.promise(() =>
				Promise.all([
					mkdir(projectRoot, { recursive: true }),
					mkdir(dirname(stagedPlugin), { recursive: true })
				]).then(() =>
					Promise.all([
						writeFile(descriptor, JSON.stringify({ EngineAssociation: "5.7" })),
						writeFile(stagedPlugin, "{}")
					])
				)
			);
			const manifest = yield* Effect.promise(() => readFile(fixtureManifestUrl, "utf8")).pipe(
				Effect.map(JSON.parse),
				Effect.flatMap(Schema.decodeUnknownEffect(NiagaraPreviewRunManifest))
			);
			const captured = yield* Ref.make<RunNiagaraPreviewOptions | undefined>(undefined);
			const layer = serviceLayer({
				projectRoot,
				sourceCheckout,
				run: (input) =>
					Ref.set(captured, input).pipe(
						Effect.as({ manifest, manifestPath: join(root, "manifest.json") })
					)
			});
			const result = yield* Effect.flatMap(WorkbenchNiagaraPreview, (service) =>
				service.run({
					settings: { frameCount: 2, height: 64, width: 64 },
					systemObjectPath: manifest.systemObjectPath
				})
			).pipe(Effect.provide(layer));
			expect(result.status).toBe("completed");
			expect(yield* Ref.get(captured)).toMatchObject({
				pluginDescriptor: stagedPlugin,
				projectDescriptor: descriptor,
				systemObjectPath: manifest.systemObjectPath
			});
		})
	)
);

it.effect("returns a frame only while its bytes match the immutable manifest", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const projectRoot = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-niagara-frame-"))),
				(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
			);
			const fixtureUnknown: unknown = JSON.parse(
				yield* Effect.promise(() => readFile(fixtureManifestUrl, "utf8"))
			);
			const fixture =
				yield* Schema.decodeUnknownEffect(NiagaraPreviewRunManifest)(fixtureUnknown);
			const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
			const artifact = fixture.artifacts[0];
			if (artifact === undefined) return yield* Effect.die("fixture has no artifact");
			const manifest = yield* Schema.decodeUnknownEffect(NiagaraPreviewRunManifest)({
				...fixture,
				artifacts: [
					{
						...artifact,
						bytes: bytes.byteLength,
						sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
					}
				]
			});
			const runRoot = join(
				projectRoot,
				".ue-shed",
				"niagara-preview",
				"runs",
				manifest.runId
			);
			const manifestPath = join(runRoot, "manifest.json");
			const framePath = join(runRoot, "frames", "frame_0000.png");
			yield* Effect.promise(() =>
				mkdir(join(runRoot, "frames"), { recursive: true }).then(() =>
					Promise.all([
						writeFile(manifestPath, JSON.stringify(manifest)),
						writeFile(framePath, bytes)
					])
				)
			);
			const layer = serviceLayer({
				projectRoot,
				run: () => Effect.die("run is not used")
			});
			const load = Effect.flatMap(WorkbenchNiagaraPreview, (service) =>
				service.frame({
					manifestPath,
					relativePath: artifact.relativePath
				})
			).pipe(Effect.provide(layer));
			const ready = yield* load;
			expect(ready).toEqual({ bytes, status: "ready" });

			yield* Effect.promise(() => writeFile(framePath, new Uint8Array([1, 2, 3])));
			const tampered = yield* load;
			expect(tampered.status).toBe("failed");
			if (tampered.status === "failed") {
				expect(tampered.error.code).toBe("artifact_invalid");
				expect(tampered.error.message).toContain("immutable manifest");
			}
		})
	)
);

it.effect("catalogues every saved Niagara System in the selected project", () =>
	Effect.gen(function* () {
		const projectRoot = "C:/Projects/Fixture";
		const capturedRequests: SavedAssetScanOptions[] = [];
		const layer = serviceLayer({
			candidates: () =>
				Effect.succeed({
					assets: [
						headerEntry(
							"Content/FX/NS_Foo.uasset",
							"/Game/FX/NS_Foo",
							"/Game/FX/NS_Foo.NS_Foo"
						),
						headerEntry(
							"Content/FX/NS_Bar.uasset",
							"/Game/FX/NS_Bar",
							"/Game/FX/NS_Bar.NS_Bar"
						)
					],
					failures: [],
					summary: {
						cacheHits: 0,
						depth: "header",
						diagnostics: [],
						emittedAssets: 2,
						failedAssets: 0,
						partialAssets: 0,
						projectRoot,
						roots: [],
						scannedAssets: 2,
						schema_version: 8,
						skippedAssets: 0
					}
				}),
			projectRoot,
			run: () => Effect.die("run is not used"),
			scanProject: (request) => {
				capturedRequests.push(request);
				return Effect.succeed({
					assets: [
						{
							depth: "header" as const,
							fileBytes: 0,
							header: {
								exports: [
									{
										class_path: "/Script/Niagara.NiagaraSystem",
										object_path: "/Game/FX/NS_Foo.NS_Foo"
									},
									{
										class_path: "/Script/Niagara.NiagaraSystem",
										object_path: "/Game/FX/NS_Foo.NS_GrassHit_Lv2-3"
									},
									{
										class_path: "/Script/Niagara.NiagaraSystem",
										object_path: "malformed without an object name"
									},
									{
										class_path: "/Script/Engine.Texture2D",
										object_path: "/Game/FX/NS_Foo.T_Noise"
									}
								],
								package: { name: "/Game/FX/NS_Foo" },
								path: "Content/FX/NS_Foo.uasset",
								schema_version: 8 as const
							}
						},
						{
							depth: "header" as const,
							fileBytes: 0,
							header: {
								exports: [
									{
										class_path: "/Script/Niagara.NiagaraSystem",
										object_path: "/Game/FX/NS_Bar.NS_Bar"
									}
								],
								package: { name: "/Game/FX/NS_Bar" },
								path: "Content/FX/NS_Bar.uasset",
								schema_version: 8 as const
							}
						}
					],
					failures: [],
					summary: {
						cacheHits: 0,
						depth: "header",
						diagnostics: [],
						emittedAssets: 2,
						failedAssets: 0,
						partialAssets: 0,
						projectRoot,
						roots: [],
						scannedAssets: 2,
						schema_version: 8,
						skippedAssets: 0
					}
				});
			}
		});
		const result = yield* Effect.flatMap(WorkbenchNiagaraPreview, (service) =>
			service.catalogue()
		).pipe(Effect.provide(layer));
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.entries.map((entry) => entry.objectPath)).toEqual([
			"/Game/FX/NS_Bar.NS_Bar",
			"/Game/FX/NS_Foo.NS_Foo",
			"/Game/FX/NS_Foo.NS_GrassHit_Lv2-3"
		]);
		expect(capturedRequests).toHaveLength(1);
		expect(capturedRequests[0]).toMatchObject({
			classes: ["/Script/Niagara.NiagaraSystem"],
			depth: "header",
			paths: ["Content/FX/NS_Bar.uasset", "Content/FX/NS_Foo.uasset"],
			projectRoot
		});
	})
);

it.effect("reports a missing project instead of listing systems", () =>
	Effect.gen(function* () {
		const layer = serviceLayer({
			currentStatus: "not_configured",
			projectRoot: "C:/Projects/Fixture",
			run: () => Effect.die("run is not used")
		});
		const result = yield* Effect.flatMap(WorkbenchNiagaraPreview, (service) =>
			service.catalogue()
		).pipe(Effect.provide(layer));
		expect(result).toEqual({ status: "not_configured" });
	})
);

it.effect("maps candidate failures to typed catalogue failures", () =>
	Effect.gen(function* () {
		const layer = serviceLayer({
			candidates: () =>
				Effect.fail(
					new WorkbenchProjectUnavailable({
						message: "Project Index returned a page from a different generation.",
						recovery: "Refresh the Project Index, then retry."
					})
				),
			projectRoot: "C:/Projects/Fixture",
			run: () => Effect.die("run is not used")
		});
		const result = yield* Effect.flatMap(WorkbenchNiagaraPreview, (service) =>
			service.catalogue()
		).pipe(Effect.provide(layer));
		expect(result).toEqual({
			error: {
				message: "Project Index returned a page from a different generation.",
				recovery: "Refresh the Project Index, then retry."
			},
			status: "failed"
		});
	})
);
