import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonObject, type JsonObject } from "./json.ts";

interface HostResponse {
	readonly status?: unknown;
	readonly value?: {
		readonly status?: unknown;
		readonly tables?: ReadonlyArray<{ readonly objectPath?: string }>;
		readonly snapshot?: { readonly table?: { readonly objectPath?: string } };
	};
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const materializer = join(
	repositoryRoot,
	"extensions",
	"data-authoring",
	"adoption",
	"materialize.mjs"
);
const targetRoot = join(repositoryRoot, "test-results", "data-authoring-adoption");
const cargoTargetDirectory = process.env.CARGO_TARGET_DIR ?? join(targetRoot, "target");

function fail(message: string): never {
	throw new Error(`Data Authoring adoption conformance failed: ${message}`);
}

function run(command: string, args: readonly string[], cwd: string = repositoryRoot) {
	const result = spawnSync(command, args, {
		cwd,
		env: { ...process.env, CI: "1", NODE_AUTH_TOKEN: "", NPM_TOKEN: "" },
		shell: false,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) fail(`${command} ${args.join(" ")} exited ${result.status ?? 1}`);
}

function runPnpm(args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
	const pnpmScript = process.env.npm_execpath;
	const scriptIsJavaScript = pnpmScript ? /\.(?:c|m)?js$/i.test(pnpmScript) : false;
	const command = scriptIsJavaScript
		? process.execPath
		: (pnpmScript ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm"));
	const prefix = scriptIsJavaScript && pnpmScript ? [pnpmScript] : [];
	const result = spawnSync(command, [...prefix, ...args], {
		cwd: targetRoot,
		env: {
			...process.env,
			...environment,
			CI: "1",
			NODE_AUTH_TOKEN: "",
			NPM_TOKEN: ""
		},
		shell: process.platform === "win32" && (!pnpmScript || /\.(?:cmd|bat)$/i.test(pnpmScript)),
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) fail(`pnpm ${args.join(" ")} exited ${result.status ?? 1}`);
}

function pnpmCommand() {
	const pnpmScript = process.env.npm_execpath;
	const scriptIsJavaScript = pnpmScript ? /\.(?:c|m)?js$/i.test(pnpmScript) : false;
	return {
		args: scriptIsJavaScript && pnpmScript ? [pnpmScript] : [],
		command: scriptIsJavaScript
			? process.execPath
			: (pnpmScript ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm"))
	};
}

async function availablePort() {
	const server = createServer();
	await new Promise<void>((resolveListening, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListening);
	});
	const address = server.address();
	if (!(address instanceof Object)) fail("could not allocate a host conformance port");
	await new Promise<void>((resolveClosing, reject) =>
		server.close((error) => (error ? reject(error) : resolveClosing()))
	);
	return address.port;
}

function terminateProcessTree(pid: number) {
	if (process.platform === "win32") {
		spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true
		});
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		process.kill(pid, "SIGTERM");
	}
}

async function verifyFunctionalHost(remoteControlEndpoint: string) {
	const port = await availablePort();
	const fixtureRoot = join(repositoryRoot, "fixtures", "unreal-project");
	const reader = join(
		cargoTargetDirectory,
		"release",
		process.platform === "win32" ? "uasset.exe" : "uasset"
	);
	const pnpm = pnpmCommand();
	const child = spawn(pnpm.command, [...pnpm.args, "start"], {
		cwd: targetRoot,
		detached: process.platform !== "win32",
		env: {
			...process.env,
			CI: "1",
			NODE_AUTH_TOKEN: "",
			NPM_TOKEN: "",
			UE_SHED_HOST_PORT: String(port),
			UE_SHED_PROJECT_ROOT: fixtureRoot,
			UE_SHED_REMOTE_CONTROL_ENDPOINT: remoteControlEndpoint,
			UE_SHED_UASSET_EXECUTABLE: reader
		},
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));

	const endpoint = `http://127.0.0.1:${port}/api/authoring`;
	const post = async (payload: JsonObject): Promise<HostResponse> => {
		const response = await fetch(endpoint, {
			body: JSON.stringify(payload),
			headers: { "content-type": "application/json" },
			method: "POST"
		});
		if (!response.ok) fail(`functional host returned HTTP ${response.status}`);
		// SAFETY: The functional host endpoint is validated through the assertions below.
		return parseJsonObject(await response.text()) as HostResponse;
	};

	try {
		let catalog: HostResponse | undefined;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				catalog = await post({ operation: "load_configured_catalog" });
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		if (!catalog) fail(`functional host did not become ready\n${stdout}\n${stderr}`);
		if (catalog.status !== "success" || catalog.value?.status !== "ready") {
			fail(`functional host catalog failed: ${JSON.stringify(catalog)}`);
		}
		if (catalog.value?.tables?.length !== 12) {
			fail(
				`functional host discovered ${catalog.value?.tables?.length ?? 0} fixture tables, expected 12`
			);
		}
		const objectPath = catalog.value.tables[0]?.objectPath;
		if (!objectPath) fail("functional host catalog contained no openable table");
		const opened = await post({
			authority: "saved",
			objectPath,
			operation: "open_catalog_table"
		});
		if (
			opened.status !== "success" ||
			opened.value?.status !== "ready" ||
			opened.value.snapshot?.table?.objectPath !== objectPath
		) {
			fail(`functional host could not open ${objectPath}: ${JSON.stringify(opened)}`);
		}
		return { objectPath, tableCount: catalog.value.tables.length };
	} finally {
		if (child.pid !== undefined) terminateProcessTree(child.pid);
	}
}

async function filesUnder(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (["dist", "node_modules"].includes(entry.name)) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await filesUnder(path)));
		else files.push(path);
	}
	return files;
}

function digest(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

const commit = spawnSync("git.exe", ["rev-parse", "HEAD"], {
	cwd: repositoryRoot,
	encoding: "utf8",
	windowsHide: true
});
if (commit.status !== 0) fail("could not resolve the source commit");
const sourceCommit = commit.stdout.trim();

await rm(targetRoot, { force: true, recursive: true });
await mkdir(dirname(targetRoot), { recursive: true });
run(process.execPath, [materializer, "--target", targetRoot, "--source-commit", sourceCommit]);

// SAFETY: the materializer just wrote this adoption manifest; assertions below verify its contents.
const manifest = JSON.parse(
	await readFile(join(targetRoot, ".ue-shed", "data-authoring", "adoption.manifest.json"), "utf8")
) as {
	readonly copy: { readonly kernel: readonly string[]; readonly owned: readonly string[] };
};
const declaredEntries = [...manifest.copy.kernel, ...manifest.copy.owned];
if (declaredEntries.some((entry) => entry.includes(".test."))) {
	fail("materialized production closure includes source-side tests");
}

for (const path of await filesUnder(targetRoot)) {
	if (!/\.(?:css|html|js|json|mjs|ts|tsx|yaml)$/i.test(path)) continue;
	const content = await readFile(path, "utf8");
	if (/apps[\\/]workbench|window\.ueShed|from ["']electron/.test(content)) {
		fail(`Workbench or Electron authority leaked into ${relative(targetRoot, path)}`);
	}
}

runPnpm(["install", "--ignore-scripts", "--frozen-lockfile=false"]);
await rm(join(targetRoot, "node_modules"), { recursive: true, force: true });
runPnpm(["install", "--offline", "--ignore-scripts", "--frozen-lockfile"]);
runPnpm(["build"]);
runPnpm(["build:reader"]);
const cssPath = join(targetRoot, "app", "dist", "stylex.css");
const initialCss = await readFile(cssPath, "utf8");
if (initialCss.length === 0) fail("initial production stylex.css is empty");

const themePath = join(targetRoot, "packages", "ui-theme", "src", "themes.stylex.ts");
const initialTheme = await readFile(themePath, "utf8");
const initialAccent = /colorAccent:\s*"(#[0-9a-fA-F]{6})"/.exec(initialTheme)?.[1];
const divergentAccent = "#ff6b6b";
if (initialAccent === undefined || initialAccent === divergentAccent) {
	fail("could not find the single applied accent to diverge");
}
await writeFile(
	themePath,
	initialTheme.replace(`colorAccent: "${initialAccent}"`, `colorAccent: "${divergentAccent}"`)
);

runPnpm(["verify", "--", `--expected-accent=${divergentAccent}`]);
const divergentCss = await readFile(cssPath, "utf8");
if (digest(divergentCss) === digest(initialCss))
	fail("theme divergence did not change production CSS");

// This gate verifies the copied host against the saved fixture project. Keep a developer's live
// editor from contributing tables from an unrelated project through the default endpoint.
const isolatedRemoteControlEndpoint = `http://127.0.0.1:${await availablePort()}`;
const functionalHost = await verifyFunctionalHost(isolatedRemoteControlEndpoint);
runPnpm([
	"verify:host",
	"--",
	`--endpoint=${isolatedRemoteControlEndpoint}`,
	`--project=${join(repositoryRoot, "fixtures", "unreal-project")}`,
	`--reader=${join(
		cargoTargetDirectory,
		"release",
		process.platform === "win32" ? "uasset.exe" : "uasset"
	)}`,
	"--expected-table-count=12"
]);

console.log(
	`Data Authoring adoption conformance passed: ${declaredEntries.length} declared entries, ` +
		`${initialCss.length} initial CSS bytes, ${functionalHost.tableCount} real fixture tables, ` +
		`${functionalHost.objectPath} opened through the copied host.`
);
