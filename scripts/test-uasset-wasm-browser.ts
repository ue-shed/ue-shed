import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDist =
	process.argv[2] === undefined
		? join(repositoryRoot, "packages", "uasset-inspection-wasm", "dist")
		: resolve(process.argv[2]);
const expectedVersion = JSON.parse(
	readFileSync(join(repositoryRoot, "packages", "uasset-inspection-wasm", "package.json"), "utf8")
).version;
const fixture = join(
	repositoryRoot,
	"fixtures",
	"unreal-project",
	"Content",
	"Fixture",
	"Authoring",
	"DT_Scalars.uasset"
);
const requireFromWorkbench = createRequire(
	join(repositoryRoot, "apps", "workbench", "package.json")
);
const { chromium } = requireFromWorkbench("playwright");
interface ContentTypesByExtension {
	readonly [extension: string]: string;
}

const contentTypes: ContentTypesByExtension = {
	".js": "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".json": "application/json"
};

assert.ok(statSync(join(packageDist, "browser.js")).isFile(), "build the browser package first");
const bytes = readFileSync(fixture);
const server = createServer((request, response) => {
	const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	if (requestPath === "/") {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<!doctype html><title>UE Shed WASM smoke test</title>");
		return;
	}
	if (requestPath === "/fixture.uasset") {
		response.writeHead(200, { "content-type": "application/octet-stream" });
		response.end(bytes);
		return;
	}
	if (!requestPath.startsWith("/package/")) {
		response.writeHead(404);
		response.end();
		return;
	}
	const requested = requestPath.slice("/package/".length);
	const candidate = normalize(join(packageDist, requested));
	const packageRelative = relative(packageDist, candidate);
	if (packageRelative.startsWith(`..${sep}`) || packageRelative === "..") {
		response.writeHead(403);
		response.end();
		return;
	}
	try {
		const content = readFileSync(candidate);
		const contentType = contentTypes[extname(candidate)] ?? "application/octet-stream";
		response.writeHead(200, { "content-type": contentType });
		response.end(content);
	} catch {
		response.writeHead(404);
		response.end();
	}
});

await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
const address = server.address();
assert.ok(address instanceof Object, "browser smoke server must listen");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

try {
	const page = await browser.newPage();
	await page.goto(`${origin}/`, { waitUntil: "load" });
	const result = await page.evaluate(async (baseUrl: string) => {
		const errorCode = (cause: unknown): string | undefined =>
			cause instanceof Object && "code" in cause ? String(cause.code) : undefined;
		const module = await import(`${baseUrl}/package/browser.js`);
		if (!(module.createBrowserRuntime instanceof Function)) {
			throw new Error("browser entry is missing createBrowserRuntime");
		}
		const runtime = await module.createBrowserRuntime();
		const response = await fetch(`${baseUrl}/fixture.uasset`);
		const packageBytes = new Uint8Array(await response.arrayBuffer());
		const inspection = runtime.inspect(
			"Content/Fixture/Authoring/DT_Scalars.uasset",
			packageBytes
		);
		const repeated = runtime.inspect(
			"Content/Fixture/Authoring/DT_Scalars.uasset",
			packageBytes
		);
		const malformed = runtime.inspect("Broken.uasset", new Uint8Array([0, 1, 2, 3]));
		let inputLimitCode;
		try {
			const narrowInput = await module.createBrowserRuntime({ maxInputBytes: 4 });
			narrowInput.inspect("TooLarge.uasset", new Uint8Array(5));
		} catch (error) {
			inputLimitCode = errorCode(error);
		}
		let outputLimitCode;
		try {
			const narrowOutput = await module.createBrowserRuntime({ maxOutputBytes: 32 });
			narrowOutput.inspect("DT_Scalars.uasset", packageBytes);
		} catch (error) {
			outputLimitCode = errorCode(error);
		}
		return {
			version: runtime.version(),
			inspection,
			repeated,
			malformed,
			limits: runtime.limits,
			inputLimitCode,
			outputLimitCode
		};
	}, origin);

	assert.equal(result.version, expectedVersion);
	assert.equal(result.inspection.schema_version, 8);
	assert.equal(result.inspection.status, "ok");
	assert.deepEqual(result.repeated, result.inspection);
	assert.equal(result.malformed.schema_version, 8);
	assert.equal(result.malformed.status, "error");
	assert.equal(result.malformed.kind, "unsupported_format");
	assert.equal(result.limits.maxInputBytes, 64 * 1024 * 1024);
	assert.equal(result.inputLimitCode, "UE_SHED_UASSET_WASM_INPUT_LIMIT");
	assert.equal(result.outputLimitCode, "UE_SHED_UASSET_WASM_OUTPUT_LIMIT");
	process.stdout.write("Real browser WASM smoke test passed in Chromium.\n");
} finally {
	await browser.close();
	await new Promise<void>((resolveClosing, reject) =>
		server.close((error) => (error ? reject(error) : resolveClosing()))
	);
}
