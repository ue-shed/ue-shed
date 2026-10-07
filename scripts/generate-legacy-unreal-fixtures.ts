import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	legacyAssetNames,
	legacyVersions,
	readLegacyEvidence
} from "../fixtures/legacy-unreal-project/evidence.ts";
import { repositoryRoot, unrealEngineTools, unrealEngineVersion } from "./unreal-plugin-host.ts";
import { installedEngineRoot, parseUnrealDescriptor } from "./unreal-project-support.ts";

const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument !== "--update" && !argument.startsWith("--results="))) {
	throw new Error("Usage: pnpm fixture:generate-legacy [--update] [--results=<file>]");
}
const update = arguments_.includes("--update");
const resultsPath = arguments_.find((argument) => argument.startsWith("--results="))?.slice(10);
const source = join(repositoryRoot, "fixtures", "legacy-unreal-project");
const omitted = new Set([
	"Binaries",
	"Intermediate",
	"Saved",
	"DerivedDataCache",
	".vs",
	"Generated",
	"Content"
]);
const outputParent = join(repositoryRoot, "out");
mkdirSync(outputParent, { recursive: true });
const output = mkdtempSync(join(outputParent, "legacy-unreal-fixtures-"));
process.stdout.write(`Legacy Unreal fixture logs and assets: ${output}\n`);

function run(log: string, command: string, args: readonly string[]) {
	process.stdout.write(`Running ${basename(log)}\n`);
	const batch = /\.(bat|cmd)$/iu.test(command);
	const executable = batch
		? [command, ...args].map((argument) => `"${argument.replaceAll('"', '""')}"`).join(" ")
		: command;
	const descriptor = openSync(log, "w");
	try {
		const result = spawnSync(executable, batch ? [] : args, {
			cwd: repositoryRoot,
			shell: batch,
			stdio: ["ignore", descriptor, descriptor],
			windowsHide: true,
			timeout: 900_000
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`${basename(command)} failed (${result.status}); see ${log}`);
		}
	} finally {
		closeSync(descriptor);
	}
}

const results: Array<{
	version: string;
	status: "passed" | "failed" | "skipped";
	message: string;
}> = [];
for (const version of legacyVersions) {
	const variable = `UE_SHED_UNREAL_${version.replace(".", "")}_ROOT`;
	const configured = process.env[variable] ?? installedEngineRoot({ version });
	const compilerVersion =
		process.env[`UE_SHED_UNREAL_${version.replace(".", "")}_COMPILER_VERSION`];
	if (!configured || !existsSync(join(configured, "Engine", "Source"))) {
		const message = `Set ${variable} to an Unreal ${version} installation with Engine/Source.`;
		results.push({ version, status: "skipped", message });
		process.stdout.write(`SKIP UE ${version}: ${message}\n`);
		continue;
	}
	const root = join(output, version);
	mkdirSync(root);
	try {
		const engineRoot = resolve(configured);
		assert.equal(
			unrealEngineVersion(engineRoot)?.label,
			version,
			`${variable}: engine version`
		);
		const tools = unrealEngineTools(engineRoot);
		for (const tool of [tools.build, tools.editorCommandlet]) {
			assert.ok(existsSync(tool), `Missing engine tool: ${tool}`);
		}
		const project = join(root, "project");
		cpSync(source, project, {
			recursive: true,
			filter: (path) => !omitted.has(basename(path))
		});
		const projectPath = join(project, "UEShedLegacyFixture.uproject");
		const descriptor = parseUnrealDescriptor(readFileSync(projectPath, "utf8"));
		writeFileSync(
			projectPath,
			`${JSON.stringify({ ...descriptor, EngineAssociation: version }, null, "\t")}\n`
		);
		run(join(root, "build-editor.log"), tools.build, [
			"UEShedLegacyFixtureEditor",
			"Win64",
			"Development",
			`-Project=${projectPath}`,
			"-WaitMutex",
			"-NoHotReloadFromIDE",
			// UE 5.x UnrealBuildTool otherwise shares one default log across concurrent builds.
			`-Log=${join(root, "ubt.log")}`,
			// UE 5.3 headers reject MSVC 14.40+; pin an older installed toolset where needed.
			...(compilerVersion ? [`-CompilerVersion=${compilerVersion}`] : [])
		]);
		const commandletArguments = [
			"-unattended",
			"-nop4",
			"-nosplash",
			"-NullRHI",
			"-UTF8Output"
		];
		run(join(root, "save-assets.log"), tools.editorCommandlet, [
			projectPath,
			"-run=UEShedLegacyFixtureBuild",
			...commandletArguments
		]);
		// Capture loaded-package evidence in a separate editor process.
		run(join(root, "reload-evidence.log"), tools.editorCommandlet, [
			projectPath,
			"-run=UEShedLegacyFixtureEvidence",
			`-Evidence=${join(root, "evidence.json")}`,
			...commandletArguments
		]);
		const actual = readLegacyEvidence(root);
		assert.equal(actual.engine_version, version);
		const generated = join(source, "Generated", version);
		const assetPaths = legacyAssetNames.map((name) => ({
			source: join(project, "Content", "Legacy", `${name}.uasset`),
			destination: join(generated, "Content", "Legacy", `${name}.uasset`)
		}));
		for (const asset of assetPaths) {
			assert.ok(existsSync(asset.source), `Not saved: ${asset.source}`);
		}
		if (update) {
			mkdirSync(join(generated, "Content", "Legacy"), { recursive: true });
			for (const asset of assetPaths) copyFileSync(asset.source, asset.destination);
			copyFileSync(join(root, "evidence.json"), join(generated, "evidence.json"));
			copyFileSync(projectPath, join(generated, "UEShedLegacyFixture.uproject"));
		} else {
			assert.deepEqual(
				actual,
				readLegacyEvidence(generated),
				`UE ${version}: evidence drift`
			);
			for (const asset of assetPaths) {
				assert.ok(
					existsSync(asset.destination),
					`Missing committed fixture: ${asset.destination}`
				);
			}
		}
		const message = update ? "saved fixtures and loaded evidence updated" : "evidence matches";
		results.push({ version, status: "passed", message });
		process.stdout.write(`PASS UE ${version}: ${message}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		results.push({ version, status: "failed", message });
		process.stderr.write(`FAIL UE ${version}: ${message}\n`);
	}
}
writeFileSync(join(output, "results.json"), `${JSON.stringify(results, null, "\t")}\n`);
if (resultsPath) writeFileSync(resolve(resultsPath), `${JSON.stringify(results, null, "\t")}\n`);
if (results.some((result) => result.status === "failed")) process.exitCode = 1;
