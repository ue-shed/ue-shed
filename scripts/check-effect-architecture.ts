import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { isJsonObject, isJsonString, parseJsonObject } from "./json.ts";
import { rawDecoderExportBaseline } from "./raw-decoder-export-baseline.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoots = ["apps", "packages", "extensions"];
const testSourcePattern = /\.(?:test|test-support)\.tsx?$/;
const catalogOwned = new Set([
	"@effect/opentelemetry",
	"@effect/vitest",
	"@opentelemetry/api",
	"@opentelemetry/api-logs",
	"@opentelemetry/resources",
	"@opentelemetry/sdk-logs",
	"@opentelemetry/sdk-metrics",
	"@opentelemetry/sdk-trace-base",
	"@opentelemetry/sdk-trace-node",
	"@opentelemetry/sdk-trace-web",
	"@opentelemetry/semantic-conventions",
	"@stylexjs/rollup-plugin",
	"@stylexjs/stylex",
	"effect",
	"solid-js",
	"vite-plugin-solid"
]);

const approvedRuntimeExits = new Set([
	// Retained localization evidence getters use scoped synchronous cache reads. Corpus search,
	// focus and quality use the asynchronous native engine.
	"packages/game-text/src/joined-query-node.ts",
	// The browser worker is a foreign entrypoint; each read's scope terminates its runtime.
	"apps/site/src/blueprints/blueprint.worker.ts",
	"apps/cli/src/index.ts",
	// The plugin installer adapts the synchronous manifest validator at the CLI/filesystem boundary.
	"apps/cli/src/plugin-installer.ts",
	"extensions/data-authoring/adoption/consumer/server/src/index.ts",
	// Canvas paint is a browser callback boundary; the metric update is synchronous and bounded.
	"extensions/camera-review/src/world-scout.tsx",
	// Node's socket callback is a foreign runtime boundary. The fork is attached to the layer's
	// scope with Effect.forkIn; camera decoding itself remains the measured synchronous hot path.
	"packages/cameras/src/index.ts",
	// The live benchmark is a Node process entrypoint and owns the single Effect runtime exit.
	"packages/observatory/scripts/benchmark-live.ts",
	// The Workbench index benchmark is a Node process entrypoint, never part of the Electron main
	// process. It owns one short-lived Effect runtime to measure the production reader boundary.
	"apps/workbench/scripts/benchmark-project-index.ts",
	// The compact-corpus benchmark is likewise an opt-in Node entrypoint over the production reader.
	"apps/workbench/scripts/benchmark-compact-text.ts",
	// Same pattern for the actor transform feed's per-socket decode-and-publish fork.
	"packages/observatory/src/actor-feed.ts",
	// The Project Index process adapter owns the async-generator child-process bridge and its
	// short-lived metrics exit; the public ProjectIndex service remains Effect-shaped.
	"packages/unreal-assets/src/project-index-process.ts",
	// The shared protocol transport closes the Project Index async-generator telemetry boundary;
	// callers still receive only Effect and Stream operations.
	"packages/unreal-assets/src/protocol-transport.ts",
	// The Game Text engine session awaits each stream sink write as a Promise; the client runs
	// the caller's Effect writer in the call's own context, so callers write with Effect only.
	"packages/unreal-assets/src/game-text-engine-client.ts"
]);
const approvedPromiseAdapters = new Set([
	// Native build staging adapts Node filesystem/snapshot Promise ports below the scoped
	// Effect builder; leases, temporary files and the protocol process share its scope.
	"packages/game-text/src/native-index-builder.ts",
	// The cold importer adapts worker messages and staged snapshot handles below SharedIndex.
	"packages/game-text/src/localization-cold-import.ts",
	// Package cold import owns the same worker-message Promise bridge under Effect.acquireRelease;
	// callers receive only a scoped Effect, and workers/readers/staging close on every exit.
	"packages/game-text/src/package-text-cold.ts",
	// Cold worker reservations/message bridges stay below scoped import/publication Effects.
	// The one-hour cold-index report records the measured boundary and keep/reject evidence.
	"packages/game-text/src/cold-task-pool.ts",
	"packages/game-text/src/cold-layer-pool.ts",
	// Bounded worker sort-run IO implements SnapshotSource load ports without a second runtime.
	"packages/game-text/src/shared-string-sort.ts",
	// Shared immutable string segments and ID layers adapt positioned Node IO below the Effect store.
	"packages/game-text/src/shared-string-file.ts",
	"packages/game-text/src/shared-index.ts",
	// Localization import owns bounded stat/hash/parse IO behind scoped Effect operations.
	"packages/game-text/src/localization-import.ts",
	// Column producers adapt bounded spill blocks to the snapshot writer's Promise load port.
	"packages/game-text/src/localization-columns.ts",
	// Game Text owns bounded Node filesystem, zstd and cross-process locks behind an Effect store.
	"packages/game-text/src/snapshot-store.ts",
	// Positioned section reads and streaming publication are the Node adapter below that store.
	"packages/game-text/src/snapshot-file.ts",
	// Native foreground permission adapts Node execFile once behind an Effect-only service;
	// the request AbortSignal and a bounded timeout own the short-lived helper process.
	"packages/engine/src/editor-window-activation.ts",
	// Atomic filesystem writes and cross-process file locks stay behind an Effect-only store port.
	"packages/cameras/src/camera-authoring-store.ts",
	// The CLI plugin installer owns filesystem/archive promises behind an Effect boundary.
	"apps/cli/src/plugin-installer.ts",
	// Plugin distribution isolates Node archive, HTTP, and immutable-cache promises behind typed
	// Effect services. Public acquisition, store, source, lease, and prune APIs remain Effect-shaped.
	"packages/plugin-distribution/src/archive.ts",
	// The compiled-plugin builder owns staging, canonical archive, and Unreal build-tool promises;
	// callers receive a typed Effect service and never observe the foreign Promise surface.
	"packages/plugin-distribution/src/builder.ts",
	"packages/plugin-distribution/src/source.ts",
	"packages/plugin-distribution/src/store.ts",
	"apps/workbench/src/main/adapters/electron-app.ts",
	"apps/workbench/src/main/adapters/electron-ipc.ts",
	// The shared preload contract describes Electron's Promise-returning renderer bridge; the
	// implementation remains isolated in preload.ts and the Electron IPC adapter.
	"apps/workbench/src/main/preload-contract.ts",
	"apps/workbench/src/main/preload.ts",
	// Saved review adapts Electron IPC promises to validated, typed Effect reads.
	"apps/workbench/src/renderer/saved-review-client.ts",
	"apps/workbench/src/renderer/asset-audits-client.ts",
	"apps/workbench/src/renderer/authoring-client.ts",
	"apps/workbench/src/renderer/content-observatory-client.ts",
	"apps/workbench/src/renderer/game-text-client.ts",
	"apps/workbench/src/renderer/global.d.ts",
	"apps/workbench/src/renderer/input-atlas-client.ts",
	"apps/workbench/src/renderer/map-capture-client.ts",
	"apps/workbench/src/renderer/map-review-client.ts",
	"apps/workbench/src/renderer/niagara-preview-client.ts",
	"apps/workbench/src/renderer/project-custodian-client.ts",
	"apps/workbench/src/renderer/workbench-client.ts",
	// The opt-in benchmark isolates marker validation and reversible mutations in one filesystem adapter.
	"apps/workbench/scripts/benchmark-project-index-support.ts",
	"apps/workbench/scripts/benchmark-project-index.ts",
	"apps/workbench/scripts/benchmark-compact-text.ts",
	// The opt-in desktop benchmark drives Electron through Playwright, its foreign adapter.
	"apps/workbench/scripts/benchmark-game-text-desktop.ts",
	"extensions/data-authoring/adoption/consumer/server/src/index.ts",
	"packages/cameras/src/index.ts",
	// Capture destinations own the Node filesystem promise boundary; callers receive only
	// Effect-shaped attempts with typed storage failures.
	"packages/cameras/src/capture-destination.ts",
	"packages/cameras/src/review-repository.ts",
	"packages/authoring-sdk/src/index.ts",
	// The synthetic benchmark invokes Playwright as its foreign child-process adapter.
	"packages/observatory/scripts/benchmark.ts",
	"packages/observatory/src/actor-feed.ts",
	// The Game Text engine session is the engine process seam: its close waits for the child to
	// exit, and the client layer releases it through Effect.promise.
	"packages/unreal-assets/src/game-text-engine-session.ts",
	"packages/unreal-assets/src/protocol-transport.ts",
	// The Project Index adapter bridges the native async-generator protocol stream once at the
	// process seam; callers consume only Effect and Stream operations.
	"packages/unreal-assets/src/project-index-process.ts",
	"packages/unreal-assets/src/scan-target.ts",
	// The supervised process adapter bridges Node's child-process completion promise once; the
	// session and process-tree services expose only scoped Effect operations.
	"packages/engine/src/supervised-editor-session.ts",
	// Project Custodian owns Node filesystem promises in one cancellable scan adapter.
	"packages/project-custodian/src/node-scanner.ts",
	// Project Custodian owns process inspection, filesystem mutation, OS Trash, and durable
	// proposal/receipt promises in one executor adapter; the public service remains Effect-shaped.
	"packages/project-custodian/src/node-executor.ts",
	// Localization owns bounded config/log reads and hash audits in one Node filesystem adapter;
	// public operation services expose only scoped Effect and Stream values.
	"packages/localization/src/operation-io.ts",
	// The generated browser declaration is a foreign WebAssembly adapter surface.
	"packages/uasset-inspection-wasm/src/browser.d.ts"
]);
const approvedEnvironmentAdapters = new Set([
	"apps/cli/src/index.ts",
	"apps/workbench/src/main/main.ts",
	// The synthetic benchmark forwards the process environment to its Playwright child.
	"packages/observatory/scripts/benchmark.ts",
	// The desktop benchmark forwards the process environment to the Electron it launches.
	"apps/workbench/scripts/benchmark-game-text-desktop.ts"
]);
const approvedRawFetchAdapters = new Set([
	// Only the bundled public sample is fetched; selected files are read locally and transferred.
	"apps/site/src/blueprints/browser-reader.ts",
	"packages/authoring-sdk/src/index.ts",
	"packages/unreal-connection/src/remote-control-client.ts"
]);
const approvedResourceAdapters = new Set([
	// Bounded snapshot producer cancellation removes its abort listener in finally; the owning
	// native build scope closes staging handles. Verified by native-index-lifecycle.integration.test.ts.
	"packages/game-text/src/snapshot-file.ts",
	// Ctrl+K, page-hide and the preference save timer belong to the Solid owner; onSettled cleanup
	// removes them and flushes the pending save.
	"extensions/game-text/src/game-text-query-route.tsx",
	// Parser workers and their listeners are closed on success, failure and scope cancellation.
	"packages/game-text/src/localization-cold-import.ts",
	// Cold layer listeners and workers terminate in the publication adapter's finally block.
	"packages/game-text/src/cold-layer-pool.ts",
	"packages/game-text/src/cold-layer-worker.ts",
	// Site navigation owns click/popstate listeners through onSettled cleanup.
	"apps/site/src/navigation.ts",
	// Popover DOM listeners and animation frames are released by Solid effect/onSettled cleanup;
	// anchored-popover.component.test.tsx verifies close and unmount teardown.
	"packages/ui/src/anchored-popover.tsx",
	// Tooltip timers belong to the Solid owner and are cancelled on cleanup; document/window
	// listeners and animation frames exist only while a tooltip is open and are released by effect
	// cleanup. tool-button.component.test.tsx verifies pending/open teardown.
	"packages/ui/src/tool-button.tsx",
	// Shared file-drop listeners are limited to the containing viewer and released on teardown.
	"packages/ui/src/file-drop-zone.tsx",
	// Native details light-dismiss listeners belong to the Solid owner and are removed on unmount;
	// dismissible-details.component.test.tsx pins the document-listener cleanup.
	"packages/ui/src/dismissible-details.ts",
	// CLI signal listeners are installed through Effect.callback and removed by its scope.
	"apps/cli/src/signal.ts",
	"apps/workbench/src/main/adapters/electron-app.ts",
	"apps/workbench/src/main/adapters/fixture-process.ts",
	// Offline texture preview owns the hidden Unreal commandlet and its listeners inside
	// Effect.acquireRelease; the domain service only receives a typed Effect adapter.
	"apps/workbench/src/main/adapters/offline-texture-preview-host.ts",
	"apps/workbench/src/main/main.ts",
	"apps/workbench/src/main/preload.ts",
	// The opt-in benchmark owns bounded RSS sampling timers around each native worker.
	"apps/workbench/scripts/benchmark-project-index.ts",
	// The desktop benchmark owns its memory sampler process and poll timers around each run.
	"apps/workbench/scripts/benchmark-game-text-desktop.ts",
	// Script strings the benchmark evaluates in the page: one search's observer and Enter
	// listener, which disconnect on completion and end with the page.
	"apps/workbench/scripts/benchmark-game-text-desktop-page.ts",
	"apps/workbench/src/renderer/app-shell.tsx",
	// Blueprint Graphs owns its bounded search debounce through Solid onCleanup.
	"extensions/blueprint-graphs/src/project-blueprint-search.tsx",
	// Sequencer owns the same bounded index-search debounce through Solid onCleanup.
	"extensions/sequencer/src/project-sequence-search.tsx",
	// The chooser owns focus and progress-polling resources through Solid cleanup adapters.
	"apps/workbench/src/renderer/project-chooser.tsx",
	"apps/workbench/src/renderer/index.tsx",
	// World Log owns one bounded status-poll timer through Solid cleanup while a query is running.
	"extensions/content-observatory/src/content-observatory-route.tsx",
	// Niagara Preview owns one frame-advance timer through a Solid reactive cleanup. Each frame
	// change, pause, recapture, and route teardown cancels the prior timer.
	"extensions/niagara-preview/src/niagara-preview-route.tsx",
	// The static-site Observatory mock owns its display-only timers through Solid cleanup.
	"apps/site/src/showcase/ObservatoryMock.tsx",
	// The copied adoption host owns its browser runtime lifecycle at the foreign framework boundary.
	"extensions/data-authoring/adoption/consumer/app/src/index.tsx",
	"extensions/data-authoring/adoption/consumer/server/src/index.ts",
	"packages/cameras/src/index.ts",
	// PointMap owns its animation-frame fallback and ResizeObserver through Solid onCleanup.
	"packages/ui/src/point-map.tsx",
	// The actor feed owns its named-pipe server and per-connection sockets through Effect.acquireRelease.
	"packages/observatory/src/actor-feed.ts",
	// Plugin distribution owns AbortSignal listeners, lock polling, and lease files through
	// Effect.callback / acquireRelease finalizers at its Node adapter boundary.
	"packages/plugin-distribution/src/distribution.ts",
	// Build cancellation owns its AbortSignal listener through Effect.callback's finalizer. UAT/UBT
	// process-tree ownership remains delegated to the scoped engine supervisor service.
	"packages/plugin-distribution/src/builder.ts",
	"packages/plugin-distribution/src/source.ts",
	"packages/plugin-distribution/src/store.ts",
	// The saved-asset protocol transport owns and cancels the bounded native child process.
	"packages/unreal-assets/src/protocol-transport.ts",
	// The Game Text engine session owns its child process and the stuck-cancel timers; the client
	// layer acquires and closes it with its scope.
	"packages/unreal-assets/src/game-text-engine-session.ts",
	// The engine launcher owns the detached Unreal Editor spawn boundary; its Effect.callback
	// cancellation finalizer terminates a child that has not completed startup.
	"packages/engine/src/project-launcher.ts",
	// The supervised launcher owns its child-process listeners, POSIX process group, and bounded
	// exit polling inside Effect callbacks and a scoped acquire/release session.
	"packages/engine/src/supervised-editor-session.ts"
]);
const operationlessServices = new Set([
	"apps/workbench/src/main/workbench-config.ts",
	// Serves the Game Text workspace as built, whose operations are its own Effect.fn spans.
	"apps/workbench/src/main/services/game-text.ts"
]);
const externalServiceEvidence = new Map([
	[
		"packages/game-text/src/index-builder.ts",
		[
			"packages/game-text/src/native-index-builder.ts",
			"packages/game-text/src/native-query.integration.test.ts"
		]
	],
	[
		// The public index ports and schemas are separate from the injected steps and Node adapter.
		"packages/game-text/src/index-contract.ts",
		[
			"packages/game-text/src/index-refresh.ts",
			"packages/game-text/src/index-steps.ts",
			"packages/game-text/src/index-source-node.ts",
			"packages/game-text/src/index-steps.test.ts",
			"packages/game-text/src/index-source-node.test.ts"
		]
	],
	[
		"packages/authoring-sdk/src/index.ts",
		[
			"apps/workbench/src/renderer/index.tsx",
			"extensions/data-authoring/src/authoring-route.component.test.tsx"
		]
	],
	[
		"extensions/asset-audits/src/texture-audit-client.ts",
		[
			"apps/workbench/src/renderer/index.tsx",
			"extensions/asset-audits/src/texture-audit-route.component.test.tsx"
		]
	],
	[
		"extensions/camera-review/src/map-review-client.ts",
		[
			"apps/workbench/src/renderer/index.tsx",
			"extensions/camera-review/src/map-review-route.component.test.tsx"
		]
	],
	[
		"extensions/content-observatory/src/content-observatory-client.ts",
		[
			"apps/workbench/src/renderer/index.tsx",
			"extensions/content-observatory/src/content-observatory-route.component.test.tsx"
		]
	],
	[
		"extensions/game-text/src/game-text-client.ts",
		[
			"apps/workbench/src/renderer/index.tsx",
			"extensions/game-text/src/game-text-route.component.test.tsx"
		]
	],
	[
		"extensions/input-atlas/src/input-atlas-client.ts",
		[
			"apps/workbench/src/renderer/index.tsx",
			"extensions/input-atlas/src/input-atlas-route.component.test.tsx"
		]
	]
]);

const workbenchMainBootstrap = "apps/workbench/src/main/main.ts";
const workbenchMainAdaptersPrefix = "apps/workbench/src/main/adapters/";
const workbenchRendererPrefix = "apps/workbench/src/renderer/";
const rendererTransportFiles = new Set([
	// Saved review adapts Electron IPC promises to validated, typed Effect reads.
	"apps/workbench/src/renderer/saved-review-client.ts",
	"apps/workbench/src/renderer/asset-audits-client.ts",
	"apps/workbench/src/renderer/authoring-client.ts",
	"apps/workbench/src/renderer/content-observatory-client.ts",
	"apps/workbench/src/renderer/game-text-client.ts",
	"apps/workbench/src/renderer/global.d.ts",
	"apps/workbench/src/renderer/input-atlas-client.ts",
	"apps/workbench/src/renderer/map-capture-client.ts",
	"apps/workbench/src/renderer/map-review-client.ts",
	"apps/workbench/src/renderer/niagara-preview-client.ts",
	"apps/workbench/src/renderer/project-custodian-client.ts",
	"apps/workbench/src/renderer/scenario-studio-client.ts",
	"apps/workbench/src/renderer/workbench-client.ts"
]);

function isWorkbenchMainSource(path: string) {
	return path.startsWith("apps/workbench/src/main/") && path.endsWith(".ts");
}

function isWorkbenchBootstrapOrAdapter(path: string) {
	return path === workbenchMainBootstrap || path.startsWith(workbenchMainAdaptersPrefix);
}

async function filesUnder(root: string, directory: string): Promise<string[]> {
	const absolute = join(root, directory);
	let entries;
	try {
		entries = await readdir(absolute, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Object && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "e2e")
			continue;
		const path = join(absolute, entry.name);
		if (entry.isDirectory()) files.push(...(await filesUnder(root, relative(root, path))));
		else files.push(path);
	}
	return files;
}

function lineOf(text: string, offset: number) {
	return text.slice(0, offset).split("\n").length;
}

function reportOccurrences(
	failures: string[],
	path: string,
	text: string,
	needle: string,
	message: string
) {
	let offset = 0;
	while ((offset = text.indexOf(needle, offset)) !== -1) {
		failures.push(`${path}:${lineOf(text, offset)}: ${message}`);
		offset += needle.length;
	}
}

export async function checkSourcePolicy(root: string) {
	const failures: string[] = [];
	const sourceFiles = (
		await Promise.all(sourceRoots.map((directory) => filesUnder(root, directory)))
	).flat();
	for (const absolute of sourceFiles) {
		if (!/\.tsx?$/.test(absolute) || testSourcePattern.test(absolute)) continue;
		const path = relative(root, absolute).replaceAll("\\", "/");
		const text = await readFile(absolute, "utf8");
		if (!approvedRuntimeExits.has(path)) {
			reportOccurrences(
				failures,
				path,
				text,
				"Effect.run",
				"Effect runtime exit is not approved"
			);
		}
		if (!approvedPromiseAdapters.has(path)) {
			reportOccurrences(
				failures,
				path,
				text,
				"Promise<",
				"Promise type is only allowed in an approved foreign adapter"
			);
		}
		if (!approvedEnvironmentAdapters.has(path)) {
			reportOccurrences(
				failures,
				path,
				text,
				"process.env",
				"application configuration must use Effect Config"
			);
		}
		if (!approvedRawFetchAdapters.has(path)) {
			reportOccurrences(
				failures,
				path,
				text,
				"fetch(",
				"raw fetch is not an approved transport"
			);
		}
		if (!approvedResourceAdapters.has(path)) {
			for (const needle of [
				"setInterval(",
				"setTimeout(",
				"addEventListener(",
				".on(",
				"createServer(",
				"spawn("
			]) {
				reportOccurrences(
					failures,
					path,
					text,
					needle,
					"long-lived resource must be owned by an approved scoped adapter"
				);
			}
		}
	}
	return failures;
}

export async function checkCatalogUsage(root: string) {
	const failures: string[] = [];
	const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
	for (const dependency of catalogOwned) {
		const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (!new RegExp(`^[ \\t]+["']?${escaped}["']?:`, "m").test(workspace)) {
			failures.push(`pnpm-workspace.yaml: missing catalog entry for ${dependency}`);
		}
	}
	if (!/^\s*["']?effect["']?:\s*["']?4\./m.test(workspace)) {
		failures.push("pnpm-workspace.yaml: Effect catalog entry must select v4");
	}

	const manifests = [join(root, "package.json")];
	for (const sourceRoot of sourceRoots) {
		for (const file of await filesUnder(root, sourceRoot)) {
			if (file.endsWith("package.json")) manifests.push(file);
		}
	}
	for (const manifestPath of manifests) {
		const manifest = parseJsonObject(await readFile(manifestPath, "utf8"));
		for (const section of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies"
		]) {
			const dependencies = manifest[section];
			if (dependencies === undefined || !isJsonObject(dependencies)) continue;
			for (const [dependency, version] of Object.entries(dependencies)) {
				const publishedEffect =
					manifest.private !== true &&
					(dependency === "effect" || dependency.startsWith("@effect/"));
				if (publishedEffect && section !== "devDependencies") {
					if (section !== "peerDependencies" || version !== "^4.0.0") {
						failures.push(
							`${relative(root, manifestPath)}: ${dependency} must be a ^4.0.0 peer dependency`
						);
					}
					const development = manifest.devDependencies;
					if (
						development === undefined ||
						!isJsonObject(development) ||
						development[dependency] !== "catalog:"
					) {
						failures.push(
							`${relative(root, manifestPath)}: devDependencies.${dependency} must use catalog:`
						);
					}
				} else if (catalogOwned.has(dependency) && version !== "catalog:") {
					failures.push(
						`${relative(root, manifestPath)}: ${section}.${dependency} must use catalog:`
					);
				}
			}
		}
	}
	const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
	const effectVersions = new Set(
		[...lockfile.matchAll(/(?:^|\s)effect@([^\s(]+)/gm)].map((match) => match[1])
	);
	if (effectVersions.size > 1) {
		failures.push(
			`pnpm-lock.yaml: mixed Effect versions are not allowed (${[...effectVersions].join(", ")})`
		);
	}
	return failures;
}

export async function checkServiceStrategies(root: string = repositoryRoot) {
	const failures: string[] = [];
	const sourceFiles = (
		await Promise.all(sourceRoots.map((directory) => filesUnder(root, directory)))
	).flat();
	for (const absolute of sourceFiles) {
		if (!/\.tsx?$/.test(absolute) || testSourcePattern.test(absolute)) continue;
		const path = relative(root, absolute).replaceAll("\\", "/");
		const text = await readFile(absolute, "utf8");
		if (!text.includes("Context.Service")) continue;
		const externalEvidence = externalServiceEvidence.get(path);
		if (externalEvidence !== undefined) {
			for (const evidencePath of externalEvidence) {
				try {
					await readFile(join(root, evidencePath), "utf8");
				} catch {
					failures.push(`${path}: missing service strategy evidence ${evidencePath}`);
				}
			}
			continue;
		}
		if (!text.includes("Layer.")) {
			failures.push(`${path}: service declaration has no live or test layer strategy`);
		}
		if (!operationlessServices.has(path) && !text.includes("Effect.fn(")) {
			failures.push(`${path}: service operations must use Effect.fn`);
		}
	}
	return failures;
}

export async function checkDomainServices(root: string = repositoryRoot) {
	const required = [
		["packages/asset-audits/src/texture.ts", "export class TextureAudit"],
		["packages/game-text/src/corpus.ts", "export class TextCorpusService"],
		["packages/authoring-catalog/src/index.ts", "export class AuthoringCatalog"],
		["packages/authoring/src/session-service.ts", "export class AuthoringSessions"],
		["packages/cameras/src/review-capture.ts", "export class ReviewCapture"],
		["packages/cameras/src/review-authoring-live.ts", "export class ReviewAuthoring"]
	];
	const failures: string[] = [];
	for (const [path, needle] of required) {
		const text = await readFile(join(root, path), "utf8");
		if (!text.includes(needle)) {
			failures.push(`${path}: missing domain service declaration ${needle}`);
		}
		if (!text.includes("Context.Service")) {
			failures.push(`${path}: domain service file must use Context.Service`);
		}
		if (!text.includes("Effect.fn(")) {
			failures.push(`${path}: domain service operations must use Effect.fn`);
		}
	}

	const capture = await readFile(join(root, "packages/cameras/src/review-capture.ts"), "utf8");
	if (/captureSet:\s*\([^)]*dependencies/.test(capture)) {
		failures.push(
			"packages/cameras/src/review-capture.ts: captureSet must not take ad-hoc dependencies"
		);
	}
	if (!capture.includes("Effect.forEach(") || !capture.includes("concurrency")) {
		failures.push(
			"packages/cameras/src/review-capture.ts: view capture must use Effect.forEach concurrency"
		);
	}
	if (!capture.includes("attempt.discard")) {
		failures.push(
			"packages/cameras/src/review-capture.ts: capture must release its prepared attempt"
		);
	}
	const finalizeRun = capture.indexOf("attempt.finalize(");
	if (
		finalizeRun === -1 ||
		!capture.slice(finalizeRun, finalizeRun + 400).includes("Effect.uninterruptible")
	) {
		failures.push(
			"packages/cameras/src/review-capture.ts: durable promotion must be uninterruptible through promotion-state persistence"
		);
	}

	const catalog = await readFile(join(root, "packages/authoring-catalog/src/index.ts"), "utf8");
	if (/export interface AuthoringCatalogDiscoverArgs \{[^}]*live\?/s.test(catalog)) {
		failures.push(
			"packages/authoring-catalog/src/index.ts: discover args must not take an ad-hoc live connection"
		);
	}
	if (!catalog.includes("AuthoringLiveConnection")) {
		failures.push(
			"packages/authoring-catalog/src/index.ts: live catalog evidence must come from AuthoringLiveConnection"
		);
	}

	const authoring = await readFile(
		join(root, "packages/cameras/src/review-authoring-live.ts"),
		"utf8"
	);
	if (
		/inspectSelection:[\s\S]*?RemoteControlClient/.test(authoring) &&
		authoring.includes("ReviewAuthoringApi")
	) {
		const reviewAuthoringContract = authoring.slice(
			authoring.indexOf("export interface ReviewAuthoringApi"),
			authoring.indexOf("export class ReviewAuthoring")
		);
		if (reviewAuthoringContract.includes("RemoteControlClient")) {
			failures.push(
				"packages/cameras/src/review-authoring-live.ts: ReviewAuthoring methods must not require RemoteControlClient from callers"
			);
		}
	}

	const sessions = await readFile(
		join(root, "packages/authoring/src/session-service.ts"),
		"utf8"
	);
	if (!sessions.includes("Effect.onExit") || !sessions.includes("markApplyIndeterminate")) {
		failures.push(
			"packages/authoring/src/session-service.ts: apply/save must finalize indeterminate state on non-success exits"
		);
	}
	if (!sessions.includes("AuthoringSessionLivePort")) {
		failures.push(
			"packages/authoring/src/session-service.ts: live mutation dependencies must come from AuthoringSessionLivePort"
		);
	}
	const sessionApi = sessions.slice(
		sessions.indexOf("export interface AuthoringSessionService"),
		sessions.indexOf("export interface AuthoringSessionServiceConfig")
	);
	if (sessionApi.includes("port: AuthoringLivePort")) {
		failures.push(
			"packages/authoring/src/session-service.ts: session operations must not take ad-hoc live ports"
		);
	}
	if (sessions.includes("Effect.uninterruptible, Effect.asVoid, Effect.ignore")) {
		failures.push(
			"packages/authoring/src/session-service.ts: indeterminate-state persistence failures must remain visible"
		);
	}

	return failures;
}

export async function checkWorkbenchBoundaries(root: string = repositoryRoot) {
	const failures: string[] = [];
	const sourceFiles = (
		await Promise.all(sourceRoots.map((directory) => filesUnder(root, directory)))
	).flat();

	for (const absolute of sourceFiles) {
		if (!/\.tsx?$/.test(absolute) || testSourcePattern.test(absolute)) continue;
		const path = relative(root, absolute).replaceAll("\\", "/");
		const text = await readFile(absolute, "utf8");

		if (isWorkbenchMainSource(path)) {
			if (text.includes("Effect.runPromise") || text.includes("Effect.runSync")) {
				failures.push(
					`${path}: Workbench main must not call Effect.runPromise or Effect.runSync`
				);
			}
			if (text.includes("fetch(")) {
				failures.push(`${path}: Workbench main must not call raw fetch`);
			}
			if (text.includes("process.env") && path !== workbenchMainBootstrap) {
				failures.push(
					`${path}: Workbench main must receive environment from the Electron bootstrap`
				);
			}
			if (text.includes("Layer.build(")) {
				failures.push(`${path}: Workbench main must compose services through layers`);
			}
			if (text.includes("ipcMain.handle") && !isWorkbenchBootstrapOrAdapter(path)) {
				failures.push(
					`${path}: ipcMain.handle is only allowed in the Electron bootstrap or adapters`
				);
			}
			if (
				(/from ["']electron\/main["']/.test(text) ||
					/import\(["']electron\/main["']\)/.test(text)) &&
				!isWorkbenchBootstrapOrAdapter(path)
			) {
				failures.push(
					`${path}: electron/main imports are only allowed in the Electron bootstrap or adapters`
				);
			}
		}
		if (path.startsWith(workbenchRendererPrefix)) {
			if (text.includes("window.ueShed") && !rendererTransportFiles.has(path)) {
				failures.push(`${path}: renderer IPC is only allowed in transport adapters`);
			}
			if (text.includes("Effect.runPromise") || text.includes("Effect.runSync")) {
				failures.push(
					`${path}: renderer components and transports must use the shared runtime`
				);
			}
		}

		if (path.startsWith("packages/") && /from ["'][^"']*apps\/workbench/.test(text)) {
			failures.push(`${path}: packages must not import apps/workbench`);
		}
		if (path.startsWith("packages/") && text.includes("@ue-shed/workbench")) {
			failures.push(`${path}: packages must not depend on @ue-shed/workbench`);
		}
	}

	return failures;
}

/** Read module syntax without mistaking authored strings or comments for import declarations. */
/**
 * Module specifiers a source names. `runtimeOnly` drops `import type`, `export type` and
 * `import("…")` types, which TypeScript erases; `import { type A }` still loads its module.
 */
function moduleSpecifiers(
	path: string,
	text: string,
	options?: { readonly runtimeOnly?: boolean }
): readonly string[] {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const specifiers: string[] = [];
	const runtimeOnly = options?.runtimeOnly === true;
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			const typeOnly = ts.isImportDeclaration(node)
				? node.importClause?.isTypeOnly === true
				: node.isTypeOnly;
			if (runtimeOnly && typeOnly) return;
			if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier))
				specifiers.push(node.moduleSpecifier.text);
		} else if (ts.isCallExpression(node)) {
			const argument = node.arguments[0];
			if (
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
				argument &&
				ts.isStringLiteralLike(argument)
			)
				specifiers.push(argument.text);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			if (runtimeOnly) return;
			if (ts.isStringLiteralLike(node.argument.literal))
				specifiers.push(node.argument.literal.text);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		) {
			const expression = node.moduleReference.expression;
			if (expression && ts.isStringLiteralLike(expression)) specifiers.push(expression.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return specifiers;
}

/** Localization formats are independently usable; browser consumers receive no Node authority. */
/** Browser-safe Game Text entry points; the Node-only `entry-index.ts` is excluded. */
const gameTextBrowserEntries = [
	"browser.ts",
	"entry-schema.ts",
	"entry-rules.ts",
	"entry-checks.ts",
	"entry-labels.ts",
	"entry-corpus.ts"
];

/**
 * Game Text entry points list their exports by name, so a new module stays private until it is
 * added on purpose, and first-party code imports the focused entry points instead of the
 * deprecated root and `/browser` aggregates.
 */
export async function checkGameTextEntryPoints(root: string = repositoryRoot) {
	const failures: string[] = [];
	const source = join(root, "packages/game-text/src");
	for (const entry of [
		...gameTextBrowserEntries,
		"index.ts",
		"entry-index.ts",
		"entry-workspace.ts"
	]) {
		let text: string;
		try {
			text = await readFile(join(source, entry), "utf8");
		} catch {
			continue;
		}
		if (
			ts
				.createSourceFile(entry, text, ts.ScriptTarget.Latest, true)
				.statements.some(
					(statement) =>
						ts.isExportDeclaration(statement) &&
						(!statement.exportClause || ts.isNamespaceExport(statement.exportClause))
				)
		)
			failures.push(
				`packages/game-text/src/${entry}: Game Text entry points use named exports only`
			);
	}
	for (const directory of sourceRoots) {
		for (const path of await filesUnder(root, directory)) {
			if (!/\.tsx?$/u.test(path)) continue;
			const label = relative(root, path).replaceAll("\\", "/");
			if (label.startsWith("packages/game-text/")) continue;
			const text = await readFile(path, "utf8");
			if (
				moduleSpecifiers(path, text).some(
					(specifier) =>
						specifier === "@ue-shed/game-text" ||
						specifier === "@ue-shed/game-text/browser"
				)
			)
				failures.push(
					`${label}: import a focused @ue-shed/game-text entry point (/schema, /rules, /checks, /labels, /corpus, /index or /workspace)`
				);
		}
	}
	return failures;
}

export async function checkLocalizationBoundaries(root: string = repositoryRoot) {
	const failures: string[] = [];
	const packageRoot = join(root, "packages/localization");
	let manifestText: string;
	try {
		manifestText = await readFile(join(packageRoot, "package.json"), "utf8");
	} catch {
		return failures;
	}
	if (manifestText.includes("@ue-shed/game-text")) {
		failures.push(
			"packages/localization/package.json: localization must not depend on the Game Text corpus"
		);
	}
	for (const path of await filesUnder(root, "packages/localization")) {
		if (!path.endsWith(".ts") || testSourcePattern.test(path)) continue;
		if ((await readFile(path, "utf8")).includes("@ue-shed/game-text")) {
			failures.push(
				`${relative(root, path).replaceAll("\\", "/")}: localization must not import the Game Text corpus`
			);
		}
	}
	const pending = [join(packageRoot, "src/browser.ts")];
	for (const entry of gameTextBrowserEntries) {
		const gameTextBrowser = join(root, "packages/game-text/src", entry);
		try {
			await readFile(gameTextBrowser, "utf8");
			pending.push(gameTextBrowser);
		} catch {
			// Focused boundary fixtures may contain only the independent format package.
		}
	}
	const visited = new Set<string>();
	while (pending.length > 0) {
		const path = pending.pop();
		if (path === undefined || visited.has(path)) continue;
		visited.add(path);
		const text = await readFile(path, "utf8");
		const label = relative(root, path).replaceAll("\\", "/");
		const browserSource = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
		let usesProcess = false;
		const findProcess = (node: ts.Node): void => {
			if (
				(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "process"
			)
				usesProcess = true;
			ts.forEachChild(node, findProcess);
		};
		findProcess(browserSource);
		if (usesProcess) failures.push(`${label}: browser closure must not use process`);
		const imports = moduleSpecifiers(path, text);
		for (const specifier of imports) {
			if (specifier === undefined) continue;
			if (
				/^(?:node:|electron(?:\/|$)|fs(?:\/|$)|path$|child_process$|process$)/u.test(
					specifier
				)
			) {
				failures.push(`${label}: browser closure must not import ${specifier}`);
			} else if (specifier.startsWith(".")) {
				pending.push(resolve(dirname(path), specifier.replace(/\.js$/u, ".ts")));
			} else if (specifier === "@ue-shed/config-explorer/browser") {
				pending.push(join(root, "packages/config-explorer/src/browser.ts"));
			} else if (specifier === "@ue-shed/localization/browser") {
				pending.push(join(packageRoot, "src/browser.ts"));
			} else if (specifier === "@ue-shed/unreal-assets/investigation") {
				pending.push(join(root, "packages/unreal-assets/src/investigation.ts"));
			} else if (specifier === "@ue-shed/unreal-assets/text-extraction") {
				pending.push(join(root, "packages/unreal-assets/src/text-extraction.ts"));
			} else if (specifier === "@ue-shed/protocol") {
				pending.push(join(root, "packages/protocol/src/index.ts"));
			} else if (specifier === "linebreak") {
				// Reviewed: MIT, exact pin 1.1.0, packaged iterator/table data with no Node/IO.
				// UE 5.7/5.8 FLocTextHelper::GetWordCountReport counts positive spans from
				// FBreakIterator::CreateLineBreakIterator (FICULineBreakIterator), using
				// UAX #14 line opportunities; Intl.Segmenter word tokens would differ.
				if (label !== "packages/game-text/src/localization-words.ts")
					failures.push(`${label}: linebreak must be confined to localization-words.ts`);
			} else if (specifier !== "effect" && !specifier.startsWith("effect/")) {
				failures.push(`${label}: unreviewed browser dependency ${specifier}`);
			}
		}
	}
	return failures;
}

/**
 * Entry points other than `./browser` that a package documents as browser-safe. Localization and
 * Game Text keep their own stricter check above.
 */
const browserSafeSubpaths = new Map([
	["map-history", ["./contract", "./playback", "./diff"]],
	["observatory", ["./presentation"]],
	["unreal-assets", ["./investigation", "./saved-review", "./text-extraction"]],
	["cameras", ["./map-tiles"]]
]);
const browserGuardedElsewhere = new Set(["localization", "game-text"]);

/** The exact sources `checkLocalizationBoundaries` already walks as browser closures. */
function sourcesGuardedElsewhere(root: string) {
	return new Set([
		join(root, "packages/localization/src/browser.ts"),
		...gameTextBrowserEntries.map((entry) => join(root, "packages/game-text/src", entry))
	]);
}

/** The source behind a `.js` module path: its TypeScript form, else the JavaScript file itself. */
async function moduleSource(path: string) {
	for (const candidate of /\.js$/u.test(path) ? [path.replace(/\.js$/u, ".ts"), path] : [path]) {
		try {
			await readFile(candidate, "utf8");
			return candidate;
		} catch {
			// Try the next source form.
		}
	}
	return undefined;
}

/** The TypeScript or JavaScript source behind a workspace package's export subpath, if any. */
async function workspaceEntrySource(root: string, folder: string, subpath: string) {
	let manifest;
	try {
		manifest = parseJsonObject(
			await readFile(join(root, "packages", folder, "package.json"), "utf8")
		);
	} catch {
		return undefined;
	}
	const exports = manifest.exports;
	if (!exports || !isJsonObject(exports)) return undefined;
	const target = exports[subpath];
	const file =
		target !== undefined && isJsonString(target)
			? target
			: target && isJsonObject(target)
				? (target.import ?? target.default)
				: undefined;
	if (file === undefined || !isJsonString(file) || !/\.(?:js|ts)$/u.test(file)) return undefined;
	return moduleSource(join(root, "packages", folder, file.replace(/^\.\/dist\//u, "src/")));
}

/**
 * Every package `./browser` entry and documented browser-safe subpath reaches only browser-safe
 * code: no Node built-ins, Electron or `process`, and no third-party dependency other than Effect.
 * Workspace imports are followed through their package `exports`.
 */
export async function checkBrowserEntryClosures(root: string = repositoryRoot) {
	const failures: string[] = [];
	let folders: string[];
	try {
		folders = (await readdir(join(root, "packages"), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && !browserGuardedElsewhere.has(entry.name))
			.map((entry) => entry.name);
	} catch {
		return failures;
	}
	const pending: string[] = [];
	const guardedElsewhere = sourcesGuardedElsewhere(root);
	for (const folder of folders)
		for (const subpath of ["./browser", ...(browserSafeSubpaths.get(folder) ?? [])]) {
			const source = await workspaceEntrySource(root, folder, subpath);
			if (source) pending.push(source);
		}
	const visited = new Set<string>();
	while (pending.length > 0) {
		const path = pending.pop();
		if (path === undefined || visited.has(path)) continue;
		visited.add(path);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue;
		}
		const label = relative(root, path).replaceAll("\\", "/");
		let usesProcess = false;
		const findProcess = (node: ts.Node): void => {
			if (
				(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "process"
			)
				usesProcess = true;
			ts.forEachChild(node, findProcess);
		};
		findProcess(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
		if (usesProcess) failures.push(`${label}: browser closure must not use process`);
		for (const specifier of moduleSpecifiers(path, text, { runtimeOnly: true })) {
			const workspace = /^@ue-shed\/([a-z0-9-]+)(\/.+)?$/u.exec(specifier);
			if (
				/^(?:node:|electron(?:\/|$)|fs(?:\/|$)|path$|child_process$|process$)/u.test(
					specifier
				)
			)
				failures.push(`${label}: browser closure must not import ${specifier}`);
			else if (specifier.startsWith(".")) {
				const source = await moduleSource(resolve(dirname(path), specifier));
				if (source) pending.push(source);
			} else if (workspace) {
				const subpath = workspace[2] ? `.${workspace[2]}` : ".";
				const source = await workspaceEntrySource(root, workspace[1]!, subpath);
				// Only the exact entries the localization guard walks are exempt; a Node-only
				// subpath of the same package (its root, Game Text `/index`) is followed here.
				if (source && !guardedElsewhere.has(source)) pending.push(source);
			} else if (specifier !== "effect" && !specifier.startsWith("effect/"))
				failures.push(`${label}: unreviewed browser dependency ${specifier}`);
		}
	}
	return failures;
}

function rawDecoderExportSites(source: ts.SourceFile) {
	const bindings = new Map<string, ts.Expression>();
	const exported = new Map<string, { readonly local: string; readonly node: ts.Node }>();
	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
				const name = declaration.name.text;
				bindings.set(name, declaration.initializer);
				if (statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword))
					exported.set(name, { local: name, node: statement });
			}
		} else if (
			ts.isExportDeclaration(statement) &&
			!statement.moduleSpecifier &&
			!statement.isTypeOnly &&
			statement.exportClause &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const item of statement.exportClause.elements)
				if (!item.isTypeOnly)
					exported.set(item.name.text, {
						local: (item.propertyName ?? item.name).text,
						node: item
					});
		} else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
			bindings.set("#default", statement.expression);
			exported.set("default", { local: "#default", node: statement });
		}
	}
	const rawBinding = (local: string, visited = new Set<string>()): string | undefined => {
		if (visited.has(local)) return undefined;
		visited.add(local);
		let expression = bindings.get(local);
		if (!expression) return undefined;
		while (
			ts.isParenthesizedExpression(expression) ||
			ts.isAsExpression(expression) ||
			ts.isTypeAssertionExpression(expression) ||
			ts.isSatisfiesExpression(expression) ||
			ts.isNonNullExpression(expression)
		)
			expression = expression.expression;
		if (ts.isIdentifier(expression)) return rawBinding(expression.text, visited);
		return ts.isCallExpression(expression) &&
			ts.isPropertyAccessExpression(expression.expression) &&
			ts.isIdentifier(expression.expression.expression) &&
			expression.expression.expression.text === "Schema" &&
			/^(?:decode|validate)\w*$/u.test(expression.expression.name.text)
			? local
			: undefined;
	};
	return [...exported].flatMap(([name, site]) => {
		const origin = rawBinding(site.local);
		return origin === undefined ? [] : [{ name, node: site.node, origin }];
	});
}

/**
 * Library entry points parse their input with unary domain parsers that fail with the package's
 * domain error. An exported raw `Schema.decode*` or `Schema.validate*` factory leaks Schema's
 * parse error to every caller instead.
 */
export async function checkDecoderExports(
	root: string,
	baseline: ReadonlySet<string> = rawDecoderExportBaseline
) {
	const failures: string[] = [];
	const found = new Set<string>();
	for (const directory of sourceRoots)
		for (const absolute of await filesUnder(root, directory)) {
			const path = relative(root, absolute).replaceAll("\\", "/");
			if (!/\.tsx?$/u.test(path) || path.endsWith(".d.ts") || testSourcePattern.test(path))
				continue;
			if (!/^(?:apps|packages|extensions)\/[^/]+\/src\//u.test(path)) continue;
			const text = await readFile(absolute, "utf8");
			const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
			for (const { name, node, origin } of rawDecoderExportSites(source)) {
				const site = `${path}:${name}`;
				found.add(site);
				// Existing aliases retain their factory's waiver; the factory must remain in the baseline.
				if (!baseline.has(site) && !baseline.has(`${path}:${origin}`))
					failures.push(
						`${path}:${lineOf(text, node.getStart(source))}: ${name} exports a raw Schema decoder; export a domain parser`
					);
			}
		}
	// A converted site leaves the baseline in the same change, so it cannot come back unnoticed.
	if (root === repositoryRoot && baseline === rawDecoderExportBaseline)
		for (const site of baseline)
			if (!found.has(site))
				failures.push(`scripts/raw-decoder-export-baseline.ts: remove converted ${site}`);
	return failures;
}

/**
 * Exported `make*` functions no other module uses. Each is a public package helper that predates
 * the rule; removing it from the package's exports belongs to that package's entry-point review
 * (Plan 058 D1 for game-text, D13 for the others). Remove an entry once it is no longer exported.
 */
const exportedMakeBaseline = new Set([
	"packages/cameras/src/map-tile-repository.ts:makeMapCaptureRepositoryTestLayer",
	"packages/cameras/src/review-visibility-policy.ts:makeReviewViewId",
	"packages/cameras/src/review-visibility-policy.ts:makeVisibilityPolicyId",
	"packages/config-explorer/src/file-access.ts:makeConfigFileAccessTestLayer",
	"packages/config-explorer/src/service.ts:makeConfigExplorerTestLayer",
	"packages/engine/src/project-launcher.ts:makeUnrealProjectLauncherTestLayer",
	"packages/engine/src/supervised-editor-session.ts:makeSupervisedEditorSessionTestLayer",
	"packages/game-text/src/quality-query.ts:makeTextQualityFindingId",
	"packages/host/src/configuration.ts:makeShedHostConfiguration",
	"packages/host/src/saved-table-index.ts:makeSavedTableIndexTestLayer",
	"packages/project-custodian/src/service.ts:makeCustodianTestLayer",
	"packages/protocol/src/editor-play-session.ts:makeEditorPlaySessionJsonSchema"
]);

/** The parameter list of each exported function or arrow constant, with its name. */
function exportedSignatures(text: string) {
	return [
		...text.matchAll(/export (?:async )?function (\w+)(?:<[^(]*?>)?\(([^)]*)\)/gsu),
		...text.matchAll(/export const (\w+) = (?:<[^(]*?>)?\(([^)]*)\)\s*(?::[^=]*)?=>/gsu)
	].map((match) => ({ name: match[1]!, parameters: match[2]!, offset: match.index }));
}

/**
 * Layers compose through requirements: no exported factory takes a Layer, which hides a
 * dependency a caller can no longer replace. An exported `make*` constructor is used by another
 * module (production or test); one only its own module uses stays private.
 */
export async function checkCompositionPolicy(root: string) {
	const failures: string[] = [];
	const files = (
		await Promise.all(
			[...sourceRoots, "scripts"].map((directory) => filesUnder(root, directory))
		)
	)
		.flat()
		.filter((path) => /\.tsx?$/u.test(path) && !path.endsWith(".d.ts"));
	const texts = new Map<string, string>();
	for (const absolute of files)
		texts.set(relative(root, absolute).replaceAll("\\", "/"), await readFile(absolute, "utf8"));
	for (const [path, text] of texts) {
		if (path.startsWith("scripts/") || testSourcePattern.test(path)) continue;
		if (!/^(?:apps|packages|extensions)\/[^/]+\/src\//u.test(path)) continue;
		for (const { name, parameters, offset } of exportedSignatures(text))
			if (/\bLayer\.Layer</u.test(parameters))
				failures.push(
					`${path}:${lineOf(text, offset)}: ${name} takes a Layer; require its service instead`
				);
		for (const match of text.matchAll(
			/^export (?:const|function|async function) (make[A-Z]\w*)/gmu
		)) {
			const name = match[1]!;
			if (exportedMakeBaseline.has(`${path}:${name}`)) continue;
			const used = new RegExp(`\\b${name}\\b`, "u");
			let elsewhere = false;
			for (const [other, otherText] of texts)
				if (other !== path && used.test(otherText)) {
					elsewhere = true;
					break;
				}
			if (!elsewhere)
				failures.push(
					`${path}:${lineOf(text, match.index)}: ${name} is used only in its module; do not export it`
				);
		}
	}
	return failures;
}

/** Source packages and applications all share the error guidance contract. */
async function errorGuidanceDirectories(root: string) {
	const directories: string[] = [];
	for (const parent of sourceRoots) {
		try {
			for (const entry of await readdir(join(root, parent), { withFileTypes: true }))
				if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
		} catch (cause) {
			if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
				throw cause;
		}
	}
	return directories;
}
const errorGuidanceFieldNames = ["message", "recovery", "retrySafe", "nextStep"];

/** Property names of an object literal, following `...Identifier` spreads declared in the file. */
function objectFieldNames(
	node: ts.Expression,
	locals: ReadonlyMap<string, ts.Expression>,
	seen = new Set<string>()
): Set<string> | undefined {
	if (ts.isIdentifier(node)) {
		if (node.text === "ErrorGuidanceFields") return new Set(errorGuidanceFieldNames);
		if (node.text === "ErrorCauseFields") return new Set(["cause"]);
		const local = locals.get(node.text);
		if (local === undefined || seen.has(node.text)) return undefined;
		seen.add(node.text);
		return objectFieldNames(local, locals, seen);
	}
	if (!ts.isObjectLiteralExpression(node)) return undefined;
	const names = new Set<string>();
	for (const property of node.properties) {
		if (ts.isSpreadAssignment(property)) {
			const spread = objectFieldNames(property.expression, locals, seen);
			if (spread === undefined) return undefined;
			for (const name of spread) names.add(name);
		} else if (property.name !== undefined && ts.isIdentifier(property.name)) {
			names.add(property.name.text);
		}
	}
	return names;
}

/**
 * Every production `Schema.TaggedError` has `message`, `recovery`, `retrySafe` and
 * `nextStep`, so hosts can decide what to do without parsing prose.
 */
export async function checkErrorGuidance(root: string = repositoryRoot) {
	const failures: string[] = [];
	for (const directory of await errorGuidanceDirectories(root)) {
		let files: readonly string[];
		try {
			files = await filesUnder(root, join(directory, "src"));
		} catch {
			continue;
		}
		for (const path of files) {
			if (!/\.tsx?$/u.test(path) || testSourcePattern.test(path)) continue;
			const text = await readFile(path, "utf8");
			if (!text.includes("TaggedError")) continue;
			const label = relative(root, path).replaceAll("\\", "/");
			const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
			const locals = new Map<string, ts.Expression>();
			for (const statement of source.statements)
				if (ts.isVariableStatement(statement))
					for (const declaration of statement.declarationList.declarations)
						if (ts.isIdentifier(declaration.name) && declaration.initializer)
							locals.set(declaration.name.text, declaration.initializer);
			for (const statement of source.statements) {
				if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
				const heritage = statement.heritageClauses?.[0]?.types[0]?.expression;
				// Schema.TaggedError<Self>()("Tag", fields)
				if (
					heritage === undefined ||
					!ts.isCallExpression(heritage) ||
					!heritage.expression.getText(source).startsWith("Schema.TaggedError")
				)
					continue;
				const fields = heritage.arguments[1];
				const names = fields === undefined ? undefined : objectFieldNames(fields, locals);
				const missing =
					names === undefined
						? ["(fields not statically known)"]
						: errorGuidanceFieldNames.filter((name) => !names.has(name));
				if (missing.length > 0)
					failures.push(
						`${label}: ${statement.name.text} must carry ${missing.join(", ")} (spread ErrorGuidanceFields from @ue-shed/protocol)`
					);
			}
		}
	}
	return failures;
}

/**
 * Tagged errors are matched by tag (`Effect.catchTag`/`catchTags`, `Schema.is(ErrorClass)` or
 * `Predicate.isTagged`), never with `instanceof`, which fails across package copies and after a
 * schema round trip.
 */
export async function checkTaggedErrorMatching(root: string = repositoryRoot) {
	const failures: string[] = [];
	const sources: { readonly label: string; readonly text: string }[] = [];
	const tagged = new Set<string>();
	for (const directory of sourceRoots) {
		for (const path of await filesUnder(root, directory)) {
			if (!/\.tsx?$/u.test(path) || testSourcePattern.test(path)) continue;
			const text = await readFile(path, "utf8");
			sources.push({ label: relative(root, path).replaceAll("\\", "/"), text });
			for (const match of text.matchAll(/class\s+(\w+)\s+extends\s+Schema\.TaggedError\b/gu))
				if (match[1] !== undefined) tagged.add(match[1]);
		}
	}
	for (const { label, text } of sources) {
		for (const match of text.matchAll(/\binstanceof\s+(?:\w+\.)?(\w+)/gu)) {
			const name = match[1];
			if (name === undefined || !tagged.has(name)) continue;
			const line = text.slice(0, match.index).split("\n").length;
			failures.push(
				`${label}:${line}: match ${name} by tag (catchTag, Schema.is or Predicate.isTagged), not instanceof`
			);
		}
	}
	return failures;
}

/** Optional causes may be absent; unrelated conditional metadata must not waive retention. */
function optionalCauseSpread(
	expression: ts.Expression,
	locals: ReadonlyMap<string, ts.Expression>
): boolean {
	if (ts.isParenthesizedExpression(expression))
		return optionalCauseSpread(expression.expression, locals);
	if (!ts.isConditionalExpression(expression)) return false;
	const condition = expression.condition;
	if (
		!ts.isBinaryExpression(condition) ||
		condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
		!(
			(ts.isIdentifier(condition.left) && condition.left.text === "undefined") ||
			(ts.isIdentifier(condition.right) && condition.right.text === "undefined")
		) ||
		!ts.isIdentifier(expression.whenTrue) ||
		expression.whenTrue.text !== "undefined"
	)
		return false;
	return objectFieldNames(expression.whenFalse, locals)?.has("cause") ?? false;
}

/** Error adapters retain source failures, including helpers and objects with spread fields. */
export async function checkErrorTranslationCauses(root: string = repositoryRoot) {
	const failures: string[] = [];
	const tagged = new Set<string>();
	const sources: { path: string; text: string }[] = [];
	for (const directory of sourceRoots)
		for (const path of await filesUnder(root, directory)) {
			if (!/\.tsx?$/u.test(path) || testSourcePattern.test(path)) continue;
			const text = await readFile(path, "utf8");
			sources.push({ path, text });
			for (const match of text.matchAll(/class\s+(\w+)\s+extends\s+Schema\.TaggedError\b/gu))
				if (match[1]) tagged.add(match[1]);
		}
	for (const { path, text } of sources) {
		const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
		const label = relative(root, path).replaceAll("\\", "/");
		const visit = (node: ts.Node): void => {
			if (
				(ts.isArrowFunction(node) ||
					ts.isFunctionExpression(node) ||
					ts.isFunctionDeclaration(node) ||
					ts.isMethodDeclaration(node)) &&
				node.body
			) {
				const carrying = new Set(
					node.parameters
						.filter(
							(parameter) =>
								parameter.type &&
								ts.isTypeLiteralNode(parameter.type) &&
								parameter.type.members.some(
									(member) => member.name?.getText(source) === "cause"
								)
						)
						.map((parameter) => parameter.name.getText(source))
				);
				const sourceParameter = node.parameters.some((parameter) =>
					/^(?:cause|error|err|failure|defect)$/u.test(parameter.name.getText(source))
				);
				const parent = node.parent;
				const callback =
					(ts.isPropertyAssignment(parent) && parent.name.getText(source) === "catch") ||
					(ts.isCallExpression(parent) &&
						parent.expression.getText(source) === "Effect.mapError");
				if (sourceParameter || carrying.size || callback) {
					const locals = new Map<string, ts.Expression>();
					const collect = (entry: ts.Node): void => {
						if (ts.isFunctionLike(entry)) return;
						if (
							ts.isVariableDeclaration(entry) &&
							ts.isIdentifier(entry.name) &&
							entry.initializer
						)
							locals.set(entry.name.text, entry.initializer);
						ts.forEachChild(entry, collect);
					};
					collect(node.body);
					const inspect = (entry: ts.Node): void => {
						if (ts.isFunctionLike(entry)) return;
						if (
							ts.isNewExpression(entry) &&
							(entry.expression.getText(source).endsWith("Error") ||
								tagged.has(
									entry.expression.getText(source).split(".").at(-1) ?? ""
								))
						) {
							const fields = entry.arguments?.[0];
							if (fields && ts.isObjectLiteralExpression(fields)) {
								const retained = fields.properties.some((property) =>
									ts.isSpreadAssignment(property)
										? (ts.isIdentifier(property.expression) &&
												carrying.has(property.expression.text)) ||
											objectFieldNames(property.expression, locals)?.has(
												"cause"
											) ||
											optionalCauseSpread(property.expression, locals)
										: property.name?.getText(source) === "cause"
								);
								if (!retained)
									failures.push(
										`${label}:${lineOf(text, entry.getStart(source))}: error translation must retain its original cause`
									);
							}
						}
						ts.forEachChild(entry, inspect);
					};
					inspect(node.body);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return failures;
}

export async function checkArchitecture(root: string = repositoryRoot) {
	return [
		...(await checkCatalogUsage(root)),
		...(await checkSourcePolicy(root)),
		...(await checkServiceStrategies(root)),
		...(await checkDomainServices(root)),
		...(await checkLocalizationBoundaries(root)),
		...(await checkBrowserEntryClosures(root)),
		...(await checkErrorGuidance(root)),
		...(await checkErrorTranslationCauses(root)),
		...(await checkTaggedErrorMatching(root)),
		...(await checkGameTextEntryPoints(root)),
		...(await checkWorkbenchBoundaries(root)),
		...(await checkDecoderExports(root)),
		...(await checkCompositionPolicy(root))
	];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const failures = await checkArchitecture();
	if (failures.length > 0) {
		process.stderr.write(
			`Effect architecture check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`
		);
		process.exitCode = 1;
	} else {
		process.stdout.write("Effect architecture check passed.\n");
	}
}
