import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDirectory = join(repositoryRoot, "packages", "uasset-inspection-wasm");
const browserTest = join(repositoryRoot, "scripts", "test-uasset-wasm-browser.ts");
const typescriptCompiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
const fixture = join(
	repositoryRoot,
	"fixtures",
	"unreal-project",
	"Content",
	"Fixture",
	"Authoring",
	"DT_Scalars.uasset"
);
const blueprintFixture = join(
	repositoryRoot,
	"fixtures",
	"unreal-project",
	"Content",
	"Fixture",
	"Blueprints",
	"BP_GraphFixture.uasset"
);
const tempDirectory = mkdtempSync(join(tmpdir(), "ue-shed-uasset-inspection-wasm-"));
const packDirectory = join(tempDirectory, "pack");
const consumerDirectory = join(tempDirectory, "consumer");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

try {
	writeFileSync(join(tempDirectory, "package.json"), '{"private":true}\n');
	execPackageTool(pnpmCommand, ["pack", "--pack-destination", packDirectory], {
		cwd: packageDirectory,
		encoding: "utf8",
		stdio: "inherit"
	});
	const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
	assert.equal(tarballs.length, 1, "the package must produce exactly one tarball");
	const tarballName = tarballs[0];
	assert.ok(tarballName, "the package tarball must have a filename");
	const tarball = join(packDirectory, tarballName);

	writeFileSync(join(consumerDirectory, "package.json"), '{"private":true,"type":"module"}\n');
	execPackageTool(
		npmCommand,
		["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
		{
			cwd: consumerDirectory,
			encoding: "utf8",
			stdio: "inherit"
		}
	);
	const installedPackage = join(
		consumerDirectory,
		"node_modules",
		"@ue-shed",
		"uasset-inspection-wasm"
	);

	copyFileSync(fixture, join(consumerDirectory, "DT_Scalars.uasset"));
	copyFileSync(blueprintFixture, join(consumerDirectory, "BP_GraphFixture.uasset"));
	const consumerCode = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNodeRuntime as createRootRuntime } from "@ue-shed/uasset-inspection-wasm";
import { createNodeRuntime, extractBlueprints, inspect } from "@ue-shed/uasset-inspection-wasm/node";
import * as browserEntry from "@ue-shed/uasset-inspection-wasm/browser";
const bytes = readFileSync("DT_Scalars.uasset");
const blueprintBytes = readFileSync("BP_GraphFixture.uasset");
const runtime = createNodeRuntime();
const result = runtime.inspect("DT_Scalars.uasset", bytes);
const blueprint = runtime.extractBlueprints("BP_GraphFixture.uasset", blueprintBytes);
assert.equal(result.schema_version, 8);
assert.equal(result.status, "ok");
assert.equal(blueprint.status, "ok");
assert.ok(blueprint.blueprints[0].graphs.length > 0);
assert.ok(blueprint.blueprints[0].graphs.flatMap((graph) => graph.nodes).length > 0);
assert.deepEqual(extractBlueprints("BP_GraphFixture.uasset", blueprintBytes), blueprint);
assert.deepEqual(inspect("DT_Scalars.uasset", bytes), result);
assert.deepEqual(createRootRuntime().inspect("DT_Scalars.uasset", bytes), result);
assert.throws(() => createNodeRuntime({ maxInputBytes: 4 }).inspect("large.uasset", new Uint8Array(5)), (error) => error?.code === "UE_SHED_UASSET_WASM_INPUT_LIMIT");
assert.throws(() => runtime.inspect("large.uasset", new Uint8Array(runtime.limits.maxInputBytes + 1)), (error) => error?.code === "UE_SHED_UASSET_WASM_INPUT_LIMIT");
assert.throws(() => createNodeRuntime({ maxOutputBytes: 32 }).inspect("DT_Scalars.uasset", bytes), (error) => error?.code === "UE_SHED_UASSET_WASM_OUTPUT_LIMIT");
assert.equal(typeof browserEntry.createBrowserRuntime, "function");
assert.equal(typeof browserEntry.extractBlueprints, "function");
console.log(JSON.stringify({ version: runtime.version(), schemaVersion: result.schema_version, status: result.status, blueprintStatus: blueprint.status, nodeSubpath: true, browserSubpath: true }));
`;
	const output = execFileSync(process.execPath, ["--input-type=module", "--eval", consumerCode], {
		cwd: consumerDirectory,
		encoding: "utf8"
	});
	const evidenceLine = output.trim().split(/\r?\n/).at(-1);
	assert.ok(evidenceLine, "the packed consumer must emit JSON evidence");
	const evidence = JSON.parse(evidenceLine);
	assert.equal(evidence.schemaVersion, 8);
	assert.equal(evidence.status, "ok");
	assert.equal(evidence.blueprintStatus, "ok");
	assert.equal(evidence.nodeSubpath, true);
	assert.equal(evidence.browserSubpath, true);

	const declarationConsumer = join(consumerDirectory, "consumer-types.ts");
	writeFileSync(
		declarationConsumer,
		`import { createNodeRuntime as createRootRuntime, type BlueprintResult, type InspectionResult } from "@ue-shed/uasset-inspection-wasm";
import { createNodeRuntime, extractBlueprints, type WasmRuntime } from "@ue-shed/uasset-inspection-wasm/node";
import { createBrowserRuntime, extractBlueprints as extractBlueprintsInBrowser, type BrowserRuntimeOptions } from "@ue-shed/uasset-inspection-wasm/browser";
const bytes = new Uint8Array();
const result: InspectionResult = createRootRuntime().inspect("fixture.uasset", bytes);
const runtime: WasmRuntime = createNodeRuntime();
const blueprint: BlueprintResult = extractBlueprints("fixture.uasset", bytes);
const options: BrowserRuntimeOptions = { maxInputBytes: 1 };
void result;
void runtime;
void blueprint;
void extractBlueprintsInBrowser("fixture.uasset", bytes);
void createBrowserRuntime(options);
`
	);
	execFileSync(
		process.execPath,
		[
			typescriptCompiler,
			"--noEmit",
			"--strict",
			"--module",
			"NodeNext",
			"--moduleResolution",
			"NodeNext",
			"--target",
			"ES2022",
			"--lib",
			"ES2022,DOM",
			declarationConsumer
		],
		{ cwd: consumerDirectory, encoding: "utf8", stdio: "inherit" }
	);

	execFileSync(process.execPath, [browserTest, join(installedPackage, "dist")], {
		cwd: repositoryRoot,
		encoding: "utf8",
		stdio: "inherit"
	});
	process.stdout.write(
		"Clean packed-consumer Node/browser exports, declarations, and Chromium runtime passed.\n"
	);
} finally {
	rmSync(tempDirectory, { recursive: true, force: true });
}

interface PackageToolOptions {
	readonly cwd: string;
	readonly encoding: "utf8";
	readonly stdio: "inherit";
}

function execPackageTool(program: string, args: readonly string[], options: PackageToolOptions) {
	if (process.platform !== "win32") {
		return execFileSync(program, args, options);
	}
	const commandLine = [program, ...args].map(quoteWindowsArgument).join(" ");
	return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], options);
}

function quoteWindowsArgument(value: string) {
	const text = String(value);
	return /[\s"&|<>^]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
