// Real HTTP acceptance of the shared durable ID-repair workflow against installed release binaries.
// The caller must hold the machine Unreal lock. Commandlets only create the disposable baseline.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Duration, Effect, Layer, Schema, Stream } from "effect";
import { OwnedProcessTree, OwnedProcessTreeLive } from "../packages/engine/dist/index.js";
import {
	CompiledPluginBuildResult,
	PluginDistribution,
	localPluginReleaseSourceLayer,
	pluginDistributionLayer,
	pluginStoreLayer
} from "../packages/plugin-distribution/dist/index.js";
import {
	RemoteControlClient,
	RemoteControlClientLive,
	inspectUnrealProducer
} from "../packages/unreal-connection/dist/index.js";
import {
	assetReaderLayer,
	extractProjectTextPackages
} from "../packages/unreal-assets/dist/index.js";
import { makeGameTextIdRepairs } from "../packages/game-text/src/workspace-id-repairs.ts";
import { textOccurrenceFromExtraction } from "../packages/game-text/src/corpus.ts";
import { makeTextUnitId } from "../packages/game-text/src/identifiers.ts";
import { TextIdRepairRequest } from "../packages/game-text/src/id-repair-schema.ts";
import { textIdRepairPlace } from "../packages/game-text/src/id-repair.ts";
import {
	verifyGameTextActions,
	gameTextActionsRequest
} from "../packages/game-text/src/text-actions.ts";
import type { TextCorpusFocus } from "../packages/game-text/src/schema.ts";
import { ensureUassetExecutable } from "./native-tools.ts";
import {
	runProcess,
	unrealEngineTools,
	localDerivedDataCacheArguments
} from "./unreal-plugin-host.ts";
import { unrealRemoteControlLaunchArguments } from "./workbench-tools.ts";

const [engineArgument, outputArgument] = process.argv.slice(2);
assert.ok(engineArgument && outputArgument);
const engineRoot = resolve(engineArgument);
const output = resolve(outputArgument);
const repository = resolve(import.meta.dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const record = <A>(name: string, value: A) =>
	writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
const built = Schema.decodeUnknownSync(CompiledPluginBuildResult)(
	readJson(join(output, "build-result.json"))
);
const legacy = built.manifest.compatibility.target === "UE4Editor";
const fixtureName = legacy ? "UEShedLegacyFixture" : "UEShedFixture";
const fixture = join(repository, "fixtures", legacy ? "legacy-unreal-project" : "unreal-project");
const project = join(output, "project");
const projectFile = join(project, `${fixtureName}.uproject`);
const tools = unrealEngineTools(engineRoot);
if (!existsSync(projectFile)) {
	cpSync(fixture, project, {
		recursive: true,
		filter: (source) => {
			const path = relative(fixture, source).split(sep).join("/");
			// Committed fixture packages/localization may be newer than the selected engine.
			// Generate this lane's complete content with that engine instead of loading them.
			if (path === "Content") return false;
			if (
				["Binaries", "Intermediate", "Saved", "DerivedDataCache", "Generated"].includes(
					path.split("/")[0] ?? ""
				)
			)
				return false;
			// Other UE5 fixture generators depend on newer optional editor APIs. This lane builds
			// only its baseline generator, while retaining the matching project's runtime module.
			return (
				legacy ||
				!/^Source\/UEShedFixtureEditor\/.*\.(?:cpp|h)$/u.test(path) ||
				path.endsWith("/UEShedFixtureEditor.cpp")
			);
		}
	});
	if (!legacy) {
		// Reuse the repository's nine-place baseline inside the matching UE5 fixture project.
		// Only the export macro changes to the owning UE5 fixture module; plugin code is untouched.
		for (const [from, to] of [
			[
				"UEShedLegacyFixture/Public/UEShedLegacyFixtureTypes.h",
				"UEShedFixture/Public/UEShedLegacyFixtureTypes.h"
			],
			[
				"UEShedLegacyFixtureEditor/Public/UEShedLegacyTextActionsCommandlet.h",
				"UEShedFixtureEditor/Public/UEShedLegacyTextActionsCommandlet.h"
			],
			[
				"UEShedLegacyFixtureEditor/Private/UEShedLegacyTextActionsCommandlet.cpp",
				"UEShedFixtureEditor/Private/UEShedLegacyTextActionsCommandlet.cpp"
			]
		]) {
			const destination = join(project, "Source", to!);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(
				destination,
				readFileSync(
					join(repository, "fixtures/legacy-unreal-project/Source", from!),
					"utf8"
				).replaceAll("UESHEDLEGACYFIXTURE_API", "UESHEDFIXTURE_API")
			);
		}
		record("fixture-instrumentation.json", {
			source: "fixtures/legacy-unreal-project/Source",
			purpose: "Reuse exact nine-place baseline in UE5 fixture modules",
			exportMacro: "UESHEDFIXTURE_API",
			editorSources:
				"Module entrypoint and nine-place baseline only; unrelated fixture generators excluded",
			content: "All baseline packages freshly generated by the selected engine"
		});
	}
	runProcess(tools.build, [
		`${fixtureName}Editor`,
		"Win64",
		"Development",
		`-Project=${projectFile}`,
		"-NoEngineChanges",
		"-NoHotReloadFromIDE",
		"-WaitMutex"
	]);
}
const baselinePath = join(output, "baseline.json");
if (!existsSync(baselinePath)) {
	const generated = spawnSync(
		tools.editorCommandlet,
		[
			projectFile,
			"-run=UEShedLegacyTextActions",
			"-Create",
			`-Evidence=${baselinePath}`,
			"-Unattended",
			"-SCCProvider=None",
			...localDerivedDataCacheArguments,
			"-NullRHI",
			"-NoSound",
			"-NoSplash",
			`-abslog=${join(output, "baseline.log")}`
		],
		{ encoding: "utf8", windowsHide: true, timeout: 600_000 }
	);
	record("baseline-process.json", {
		status: generated.status,
		stdout: generated.stdout,
		stderr: generated.stderr
	});
	assert.equal(generated.status, 0);
}
const Place = Schema.Struct({
	kind: Schema.String,
	operation: Schema.String,
	packageFile: Schema.String,
	propertyPath: Schema.String,
	row: Schema.optionalKey(Schema.String)
});
const places = Schema.decodeUnknownSync(Schema.Struct({ places: Schema.Array(Place) }))(
	readJson(baselinePath)
).places.filter((place) => place.kind !== "graph_pin");
assert.equal(places.length, 6);
const files = [...new Set(places.map((place) => place.packageFile))];
const reader = assetReaderLayer({ executable: ensureUassetExecutable() });
const wire = Layer.effect(
	RemoteControlClient,
	Effect.gen(function* () {
		const client = yield* RemoteControlClient;
		let sequence = 0;
		return RemoteControlClient.of({
			request: (request) => {
				const id = ++sequence;
				record(`wire-${String(id).padStart(3, "0")}-request.json`, request);
				return client.request(request).pipe(
					Effect.tap((response) =>
						Effect.sync(() =>
							record(`wire-${String(id).padStart(3, "0")}-response.json`, {
								response
							})
						)
					)
				);
			}
		});
	})
).pipe(Layer.provide(RemoteControlClientLive));
const distribution = pluginDistributionLayer().pipe(
	Layer.provide(
		Layer.merge(
			localPluginReleaseSourceLayer({
				manifestPath: built.manifestPath,
				artifactPath: built.artifactPath
			}),
			pluginStoreLayer({ cacheRoot: join(output, "cache") })
		)
	)
);
const endpoint = process.env.UE_SHED_ACCEPTANCE_ENDPOINT ?? "http://127.0.0.1:30180";
const port = Number(new URL(endpoint).port);
const io = <A>(operation: () => A) =>
	Effect.try({
		try: operation,
		catch: (cause) => ({
			message: String(cause),
			recovery: "Inspect the disposable acceptance project."
		})
	});
const readOffline = () =>
	Stream.runCollect(extractProjectTextPackages({ projectRoot: project, paths: files }));
const leaseFiles = () =>
	readdirSync(join(output, "cache/leases"), { recursive: true }).filter((file) =>
		String(file).endsWith(".json")
	);
const program = Effect.scoped(
	Effect.gen(function* () {
		const plugins = yield* PluginDistribution;
		const installed = yield* plugins.install({
			artifact: built.manifest.compatibility,
			releaseVersion: built.manifest.releaseVersion,
			pluginIds: built.resolvedPluginIds,
			expectedManifestSha256: built.manifestDigest,
			expectedArtifactSha256: built.manifest.artifact.sha256,
			networkPolicy: "online"
		});
		record("install-result.json", installed);
		assert.equal(installed.artifactKind, "compiled");
		record("active-leases.json", leaseFiles());
		assert.equal(leaseFiles().length, 1);
		const processes = yield* OwnedProcessTree;
		const launch = {
			executable: tools.editor,
			cwd: project,
			terminationTimeout: Duration.seconds(30),
			args: [
				projectFile,
				...installed.descriptorPaths.map((path) => `-PLUGIN=${path}`),
				...unrealRemoteControlLaunchArguments(installed.resolvedPluginIds, port),
				"-Unattended",
				"-SCCProvider=None",
				"-NoSound",
				...(legacy
					? [...localDerivedDataCacheArguments, "-NullRHI"]
					: ["-RenderOffscreen"]),
				"-NoSplash",
				"-nosync",
				`-abslog=${join(output, "editor.log")}`
			]
		};
		record("editor-launch.json", launch);
		const editor = yield* Effect.acquireRelease(processes.launch(launch), (handle) =>
			handle.terminate("released").pipe(
				Effect.tap((exit) => Effect.sync(() => record("editor-exit.json", exit))),
				Effect.asVoid,
				Effect.orDie
			)
		);
		console.log("Editor launched", editor.pid);
		yield* Effect.tryPromise({
			try: async (signal) => {
				const deadline = Date.now() + 600_000;
				while (!signal.aborted && Date.now() < deadline) {
					try {
						if (
							(
								await fetch(`${endpoint}/remote/info`, {
									signal: AbortSignal.any([signal, AbortSignal.timeout(1500)])
								})
							).ok
						)
							return;
					} catch {
						/* Startup. */
					}
					await new Promise((done) => setTimeout(done, 2000));
				}
				throw new Error("Remote Control did not become ready in ten minutes");
			},
			catch: (cause) => cause
		}).pipe(
			Effect.raceFirst(
				editor.awaitExit.pipe(
					Effect.flatMap((exit) =>
						Effect.fail(
							new Error(
								`Editor exited before HTTP readiness: ${JSON.stringify(exit)}`
							)
						)
					)
				)
			)
		);
		const producer = yield* inspectUnrealProducer(endpoint);
		record("capabilities.json", producer);
		const remote = yield* RemoteControlClient;
		const editorProject = (address: string) =>
			remote
				.request({
					endpoint: address,
					objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
					functionName: "GetCapabilityManifest",
					parameters: {},
					idempotent: true
				})
				.pipe(
					Effect.map(
						(value) =>
							Schema.decodeUnknownSync(Schema.Struct({ projectRoot: Schema.String }))(
								value
							).projectRoot
					)
				);
		assert.equal(resolve(yield* editorProject(endpoint)), project);
		if (legacy)
			assert.deepEqual(producer.capabilities, [
				"game-text.actions.v1",
				"game-text.actions.key-repairs.v1"
			]);
		else {
			assert.ok(producer.capabilities.includes("game-text.actions.authoring.v1"));
			assert.equal(producer.capabilities.length, 37);
		}
		assert.deepEqual(
			producer.identity?.plugins.map((plugin) => plugin.name).sort(),
			[...installed.resolvedPluginIds].sort()
		);
		assert.equal(
			producer.identity?.plugins.flatMap((plugin) => plugin.loadedModules).length,
			legacy ? 2 : 16
		);
		const baseline = yield* readOffline();
		record("baseline-offline.json", baseline);
		let occupied = false;
		for (const chosen of places) {
			const operation = chosen.operation;
			const label = `${chosen.kind}-${operation}`;
			const changes = places
				.filter((place) => place === chosen)
				.map((place) => {
					const event = baseline.find(
						(item) =>
							item.event === "text_package_record" &&
							resolve(project, item.path) === resolve(place.packageFile)
					);
					assert.ok(event && event.event === "text_package_record");
					const extracted = event.occurrences.find(
						(item) =>
							item.location.kind !== "string_table_entry" &&
							item.location.property_path === place.propertyPath &&
							(place.kind !== "data_table_cell" ||
								(item.location.kind === "data_table_cell" &&
									item.location.row === place.row))
					);
					assert.ok(extracted, `Missing baseline ${place.kind}-${operation}`);
					const occurrence = textOccurrenceFromExtraction({
						packageFile: relative(project, place.packageFile).replaceAll("\\", "/"),
						occurrence: extracted
					});
					return {
						unitId: makeTextUnitId(`unit:${occurrence.id}`),
						occurrence,
						edit:
							operation === "split"
								? {
										kind: "change_key" as const,
										namespace: "KeyRepairs",
										key: "SplitAfter"
									}
								: operation === "regenerate"
									? { kind: "regenerate_key" as const }
									: {
											kind: "adopt_key" as const,
											namespace: "KeyRepairs",
											key: "Survivor",
											source: "adopt source"
										}
					};
				});
			assert.equal(changes.length, 1);
			const request = TextIdRepairRequest.make({
				projectKey: project,
				title: label,
				changes
			});
			const make = () =>
				makeGameTextIdRepairs({
					current: () =>
						Effect.succeed({ status: "ready", project: { projectRoot: project } }),
					endpoint: () => Effect.succeed(endpoint),
					editorProject,
					workspace: {
						focus: ({ id }) => {
							const change = changes.find((item) => item.unitId === id)!;
							const focus: TextCorpusFocus = {
								occurrences: [change.occurrence],
								totalOccurrences: 1,
								diagnostics: [],
								unit: {
									id,
									source: {
										status: "consistent",
										value: change.occurrence.source
									},
									identity: change.occurrence.identity,
									contexts: [],
									locationKinds: [change.occurrence.location.kind],
									characterCount: change.occurrence.source.length,
									wordCount: change.occurrence.source.split(/\s+/u).length,
									occurrenceCount: 1,
									remainingContextCount: 0,
									reviewSignals: []
								}
							};
							return Effect.succeed({ status: "found", focus });
						},
						beginOperation: () =>
							Effect.sync(() => {
								if (occupied) return false;
								occupied = true;
								return true;
							}),
						endOperation: () =>
							Effect.sync(() => {
								occupied = false;
							})
					},
					files: {
						readFileWithin: (root, file) => io(() => readFileSync(resolve(root, file))),
						writeFile: (path, bytes, options) =>
							io(() => {
								mkdirSync(dirname(path), { recursive: true });
								writeFileSync(path, bytes, {
									flag: options?.exclusive ? "wx" : "w"
								});
							})
					}
				});
			const service = yield* make();
			const before = files.map((file) => readFileSync(file));
			const preview = yield* service.prepare(request);
			record(`${label}-preview.json`, preview);
			assert.equal(preview.status, "prepared", JSON.stringify(preview));
			if (preview.status !== "prepared") throw new Error("No prepared proposal");
			assert.equal(preview.plan.preview.status, "ok", JSON.stringify(preview));
			files.forEach((file, index) =>
				assert.ok(
					readFileSync(file).equals(before[index]!),
					"Preview changed package bytes"
				)
			);
			const receipt = yield* service.apply(preview.plan.id);
			record(`${label}-receipt.json`, receipt);
			assert.equal(receipt.status, "finished", JSON.stringify(receipt));
			if (receipt.status !== "finished") throw new Error("No receipt");
			assert.equal(receipt.result.status, "ok", JSON.stringify(receipt));
			assert.equal(receipt.verified, true);
			assert.ok(receipt.result.packages.every((item) => item.saved));
			assert.deepEqual(readJson(join(project, receipt.plan.artifact)).result, receipt);
			const outcome = receipt.result.actions[0]!;
			assert.ok(outcome.after && "key" in outcome.after);
			assert.equal(outcome.after.namespace, "KeyRepairs");
			if (operation === "split") assert.equal(outcome.after.key, "SplitAfter");
			else if (operation === "adopt") assert.equal(outcome.after.key, "Survivor");
			else assert.notEqual(outcome.after.key, "regenerateBefore");
			const saved = yield* readOffline();
			record(`${label}-offline.json`, saved);
			const verification = verifyGameTextActions(
				gameTextActionsRequest({
					mode: "apply",
					actions: receipt.plan.preview.actions.map((action) => ({
						id: action.id,
						place: {
							...textIdRepairPlace(
								changes.find((change) => change.occurrence.id === action.id)!
									.occurrence
							),
							packageFile: resolve(
								project,
								changes.find((change) => change.occurrence.id === action.id)!
									.occurrence.packageFile
							)
						},
						expected: action.before!,
						edit: changes.find((change) => change.occurrence.id === action.id)!.edit
					})),
					save: true
				}),
				receipt.result,
				saved.filter((event) => event.event === "text_package_record")
			);
			record(`${label}-verification.json`, verification);
			assert.equal(verification.verified, 1, JSON.stringify(verification));
			assert.equal(verification.mismatches.length, 0);
			const restarted = yield* make();
			const replay = yield* restarted.apply(preview.plan.id);
			record(`${label}-replay-refused.json`, replay);
			assert.equal(replay.status, "unavailable");
			console.log(label, "preview/apply/save/offline/replay passed");
		}
		record("journey-result.json", {
			status: "passed",
			operations: 6,
			offlineVerified: 6,
			offlinePinsSkipped: true,
			endpoint,
			project
		});
	})
);
await Effect.runPromise(
	program.pipe(Effect.provide(Layer.mergeAll(distribution, OwnedProcessTreeLive, wire, reader)))
);
record("released-leases.json", leaseFiles());
assert.equal(leaseFiles().length, 0);
console.log("Packaged RC journey passed; editor stopped and plugin lease released.");
