import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { isJsonObject, isJsonString, parseJsonObject } from "./json.ts";
import { repositoryRoot, unrealEngineTools, unrealEngineVersion } from "./unreal-plugin-host.ts";

// Require both engines before starting work. The ordinary fixture command remains the
// committed 5.7 baseline; this lane generates disposable assets for each engine.
const engines = ["5.7", "5.8"].map((version) => {
	const variable = `UE_SHED_UNREAL_${version.replace(".", "")}_ROOT`;
	const configured = process.env[variable] ?? process.env.UE_SHED_UNREAL_ENGINE_ROOT;
	if (!configured || unrealEngineVersion(configured)?.label !== version) {
		throw new Error(`Set ${variable} to an Unreal ${version} installation with Engine/Source.`);
	}
	return { version, root: resolve(configured) };
});

const outputParent = join(repositoryRoot, "out");
mkdirSync(outputParent, { recursive: true });
const output = mkdtempSync(join(outputParent, "uasset-engine-matrix-"));
process.stdout.write(`UAsset engine matrix evidence: ${output}\n`);

function run(
	log: string,
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env
) {
	process.stdout.write(`Running ${basename(log)}\n`);
	const batch = /\.(bat|cmd)$/iu.test(command);
	const executable = batch
		? [command, ...args].map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ")
		: command;
	const descriptor = openSync(log, "w");
	try {
		const result = spawnSync(executable, batch ? [] : args, {
			cwd: repositoryRoot,
			env,
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

const packageManager =
	process.env.npm_execpath ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
const packageManagerIsScript = /\.(?:c|m)?js$/iu.test(packageManager);
for (const name of ["protocol", "unreal-assets"])
	run(
		join(output, `build-${name}.log`),
		packageManagerIsScript ? process.execPath : packageManager,
		[
			...(packageManagerIsScript ? [packageManager] : []),
			"--filter",
			`@ue-shed/${name}`,
			"build"
		]
	);
run(join(output, "build-native.log"), "cargo", ["build", "--locked", "-p", "uasset-io"]);
run(join(output, "build-wasm.log"), process.execPath, ["scripts/build-uasset-wasm.ts"]);

const results: Array<{ version: string; status: "passed" | "failed"; error?: string }> = [];
const fixtureSource = join(repositoryRoot, "fixtures", "unreal-project");
const omittedDirectories = new Set([
	"Binaries",
	"Intermediate",
	"Saved",
	"DerivedDataCache",
	".vs"
]);
for (const engine of engines) {
	const root = join(output, engine.version);
	mkdirSync(root);
	try {
		const bagModel = parseJsonObject(
			readFileSync(
				join(repositoryRoot, "crates/uasset-parser/source-models/ue58-property-bags.json"),
				"utf8"
			)
		);
		if (engine.version === "5.8") {
			run(join(root, "property-bag-codegen.log"), "cargo", [
				"run",
				"--locked",
				"-p",
				"uasset-source-gen",
				"--",
				"check",
				"--config",
				"crates/uasset-source-gen/config/ue58-property-bags.json",
				"--engine-source",
				join(engine.root, "Engine", "Source"),
				"--workspace",
				repositoryRoot,
				"--output",
				"crates/uasset-parser/source-models/ue58-property-bags.json"
			]);
		}
		for (const model of [
			{
				name: "engine",
				config: "crates/uasset-source-gen/config/ue57-engine-data-assets.json",
				expected: "crates/uasset-parser/source-models/ue57-data-assets.json"
			},
			{
				name: "fixture",
				config: "crates/uasset-source-gen/config/ue57-data-assets.json",
				expected: "fixtures/unreal-project/FixtureExpected/parser-source-model.json"
			}
		]) {
			const config = join(root, `${model.name}-config.json`);
			const generated = join(root, `${model.name}-model.json`);
			writeFileSync(
				config,
				JSON.stringify({
					...parseJsonObject(readFileSync(join(repositoryRoot, model.config), "utf8")),
					engine_version: engine.version
				})
			);
			run(join(root, `${model.name}-codegen.log`), "cargo", [
				"run",
				"--locked",
				"-p",
				"uasset-source-gen",
				"--",
				"generate",
				"--config",
				config,
				"--engine-source",
				join(engine.root, "Engine", "Source"),
				"--workspace",
				repositoryRoot,
				"--output",
				generated
			]);
			const actual = parseJsonObject(readFileSync(generated, "utf8"));
			const expected = parseJsonObject(
				readFileSync(join(repositoryRoot, model.expected), "utf8")
			);
			if (engine.version === "5.7") {
				assert.deepEqual(
					actual,
					expected,
					`${model.name}: committed source model is stale`
				);
			} else {
				// Tagged class fields can evolve independently. The parser currently shares
				// native layouts; fail if source-derived wire recipes diverge between engines.
				assert.equal(actual.schema_version, expected.schema_version);
				assert.ok(
					isJsonObject(expected.native_layouts) && isJsonObject(bagModel.native_layouts)
				);
				assert.deepEqual(
					actual.native_layouts,
					{ ...expected.native_layouts, ...bagModel.native_layouts },
					`${model.name}: native layout drift`
				);
				assert.deepEqual(
					actual.structs,
					expected.structs,
					`${model.name}: struct layout drift`
				);
			}
		}

		const fixture = join(root, "fixture");
		cpSync(fixtureSource, fixture, {
			recursive: true,
			filter: (source) =>
				!omittedDirectories.has(basename(source)) &&
				// All native assets must be generated by the selected engine.
				source !== join(fixtureSource, "Content", "Fixture", "ParserNative")
		});
		const project = join(fixture, "UEShedFixture.uproject");
		writeFileSync(
			project,
			JSON.stringify({
				...parseJsonObject(readFileSync(project, "utf8")),
				EngineAssociation: engine.version
			})
		);
		const tools = unrealEngineTools(engine.root);
		run(join(root, "build-fixture.log"), tools.build, [
			"UEShedFixtureEditor",
			"Win64",
			"Development",
			project,
			"-NoUBTMakefiles",
			"-WaitMutex",
			"-NoHotReloadFromIDE"
		]);
		const commandletArgs = [
			project,
			"-run=UEShedBuildFixture",
			"-NativeParserOnly",
			"-unattended",
			"-nop4",
			"-NullRHI",
			"-nosplash"
		];
		run(join(root, "generate.log"), tools.editorCommandlet, commandletArgs);
		// This directory did not exist in the source copy, so stale committed evidence
		// cannot satisfy the oracle check if the commandlet fails to produce output.
		const evidence = join(root, "evidence");
		const reviewArgs = commandletArgs.map((arg) =>
			arg === "-NativeParserOnly" ? "-SavedReviewOnly" : arg
		);
		for (const path of [
			"Blueprints/BP_GraphFixture",
			"Blueprints/BP_ReviewFixture",
			"Sequences/LS_TextTimeline",
			"Sequences/LS_NestedTimeline"
		]) {
			rmSync(join(fixture, "Content/Fixture", `${path}.uasset`), { force: true });
		}
		run(join(root, "generate-review.log"), tools.editorCommandlet, reviewArgs);
		run(join(root, "verify-review.log"), tools.editorCommandlet, [
			...reviewArgs,
			"-VerifyOnly",
			`-SavedReviewEvidence=${evidence}`
		]);

		run(join(root, "verify.log"), tools.editorCommandlet, [
			...commandletArgs,
			"-VerifyOnly",
			`-NativeParserEvidence=${evidence}`
		]);
		const oracle = parseJsonObject(
			readFileSync(join(evidence, "native-coverage.json"), "utf8")
		);
		assert.ok(isJsonString(oracle.producer), "missing oracle producer");
		assert.ok(oracle.producer.startsWith(`Unreal ${engine.version}.`), "wrong oracle engine");
		for (const filename of ["native-coverage.json", "blueprint-review.json"])
			cpSync(
				join(evidence, filename),
				join(fixture, "FixtureExpected/parser-targets", filename)
			);
		cpSync(join(evidence, "parser-targets"), join(fixture, "FixtureExpected/parser-targets"), {
			recursive: true
		});
		const environment = {
			...process.env,
			UE_SHED_UASSET_FIXTURE_ROOT: fixture,
			UE_SHED_NATIVE_EVIDENCE_DIR: evidence,
			UE_SHED_UASSET_EXECUTABLE: join(repositoryRoot, "target", "debug", "uasset.exe")
		};
		run(
			join(root, "native-parity.log"),
			"cargo",
			["test", "--locked", "-p", "uasset-inspection", "--test", "native_coverage"],
			environment
		);
		run(
			join(root, "wasm-parity.log"),
			process.execPath,
			["scripts/test-uasset-wasm.ts"],
			environment
		);
		run(
			join(root, "saved-review-parity.log"),
			process.execPath,
			["--import", "tsx", "scripts/test-saved-review.ts"],
			environment
		);
		results.push({ version: engine.version, status: "passed" });
		process.stdout.write(`UE ${engine.version}: passed\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		results.push({ version: engine.version, status: "failed", error: message });
		process.stderr.write(`UE ${engine.version}: ${message}\n`);
	}
}
writeFileSync(join(output, "results.json"), JSON.stringify(results, null, "\t") + "\n");
process.exitCode = results.every((result) => result.status === "passed") ? 0 : 1;
