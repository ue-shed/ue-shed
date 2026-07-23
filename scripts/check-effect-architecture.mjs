import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoots = ["apps", "packages", "extensions"];
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
	// Same pattern for the actor transform feed's per-socket decode-and-publish fork.
	"packages/observatory/src/actor-feed.ts"
]);
const approvedPromiseAdapters = new Set([
	// The CLI plugin installer owns filesystem/archive promises behind an Effect boundary.
	"apps/cli/src/plugin-installer.ts",
	"apps/workbench/src/main/adapters/electron-app.ts",
	"apps/workbench/src/main/adapters/electron-ipc.ts",
	"apps/workbench/src/main/preload.ts",
	"apps/workbench/src/renderer/asset-audits-client.ts",
	"apps/workbench/src/renderer/authoring-client.ts",
	"apps/workbench/src/renderer/game-text-client.ts",
	"apps/workbench/src/renderer/global.d.ts",
	"apps/workbench/src/renderer/map-review-client.ts",
	"apps/workbench/src/renderer/workbench-client.ts",
	"extensions/data-authoring/adoption/consumer/server/src/index.ts",
	"packages/cameras/src/index.ts",
	"packages/cameras/src/review-repository.ts",
	"packages/authoring-sdk/src/index.ts",
	// The synthetic benchmark invokes Playwright as its foreign child-process adapter.
	"packages/observatory/scripts/benchmark.ts",
	"packages/observatory/src/actor-feed.ts",
	"packages/unreal-assets/src/index.ts"
]);
const approvedEnvironmentAdapters = new Set([
	"apps/cli/src/index.ts",
	"apps/workbench/src/main/main.ts",
	// The synthetic benchmark forwards the process environment to its Playwright child.
	"packages/observatory/scripts/benchmark.ts"
]);
const approvedRawFetchAdapters = new Set([
	"packages/authoring-sdk/src/index.ts",
	"packages/unreal-connection/src/remote-control-client.ts"
]);
const approvedResourceAdapters = new Set([
	"apps/workbench/src/main/adapters/electron-app.ts",
	"apps/workbench/src/main/adapters/fixture-process.ts",
	"apps/workbench/src/main/main.ts",
	"apps/workbench/src/main/preload.ts",
	"apps/workbench/src/renderer/app-shell.tsx",
	"apps/workbench/src/renderer/index.tsx",
	// The static-site Observatory mock owns its display-only timers through Solid cleanup.
	"apps/site/src/showcase/ObservatoryMock.tsx",
	// The copied adoption host owns its browser runtime lifecycle at the foreign framework boundary.
	"extensions/data-authoring/adoption/consumer/app/src/index.tsx",
	"extensions/data-authoring/adoption/consumer/server/src/index.ts",
	"packages/cameras/src/index.ts",
	// The actor feed owns its named-pipe server and per-connection sockets through Effect.acquireRelease.
	"packages/observatory/src/actor-feed.ts",
	// The saved-asset adapter owns and cancels the bounded native catalog child process.
	"packages/unreal-assets/src/index.ts"
]);
const operationlessServices = new Set(["apps/workbench/src/main/workbench-config.ts"]);
const externalServiceEvidence = new Map([
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
		"extensions/game-text/src/game-text-client.ts",
		[
			"apps/workbench/src/renderer/index.tsx",
			"extensions/game-text/src/game-text-route.component.test.tsx"
		]
	]
]);

const workbenchMainBootstrap = "apps/workbench/src/main/main.ts";
const workbenchMainAdaptersPrefix = "apps/workbench/src/main/adapters/";
const workbenchRendererPrefix = "apps/workbench/src/renderer/";
const rendererTransportFiles = new Set([
	"apps/workbench/src/renderer/asset-audits-client.ts",
	"apps/workbench/src/renderer/authoring-client.ts",
	"apps/workbench/src/renderer/game-text-client.ts",
	"apps/workbench/src/renderer/global.d.ts",
	"apps/workbench/src/renderer/map-review-client.ts",
	"apps/workbench/src/renderer/workbench-client.ts"
]);

function isWorkbenchMainSource(path) {
	return path.startsWith("apps/workbench/src/main/") && path.endsWith(".ts");
}

function isWorkbenchBootstrapOrAdapter(path) {
	return path === workbenchMainBootstrap || path.startsWith(workbenchMainAdaptersPrefix);
}

async function filesUnder(root, directory) {
	const absolute = join(root, directory);
	let entries;
	try {
		entries = await readdir(absolute, { withFileTypes: true });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const files = [];
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "e2e")
			continue;
		const path = join(absolute, entry.name);
		if (entry.isDirectory()) files.push(...(await filesUnder(root, relative(root, path))));
		else files.push(path);
	}
	return files;
}

function lineOf(text, offset) {
	return text.slice(0, offset).split("\n").length;
}

function reportOccurrences(failures, path, text, needle, message) {
	let offset = 0;
	while ((offset = text.indexOf(needle, offset)) !== -1) {
		failures.push(`${path}:${lineOf(text, offset)}: ${message}`);
		offset += needle.length;
	}
}

export async function checkSourcePolicy(root) {
	const failures = [];
	const sourceFiles = (
		await Promise.all(sourceRoots.map((directory) => filesUnder(root, directory)))
	).flat();
	for (const absolute of sourceFiles) {
		if (!/\.tsx?$/.test(absolute) || /\.(?:integration\.)?test\.tsx?$/.test(absolute)) continue;
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

export async function checkCatalogUsage(root) {
	const failures = [];
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
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		for (const section of [
			"dependencies",
			"devDependencies",
			"peerDependencies",
			"optionalDependencies"
		]) {
			for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
				if (catalogOwned.has(dependency) && version !== "catalog:") {
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

export async function checkServiceStrategies(root = repositoryRoot) {
	const failures = [];
	const sourceFiles = (
		await Promise.all(sourceRoots.map((directory) => filesUnder(root, directory)))
	).flat();
	for (const absolute of sourceFiles) {
		if (!/\.tsx?$/.test(absolute) || /(?:integration\.)?test\.tsx?$/.test(absolute)) continue;
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

export async function checkDomainServices(root = repositoryRoot) {
	const required = [
		["packages/asset-audits/src/texture.ts", "export class TextureAudit"],
		["packages/game-text/src/corpus.ts", "export class TextCorpusService"],
		["packages/authoring-catalog/src/index.ts", "export class AuthoringCatalog"],
		["packages/authoring/src/session-service.ts", "export class AuthoringSessions"],
		["packages/cameras/src/review-capture.ts", "export class ReviewCapture"],
		["packages/cameras/src/review-authoring-live.ts", "export class ReviewAuthoring"]
	];
	const failures = [];
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
	if (!capture.includes("discardStaging")) {
		failures.push(
			"packages/cameras/src/review-capture.ts: capture must discard staging on non-promotion exits"
		);
	}
	const finalizeRun = capture.indexOf(".finalizeRun(");
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
		authoring.includes("ReviewAuthoringShape")
	) {
		const shape = authoring.slice(
			authoring.indexOf("export interface ReviewAuthoringShape"),
			authoring.indexOf("export class ReviewAuthoring")
		);
		if (shape.includes("RemoteControlClient")) {
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
	const sessionShape = sessions.slice(
		sessions.indexOf("export interface AuthoringSessionService"),
		sessions.indexOf("export interface AuthoringSessionServiceConfig")
	);
	if (sessionShape.includes("port: AuthoringLivePort")) {
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

export async function checkWorkbenchBoundaries(root = repositoryRoot) {
	const failures = [];
	const sourceFiles = (
		await Promise.all(sourceRoots.map((directory) => filesUnder(root, directory)))
	).flat();

	for (const absolute of sourceFiles) {
		if (!/\.tsx?$/.test(absolute) || /\.(?:integration\.)?test\.tsx?$/.test(absolute)) continue;
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

export async function checkArchitecture(root = repositoryRoot) {
	return [
		...(await checkCatalogUsage(root)),
		...(await checkSourcePolicy(root)),
		...(await checkServiceStrategies(root)),
		...(await checkDomainServices(root)),
		...(await checkWorkbenchBoundaries(root))
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
