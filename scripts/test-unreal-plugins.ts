import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isJsonObject, parseJsonObject } from "./json.ts";
import {
	prepareUnrealPlugins,
	ueShedPluginIds,
	unrealEngineTools,
	unrealEngineVersion
} from "./unreal-plugin-host.ts";

const engineRoot = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
const output = process.argv[2];
if (!engineRoot || !output) {
	throw new Error(
		"Set UE_SHED_UNREAL_ENGINE_ROOT and run pnpm test:unreal-plugins <new-evidence-directory>."
	);
}
const root = resolve(output);
// A fresh directory prevents stale automation reports from passing a failed run.
mkdirSync(root, { recursive: false });
const version = unrealEngineVersion(engineRoot);
if (!version) throw new Error(`Cannot read the Unreal version under ${engineRoot}.`);
const tools = unrealEngineTools(engineRoot);
const project = join(root, "UEShedPluginCompatibility.uproject");
writeFileSync(
	project,
	JSON.stringify({ FileVersion: 3, EngineAssociation: version.label }, null, "\t")
);
const descriptors = prepareUnrealPlugins({ engineRoot, projectPath: project, tools });
const tests = [
	"UEShed.Authoring.CanonicalJson",
	"UEShed.Cameras.Rendering.LifecycleAndReference",
	"UEShed.Cameras.Rendering.ScreenshotOwnership",
	"UEShed.Cameras.Rendering.MapMinorCompatibility",
	"UEShed.Niagara.IndependentCamera"
];
const report = join(root, "automation");
const result = spawnSync(
	tools.editorCommandlet,
	[
		project,
		"/Engine/Maps/Templates/Template_Default",
		...descriptors.map((descriptor) => `-PLUGIN=${descriptor}`),
		`-EnablePlugins=${ueShedPluginIds.join(",")}`,
		`-ExecCmds=Automation RunTests ${tests.join("+")}`,
		"-TestExit=Automation Test Queue Empty",
		`-ReportExportPath=${report}`,
		`-abslog=${join(root, "editor.log")}`,
		"-unattended",
		"-nop4",
		"-nosplash",
		"-RenderOffscreen",
		"-ResX=640",
		"-ResY=480",
		"-NoSound"
	],
	{ stdio: "inherit", windowsHide: true, timeout: 900_000 }
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Unreal plugin tests exited with ${result.status}.`);
const evidence = parseJsonObject(
	readFileSync(join(report, "index.json"), "utf8").replace(/^\uFEFF/u, "")
);
const recordedTests = evidence.tests;
if (
	!Array.isArray(recordedTests) ||
	recordedTests.length !== tests.length ||
	!tests.every((name) =>
		recordedTests.some(
			(entry) =>
				isJsonObject(entry) && entry.fullTestPath === name && entry.state === "Success"
		)
	) ||
	evidence.failed !== 0 ||
	evidence.notRun !== 0 ||
	evidence.inProcess !== 0
) {
	throw new Error(`Unreal plugin automation did not pass all ${tests.length} tests: ${report}`);
}
console.log(`Unreal ${version.label}: all seven plugins built and ${tests.length} tests passed.`);
