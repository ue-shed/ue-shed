import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GAME_TEXT_PLUGIN_IDS } from "./plugin-bundle.ts";
import { isJsonObject, isJsonString, parseJsonObject } from "./json.ts";
import {
	prepareUnrealPlugins,
	repositoryRoot,
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
const gameTextOnly = version.major === 4 || process.argv.includes("--game-text");
const pluginIds = gameTextOnly ? GAME_TEXT_PLUGIN_IDS : ueShedPluginIds;
const descriptors = prepareUnrealPlugins({
	engineRoot,
	projectPath: project,
	tools,
	pluginIds,
	legacyCore: version.major === 4
});
const allTests = [
	"UEShed.Cameras.Authoring.NativeLifecycle",
	"UEShed.Cameras.Authoring.FullSetEditing",
	"UEShed.Cameras.Authoring.ScaleAndCleanup",
	"UEShed.Cameras.Authoring.MultiCameraPreviews",
	"UEShed.Cameras.Authoring.PreviewPanel",
	"UEShed.Cameras.Rendering.ViewLocalVisibilityProof",
	"UEShed.Cameras.Rendering.HighResolutionCapture",
	"UEShed.Cameras.Rendering.WireConformance",
	"UEShed.Cameras.MapCapture.LitValidation",
	"UEShed.Cameras.MapCapture.FreezeState",
	"UEShed.Cameras.MapCapture.FreezeOwnership",
	"UEShed.Cameras.FailureJson",
	"UEShed.World.Preparation",
	"UEShed.World.LeaseLifecycle",
	"UEShed.Authoring.CanonicalJson",
	"UEShed.Authoring.Defaults",
	"UEShed.Authoring.DefaultsCodec",
	"UEShed.Authoring.TextIdentity",
	"UEShed.Authoring.ActorReferences",
	"UEShed.Authoring.ActorReferenceDepth",
	"UEShed.GameText.ObjectProperties",
	"UEShed.GameText.Authoring",
	"UEShed.GameText.Blueprint",
	"UEShed.GameText.SaveRecovery",
	"UEShed.Automation.Input",
	"UEShed.Automation.Profiling",
	"UEShed.Cameras.Rendering.LifecycleAndReference",
	"UEShed.Cameras.Rendering.OpeningLease",
	"UEShed.Cameras.Rendering.ScreenshotOwnership",
	"UEShed.Cameras.Rendering.ScreenshotWarmup",
	"UEShed.Cameras.Rendering.AuthoringOwnership",
	"UEShed.Cameras.Rendering.MapMinorCompatibility",
	"UEShed.Cameras.Rendering.PreparationAndWorldChange",
	"UEShed.Cameras.Rendering.EditorPreviews",
	"UEShed.Cameras.Streaming.ProvisionedEditorPreviews",
	"UEShed.Cameras.Streaming.BoundedLifecycle",
	"UEShed.Cameras.Streaming.DeliveryScope",
	"UEShed.Cameras.Streaming.CadenceUpdates",
	"UEShed.Niagara.IndependentCamera",
	"UEShed.Core.EditorWorld.AsyncOpen",
	"UEShed.Core.EditorAssets.Manifest",
	"UEShed.Core.EditorAssets.Locate",
	"UEShed.Core.EditorAssets.OpenUnavailable",
	"UEShed.Core.EditorAssets.Open",
	"UEShed.Core.ForegroundResponsiveness.Leases",
	"UEShed.Core.ForegroundResponsiveness.Contract",
	"UEShed.Core.ForegroundResponsiveness.NativeProcess",
	"UEShed.Core.ForegroundResponsiveness.PredicateCost",
	"UEShed.Core.ForegroundResponsiveness.DelegateEntry"
];
// The Game Text graph carries Core's asset navigation, which UE 4.27 builds too.
const tests = gameTextOnly
	? allTests.filter(
			(name) =>
				name.startsWith("UEShed.GameText.") || name.startsWith("UEShed.Core.EditorAssets.")
		)
	: allTests;
const report = join(root, "automation");
const result = spawnSync(
	tools.editorCommandlet,
	[
		project,
		"/Engine/Maps/Templates/Template_Default",
		...descriptors.map((descriptor) => `-PLUGIN=${descriptor}`),
		`-EnablePlugins=${pluginIds.join(",")}`,
		// Synthetic PIE delegates in the lifecycle tests have no real telemetry session.
		// UE5.6 EditorTelemetry dereferences that absent session during PreBeginPIE.
		...(version.major === 5 && version.minor === 6 ? ["-DisablePlugins=EditorTelemetry"] : []),
		// UE 4.27 opens asset editors in a new window by default. Offscreen, closing one saves
		// its restored size, which the generic window aborts on; UE5 docks them in the main window.
		// For the same reason the main layout must not come from the user's own editor: 4.27 keeps
		// it per user, not per project, and a floating tab saved there (a Message Log window, say)
		// aborts every offscreen shutdown. A blank layout falls back to the built-in default, and
		// `-nowrite` keeps the test editor from rewriting the user's layout and settings.
		...(version.major === 4
			? [
					"-ini:EditorPerProjectUserSettings:[/Script/EditorStyle.EditorStyleSettings]:AssetEditorOpenLocation=MainWindow",
					"-ini:EditorLayout:[EditorLayouts]:UnrealEd_Layout_v1.4=",
					"-nowrite"
				]
			: []),
		`-ExecCmds=Automation RunTests ${tests.join("+")}`,
		"-TestExit=Automation Test Queue Empty",
		`-ReportExportPath=${report}`,
		`-UEShedWorldContractFixtures=${join(repositoryRoot, "packages/protocol/contracts/world/preparation/v1/fixtures")}`,
		`-UEShedAutomationContractFixtures=${join(repositoryRoot, "packages/protocol/contracts/automation/v1/fixtures")}`,
		`-UEShedAuthoringContractFixtures=${join(repositoryRoot, "packages/protocol/contracts/authoring/v1/fixtures")}`,
		`-UEShedCoreContractFixtures=${join(repositoryRoot, "packages/protocol/contracts/core/v1/fixtures")}`,
		`-UEShedCameraRenderContractFixtures=${join(repositoryRoot, "packages/protocol/contracts/cameras/render/v1/fixtures")}`,
		`-abslog=${join(root, "editor.log")}`,
		"-unattended",
		"-nop4",
		"-nosplash",
		"-RenderOffscreen",
		"-ResX=1280",
		"-ResY=800",
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
	recordedTests.length < tests.length ||
	!tests.every((name) =>
		recordedTests.some(
			(entry) =>
				isJsonObject(entry) && entry.fullTestPath === name && entry.state === "Success"
		)
	) ||
	!recordedTests.every(
		(entry) =>
			isJsonObject(entry) &&
			entry.state === "Success" &&
			tests.some(
				(name) =>
					entry.fullTestPath === name ||
					(isJsonString(entry.fullTestPath) && entry.fullTestPath.startsWith(name + "."))
			)
	) ||
	evidence.failed !== 0 ||
	evidence.notRun !== 0 ||
	evidence.inProcess !== 0
) {
	throw new Error(`Unreal plugin automation did not pass all ${tests.length} tests: ${report}`);
}
console.log(
	`Unreal ${version.label}: all ${pluginIds.length} plugins built and ${recordedTests.length} tests passed.`
);
