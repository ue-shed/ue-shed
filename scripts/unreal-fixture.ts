import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	prepareUnrealPlugins,
	ueShedPluginIds,
	unrealEngineVersion,
	type UnrealEngineTools,
	localDerivedDataCacheArguments
} from "./unreal-plugin-host.ts";
import { unrealRemoteControlLaunchArguments } from "./workbench-tools.ts";
import {
	gameTextActionsFixtureSteps,
	gameTextProblemsFixtureSteps,
	localizationFixtureSteps,
	unrealSourceFixtureSteps
} from "./localization-fixture-steps.ts";
import { retainLocalizationFixtureOutput } from "./localization-fixture-output.ts";
import {
	buildInputStamp,
	buildUnlessUnchanged,
	engineBuildIdentity,
	moduleManifestOutputs
} from "./build-stamp.ts";
import { traceProcess } from "./process-trace.ts";
import { findUnrealEngine } from "./unreal-engines.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const action = process.argv[2];
// UE 4.27 runs use the separate 4.27 project, with the stock commandlet and no build.
const is427 = action === "localization-427" || action === "unreal-source-427";
const isLocalization =
	action === "localization" ||
	action === "localization-verify" ||
	action === "game-text-problems" ||
	action === "game-text-actions" ||
	action === "unreal-source";
const fixtureRoot =
	isLocalization && process.env.UE_SHED_LOCALIZATION_FIXTURE_ROOT
		? resolve(process.env.UE_SHED_LOCALIZATION_FIXTURE_ROOT)
		: join(repositoryRoot, "fixtures", is427 ? "unreal-427-localization" : "unreal-project");
const projectFile = join(
	fixtureRoot,
	is427 ? "UEShedLocalization427.uproject" : "UEShedFixture.uproject"
);
// SAFETY: the repository fixture contract owns this required engine version object.
const contract = JSON.parse(
	readFileSync(
		join(repositoryRoot, "fixtures", "unreal-project", "fixture-contract.json"),
		"utf8"
	)
) as {
	readonly engine: { readonly major: number; readonly minor: number };
};

function engineVersion(engineRoot: string) {
	return unrealEngineVersion(engineRoot);
}

function isMatchingEngine(engineRoot: string) {
	const version = engineVersion(engineRoot);
	if (is427) return version?.label === "4.27";
	if (isLocalization)
		return version?.label === "5.6" || version?.label === "5.7" || version?.label === "5.8";
	return version?.major === contract.engine.major && version?.minor === contract.engine.minor;
}

async function discoverEngineRoot() {
	const requiredVersion = is427
		? "4.27"
		: isLocalization
			? "5.6, 5.7 or 5.8"
			: `${contract.engine.major}.${contract.engine.minor}`;
	const configured = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
	if (configured) {
		const root = resolve(configured);
		if (!isMatchingEngine(root)) {
			throw new Error(`UE_SHED_UNREAL_ENGINE_ROOT must point to Unreal ${requiredVersion}`);
		}
		return root;
	}

	const root = await findUnrealEngine(
		is427
			? ["4.27"]
			: isLocalization
				? ["5.6", "5.7", "5.8"]
				: [`${contract.engine.major}.${contract.engine.minor}`]
	);
	if (root !== undefined) return root;

	throw new Error(
		`Could not discover Unreal ${requiredVersion}. ` +
			"Set UE_SHED_UNREAL_ENGINE_ROOT to the engine installation root."
	);
}

function run(command: string, args: readonly string[]) {
	const isBatchFile = command.endsWith(".bat") || command.endsWith(".cmd");
	const executable = isBatchFile
		? [command, ...args].map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ")
		: command;
	const result = traceProcess(command, args, () =>
		spawnSync(executable, isBatchFile ? [] : args, {
			cwd: repositoryRoot,
			shell: isBatchFile,
			stdio: "inherit",
			windowsHide: true
		})
	);
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function engineTools(engineRoot: string): UnrealEngineTools {
	if (process.platform !== "win32") {
		throw new Error("The fixture runner currently supports Windows builds only.");
	}
	return {
		build: join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat"),
		editor: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.exe"),
		editorCommandlet: join(
			engineRoot,
			"Engine",
			"Binaries",
			"Win64",
			is427 ? "UE4Editor-Cmd.exe" : "UnrealEditor-Cmd.exe"
		)
	};
}

function build(engineRoot: string, tools: UnrealEngineTools) {
	buildUnlessUnchanged({
		stampFile: join(fixtureRoot, "Intermediate", "ue-shed-build-inputs.sha256"),
		stamp: buildInputStamp(
			[projectFile, join(fixtureRoot, "Source"), join(fixtureRoot, "Plugins")],
			engineBuildIdentity(engineRoot)
		),
		outputs: moduleManifestOutputs(
			join(fixtureRoot, "Binaries", "Win64", "UnrealEditor.modules")
		),
		build: () =>
			run(tools.build, [
				"UEShedFixtureEditor",
				"Win64",
				"Development",
				projectFile,
				"-NoUBTMakefiles",
				"-WaitMutex",
				"-NoHotReloadFromIDE"
			])
	});
}

function pluginArguments(pluginDescriptors: readonly string[]) {
	if (pluginDescriptors.length === 0) return [];
	return [
		...pluginDescriptors.map((descriptor) => `-PLUGIN=${descriptor}`),
		`-EnablePlugins=${ueShedPluginIds.join(",")}`
	];
}

function runCommandlet(
	tools: UnrealEngineTools,
	pluginDescriptors: readonly string[],
	extraArgs: readonly string[] = []
) {
	run(tools.editorCommandlet, [
		projectFile,
		"-run=UEShedBuildFixture",
		...extraArgs,
		...pluginArguments(pluginDescriptors),
		"-unattended",
		"-SCCProvider=None",
		...localDerivedDataCacheArguments,
		"-nosplash",
		"-NullRHI"
	]);
}

function formatMapHistoryFixture() {
	const formatter = join(
		repositoryRoot,
		"node_modules",
		".bin",
		process.platform === "win32" ? "oxfmt.cmd" : "oxfmt"
	);
	run(formatter, [
		join(repositoryRoot, "fixtures", "perforce-map-history", "scenario.json"),
		join(repositoryRoot, "fixtures", "perforce-map-history", "conventional-scenario.json")
	]);
}

function launch(tools: UnrealEngineTools, pluginDescriptors: readonly string[]) {
	const remoteControlPort = new URL(
		process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001"
	).port;
	const child = spawn(
		tools.editor,
		[
			projectFile,
			process.env.UE_SHED_FIXTURE_AUTHORING_MAP ?? "/Game/Fixture/Cameras/L_CameraLoad",
			...pluginDescriptors.map((descriptor) => `-PLUGIN=${descriptor}`),
			"-game",
			"-windowed",
			"-ResX=1280",
			"-ResY=720",
			...unrealRemoteControlLaunchArguments(ueShedPluginIds, Number(remoteControlPort)),
			"-ini:EditorSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False",
			"-SCCProvider=None",
			"-nosplash"
		],
		{
			cwd: fixtureRoot,
			detached: true,
			stdio: "ignore",
			windowsHide: false
		}
	);
	if (process.env.UE_SHED_FIXTURE_PID_FILE) {
		writeFileSync(process.env.UE_SHED_FIXTURE_PID_FILE, String(child.pid));
	}
	child.unref();
}

function launchAuthoring(tools: UnrealEngineTools, pluginDescriptors: readonly string[]) {
	const remoteControlPort = new URL(
		process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001"
	).port;
	// Keep the editor window visible: Map Review "Go to Actor" moves the viewport and
	// brings this window forward. Hiding it makes focus look like a no-op.
	const child = spawn(
		tools.editor,
		[
			projectFile,
			process.env.UE_SHED_FIXTURE_AUTHORING_MAP ?? "/Game/Fixture/Cameras/L_CameraLoad",
			...pluginDescriptors.map((descriptor) => `-PLUGIN=${descriptor}`),
			...unrealRemoteControlLaunchArguments(ueShedPluginIds, Number(remoteControlPort)),
			...(process.env.UE_SHED_FIXTURE_UNATTENDED === "1" ? ["-unattended"] : []),
			"-ini:EditorSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False",
			"-SCCProvider=None",
			"-nosplash"
		],
		{
			cwd: fixtureRoot,
			detached: true,
			stdio: "ignore",
			windowsHide: false
		}
	);
	if (process.env.UE_SHED_FIXTURE_PID_FILE) {
		writeFileSync(process.env.UE_SHED_FIXTURE_PID_FILE, String(child.pid));
	}
	child.unref();
}

if (
	!action ||
	!new Set<string>([
		"apply",
		"apply-pair",
		"build",
		"conformance",
		"evidence",
		"generate",
		"launch",
		"launch-authoring",
		"map-history",
		"localization",
		"localization-verify",
		"localization-427",
		"game-text-problems",
		"game-text-actions",
		"unreal-source",
		"unreal-source-427",
		"world-partition",
		"save",
		"scenario",
		"verify",
		"snapshot"
	]).has(action)
) {
	throw new Error(
		"Usage: node scripts/unreal-fixture.ts <apply|build|conformance|evidence|generate|launch|launch-authoring|localization|localization-verify|localization-427|game-text-problems|game-text-actions|unreal-source|unreal-source-427|map-history|world-partition|save|scenario|verify|snapshot> [input] [output]"
	);
}

const engineRoot = await discoverEngineRoot();
const tools = engineTools(engineRoot);
if (!is427) build(engineRoot, tools);
if (action === "localization") {
	const output = process.argv[3]
		? resolve(process.argv[3])
		: join(fixtureRoot, "FixtureExpected", "localization");
	process.stdout.write(
		`Localization writes: ${join(fixtureRoot, "Content/Fixture/Localization")}, ` +
			`${join(fixtureRoot, "Config/DefaultEditor.ini")}, ${join(fixtureRoot, "Config/Localization")}, ` +
			`${join(fixtureRoot, "Content/Localization/FixtureGame")}, ${output}\n`
	);
	// Only this named target's outputs are disposable. Reset archives and report history too.
	rmSync(join(fixtureRoot, "Content", "Localization", "FixtureGame"), {
		recursive: true,
		force: true
	});
	// These three generated packages may have been saved by a newer engine. Recreate them
	// from source instead of trying to load newer bytes in 5.7; leave other content alone.
	for (const asset of ["ST_Localization", "DT_Localization", "DA_Localization"])
		rmSync(join(fixtureRoot, "Content", "Fixture", "Localization", `${asset}.uasset`), {
			force: true
		});
	for (const args of localizationFixtureSteps(projectFile, output))
		run(tools.editorCommandlet, args);
	if (process.env.UE_SHED_LOCALIZATION_FIXTURE_ROOT) {
		const version = engineVersion(engineRoot);
		if (version === undefined) throw new Error("Localization engine version is unavailable.");
		retainLocalizationFixtureOutput(fixtureRoot, output, version.label);
	}
}
if (action === "game-text-problems") {
	process.stdout.write(
		`Game Text problems write: ${join(fixtureRoot, "Content/Fixture/GameTextProblems")}, ` +
			`${join(fixtureRoot, "Config/DefaultEditor.ini")}, ${join(fixtureRoot, "Config/Localization")}, ` +
			`${join(fixtureRoot, "Content/Localization/Game")}\n`
	);
	// Only the Game target's outputs and its generated packages are disposable.
	for (const generated of ["Content/Localization/Game", "Content/Fixture/GameTextProblems"])
		rmSync(join(fixtureRoot, generated), { recursive: true, force: true });
	for (const args of gameTextProblemsFixtureSteps(projectFile)) run(tools.editorCommandlet, args);
}
if (action === "game-text-actions") {
	const output = resolve(
		process.argv[3] ?? join(fixtureRoot, "FixtureExpected", "game-text-actions")
	);
	process.stdout.write(
		`Game Text actions write: ${join(fixtureRoot, "Content/Fixture/GameTextActions")}, ` +
			`${join(fixtureRoot, "Content/__ExternalActors__/Fixture/GameTextActions")}, ` +
			`${join(fixtureRoot, "Config/DefaultEditor.ini")}, ${join(fixtureRoot, "Config/Localization")}, ` +
			`${join(fixtureRoot, "Content/Localization/GameTextActions")}, ${output}\n`
	);
	// Only the GameTextActions target's outputs and its generated packages are disposable.
	for (const generated of [
		"Content/Localization/GameTextActions",
		"Content/Localization/GameTextActionsSource",
		"Content/Fixture/GameTextActions",
		"Content/__ExternalActors__/Fixture/GameTextActions"
	])
		rmSync(join(fixtureRoot, generated), { recursive: true, force: true });
	for (const args of gameTextActionsFixtureSteps(projectFile, output))
		run(tools.editorCommandlet, args);
}
if (action === "unreal-source") {
	const version = engineVersion(engineRoot);
	if (version === undefined) throw new Error("The engine version is unavailable.");
	const output = resolve(
		process.argv[3] ?? join(fixtureRoot, "FixtureExpected", "unreal-source", version.label)
	);
	process.stdout.write(
		`Unreal source gathers write: ${join(fixtureRoot, "Content/Localization/UnrealSource")}, ` +
			`${join(fixtureRoot, "Content/Localization/UnrealSourceEditor")}, ${output}
`
	);
	for (const name of ["UnrealSource", "UnrealSourceEditor"])
		rmSync(join(fixtureRoot, "Content", "Localization", name), {
			recursive: true,
			force: true
		});
	for (const args of unrealSourceFixtureSteps(projectFile)) run(tools.editorCommandlet, args);
	mkdirSync(output, { recursive: true });
	for (const name of ["UnrealSource", "UnrealSourceEditor"]) {
		const manifest = join(fixtureRoot, "Content", "Localization", name, `${name}.manifest`);
		copyFileSync(manifest, join(output, `${name}.manifest`));
		rmSync(join(fixtureRoot, "Content", "Localization", name), {
			recursive: true,
			force: true
		});
	}
}
if (action === "unreal-source-427") {
	const output = resolve(
		process.argv[3] ??
			join(
				repositoryRoot,
				"fixtures",
				"unreal-project",
				"FixtureExpected",
				"unreal-source",
				"4.27"
			)
	);
	const target = join(fixtureRoot, "Content", "Localization", "UnrealSource427");
	process.stdout.write(`Unreal source gather writes: ${target}, ${output}
`);
	rmSync(target, { recursive: true, force: true });
	run(tools.editorCommandlet, [
		projectFile,
		"-run=GatherText",
		`-config=${join(fixtureRoot, "Config", "Localization", "UnrealSource427.ini")}`,
		"-unattended",
		"-SCCProvider=None",
		...localDerivedDataCacheArguments,
		"-nosplash",
		"-NullRHI"
	]);
	mkdirSync(output, { recursive: true });
	copyFileSync(join(target, "UnrealSource427.manifest"), join(output, "UnrealSource.manifest"));
	rmSync(target, { recursive: true, force: true });
}
if (action === "localization-verify") {
	runCommandlet(
		tools,
		[],
		[
			"-LocalizationOnly",
			"-VerifyOnly",
			`-LocalizationEvidence=${resolve(process.argv[3] ?? join(fixtureRoot, "FixtureExpected/localization"))}`
		]
	);
}
if (action === "localization-427") {
	process.stdout.write(
		`Localization writes: ${join(fixtureRoot, "Content/Localization/Fixture427")}\n`
	);
	rmSync(join(fixtureRoot, "Content", "Localization", "Fixture427"), {
		recursive: true,
		force: true
	});
	run(tools.editorCommandlet, [
		projectFile,
		"-run=GatherText",
		`-config=${join(fixtureRoot, "Config", "Localization", "Fixture427.ini")}`,
		"-unattended",
		"-SCCProvider=None",
		...localDerivedDataCacheArguments,
		"-nosplash",
		"-NullRHI"
	]);
}
const needsPlugins = new Set([
	"apply",
	"apply-pair",
	"conformance",
	"evidence",
	"launch",
	"launch-authoring",
	"save",
	"snapshot"
]).has(action);
const pluginDescriptors = needsPlugins
	? prepareUnrealPlugins({ engineRoot, projectPath: projectFile, tools })
	: [];
if (action === "launch") {
	launch(tools, pluginDescriptors);
}
if (action === "launch-authoring") {
	launchAuthoring(tools, pluginDescriptors);
}
// Pinned conformance evidence includes saved GUIDs and property-bag identities. Regeneration
// belongs to the explicit generate command and the disposable engine matrix, not verification.
if (action === "generate") {
	runCommandlet(tools, pluginDescriptors);
}
if (action === "scenario") {
	runCommandlet(tools, pluginDescriptors, ["-ScenarioOnly"]);
	runCommandlet(tools, pluginDescriptors, ["-ScenarioOnly", "-VerifyOnly"]);
}
if (action === "world-partition") {
	runCommandlet(tools, pluginDescriptors, ["-WorldPartitionOnly"]);
	runCommandlet(tools, pluginDescriptors, ["-WorldPartitionOnly", "-VerifyOnly"]);
}
if (action === "map-history") {
	runCommandlet(tools, pluginDescriptors, [
		`-MapHistoryFixtureDirectory=${join(repositoryRoot, "fixtures", "perforce-map-history")}`,
		"-OverwriteMapHistoryFixture"
	]);
	formatMapHistoryFixture();
}
if (action === "verify" || action === "conformance") {
	runCommandlet(tools, pluginDescriptors, ["-VerifyOnly"]);
}
if (action === "evidence" || action === "conformance") {
	const output = process.argv[3];
	if (!output) {
		throw new Error(`${action} requires an output directory`);
	}
	runCommandlet(tools, pluginDescriptors, [`-ConformanceDirectory=${resolve(output)}`]);
	runCommandlet(tools, pluginDescriptors, [
		"-NativeParserOnly",
		"-VerifyOnly",
		`-NativeParserEvidence=${join(resolve(output), "parser-targets")}`
	]);
}
if (action === "snapshot") {
	const output = process.argv[3];
	if (!output) {
		throw new Error("snapshot requires an output directory");
	}
	runCommandlet(tools, pluginDescriptors, [`-SnapshotDirectory=${resolve(output)}`]);
}
if (action === "apply" || action === "save") {
	const input = process.argv[3];
	const output = process.argv[4];
	if (!input || !output) {
		throw new Error(`${action} requires input and output JSON paths`);
	}
	const prefix = action === "apply" ? "Apply" : "Save";
	const args = [`-${prefix}Request=${resolve(input)}`, `-${prefix}Output=${resolve(output)}`];
	if (action === "apply" && process.argv[5] && process.argv[6]) {
		args.push(
			`-SaveAfterApplyRequest=${resolve(process.argv[5])}`,
			`-SaveAfterApplyOutput=${resolve(process.argv[6])}`
		);
	}
	if (action === "apply" && process.argv[7] && process.argv[8]) {
		args.push(
			`-LookupOperation=${process.argv[7]}`,
			`-LookupOutput=${resolve(process.argv[8])}`
		);
	}
	runCommandlet(tools, pluginDescriptors, args);
}
if (action === "apply-pair") {
	const [firstInput, firstOutput, secondInput, secondOutput] = process.argv.slice(3);
	if (!firstInput || !firstOutput || !secondInput || !secondOutput) {
		throw new Error("apply-pair requires two input and two output JSON paths");
	}
	runCommandlet(tools, pluginDescriptors, [
		`-ApplyRequest=${resolve(firstInput)}`,
		`-ApplyOutput=${resolve(firstOutput)}`,
		`-SecondApplyRequest=${resolve(secondInput)}`,
		`-SecondApplyOutput=${resolve(secondOutput)}`
	]);
}
