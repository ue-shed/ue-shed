import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";

const targetRoot = resolve(import.meta.dirname, "..");

function fail(message) {
	throw new Error(`Data Authoring functional host verification failed: ${message}`);
}

function option(name) {
	const prefix = `--${name}=`;
	return process.argv
		.slice(2)
		.find((argument) => argument.startsWith(prefix))
		?.slice(prefix.length);
}

const projectRoot = option("project");
const reader = option("reader");
const remoteControlEndpoint = option("endpoint");
const expectedTableCount = option("expected-table-count");
if (!projectRoot) fail("pass --project=<unreal-project-root>");
if (!reader) fail("pass --reader=<uasset-executable>");
if (expectedTableCount !== undefined && !/^\d+$/.test(expectedTableCount)) {
	fail("--expected-table-count must be a non-negative integer");
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
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") fail("could not allocate a local port");
	await new Promise((resolveClose, reject) =>
		server.close((error) => (error ? reject(error) : resolveClose()))
	);
	return address.port;
}

function terminateProcessTree(pid) {
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

const port = await availablePort();
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
		UE_SHED_PROJECT_ROOT: resolve(projectRoot),
		UE_SHED_UASSET_EXECUTABLE: resolve(reader),
		...(remoteControlEndpoint === undefined
			? {}
			: { UE_SHED_REMOTE_CONTROL_ENDPOINT: remoteControlEndpoint })
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
const post = async (payload) => {
	const response = await fetch(endpoint, {
		body: JSON.stringify(payload),
		headers: { "content-type": "application/json" },
		method: "POST"
	});
	if (!response.ok) fail(`host returned HTTP ${response.status}`);
	return await response.json();
};

try {
	let catalog;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			catalog = await post({ operation: "load_configured_catalog" });
			break;
		} catch {
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
	}
	if (!catalog) fail(`host did not become ready\n${stdout}\n${stderr}`);
	if (catalog.status !== "success" || catalog.value?.status !== "ready") {
		fail(`catalog failed: ${JSON.stringify(catalog)}`);
	}
	if (
		expectedTableCount !== undefined &&
		catalog.value.tables.length !== Number(expectedTableCount)
	) {
		fail(
			`discovered ${catalog.value.tables.length} tables, expected ${Number(expectedTableCount)}`
		);
	}
	const objectPath = catalog.value.tables[0]?.objectPath;
	if (!objectPath) fail("catalog contained no openable DataTable");
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
		fail(`could not open ${objectPath}: ${JSON.stringify(opened)}`);
	}
	console.log(
		`Data Authoring functional host verification passed: ${catalog.value.tables.length} ` +
			`project DataTables discovered; ${objectPath} opened.`
	);
} finally {
	terminateProcessTree(child.pid);
}
