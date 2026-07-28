import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repositoryRoot, "fixtures", "unreal-project");
const projectFile = join(fixtureRoot, "UEShedFixture.uproject");
const contract = JSON.parse(readFileSync(join(fixtureRoot, "fixture-contract.json"), "utf8"));

function engineVersion(engineRoot) {
	const versionPath = join(engineRoot, "Engine", "Build", "Build.version");
	if (!existsSync(versionPath)) {
		return undefined;
	}
	const version = JSON.parse(readFileSync(versionPath, "utf8"));
	return { major: version.MajorVersion, minor: version.MinorVersion };
}

function isMatchingEngine(engineRoot) {
	const version = engineVersion(engineRoot);
	return version?.major === contract.engine.major && version?.minor === contract.engine.minor;
}

function discoverEngineRoot() {
	const configured = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
	if (configured) {
		const root = resolve(configured);
		if (!isMatchingEngine(root)) {
			throw new Error(
				`UE_SHED_UNREAL_ENGINE_ROOT must point to Unreal ${contract.engine.major}.${contract.engine.minor}`
			);
		}
		return root;
	}

	if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const epicRoot = join(programFiles, "Epic Games");
		if (existsSync(epicRoot)) {
			const candidates = readdirSync(epicRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("UE_"))
				.map((entry) => join(epicRoot, entry.name))
				.filter(isMatchingEngine);
			if (candidates.length > 0) {
				return candidates.sort().at(-1);
			}
		}
	}

	throw new Error(
		`Could not discover Unreal ${contract.engine.major}.${contract.engine.minor}. ` +
			"Set UE_SHED_UNREAL_ENGINE_ROOT to the engine installation root."
	);
}

function run(command, args) {
	const isBatchFile = command.endsWith(".bat") || command.endsWith(".cmd");
	const executable = isBatchFile
		? [command, ...args].map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ")
		: command;
	const result = spawnSync(executable, isBatchFile ? [] : args, {
		cwd: repositoryRoot,
		shell: isBatchFile,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function engineTools(engineRoot) {
	if (process.platform !== "win32") {
		throw new Error("The fixture runner currently supports Windows builds only.");
	}
	return {
		build: join(engineRoot, "Engine", "Build", "BatchFiles", "Build.bat"),
		editor: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor.exe"),
		editorCommandlet: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe")
	};
}

function build(tools) {
	run(tools.build, ["UEShedFixtureEditor", "Win64", "Development", projectFile, "-WaitMutex"]);
}

function runCommandlet(tools, extraArgs = []) {
	run(tools.editorCommandlet, [
		projectFile,
		"-run=UEShedBuildFixture",
		...extraArgs,
		"-unattended",
		"-nop4",
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

function launch(tools) {
	const remoteControlPort = new URL(
		process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001"
	).port;
	const remoteControlWebSocketPort = String(Number(remoteControlPort) + 1);
	const child = spawn(
		tools.editor,
		[
			projectFile,
			"/Game/Fixture/Cameras/L_CameraLoad",
			"-game",
			"-windowed",
			"-ResX=1280",
			"-ResY=720",
			"-RCWebControlEnable",
			`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=${remoteControlPort}`,
			`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlWebSocketServerPort=${remoteControlWebSocketPort}`,
			"-ini:EditorSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False",
			"-NoLiveCoding",
			"-nop4",
			"-nosplash"
		],
		{
			cwd: fixtureRoot,
			detached: true,
			stdio: "ignore",
			windowsHide: false
		}
	);
	child.unref();
}

function launchAuthoring(tools) {
	const remoteControlPort = new URL(
		process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001"
	).port;
	// Keep the editor window visible: Map Review "Go to Actor" moves the viewport and
	// brings this window forward. Hiding it makes focus look like a no-op.
	const child = spawn(
		tools.editor,
		[
			projectFile,
			"-RCWebControlEnable",
			`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=${remoteControlPort}`,
			`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlWebSocketServerPort=${Number(remoteControlPort) + 1}`,
			"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:bAutoStartWebServer=True",
			"-ini:EditorSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False",
			"-NoLiveCoding",
			"-nop4",
			"-nosplash"
		],
		{
			cwd: fixtureRoot,
			detached: true,
			stdio: "ignore",
			windowsHide: false
		}
	);
	child.unref();
}

const action = process.argv[2];
if (
	!new Set([
		"apply",
		"apply-pair",
		"build",
		"conformance",
		"evidence",
		"generate",
		"launch",
		"launch-authoring",
		"map-history",
		"save",
		"verify",
		"snapshot"
	]).has(action)
) {
	throw new Error(
		"Usage: node scripts/unreal-fixture.mjs <apply|build|conformance|evidence|generate|launch|launch-authoring|map-history|save|verify|snapshot> [input] [output]"
	);
}

const tools = engineTools(discoverEngineRoot());
build(tools);
if (action === "launch") {
	launch(tools);
}
if (action === "launch-authoring") {
	launchAuthoring(tools);
}
if (action === "generate" || action === "verify" || action === "conformance") {
	runCommandlet(tools);
}
if (action === "map-history") {
	runCommandlet(tools, [
		`-MapHistoryFixtureDirectory=${join(repositoryRoot, "fixtures", "perforce-map-history")}`,
		"-OverwriteMapHistoryFixture"
	]);
	formatMapHistoryFixture();
}
if (action === "verify" || action === "conformance") {
	runCommandlet(tools, ["-VerifyOnly"]);
}
if (action === "evidence" || action === "conformance") {
	const output = process.argv[3];
	if (!output) {
		throw new Error(`${action} requires an output directory`);
	}
	runCommandlet(tools, [`-ConformanceDirectory=${resolve(output)}`]);
}
if (action === "snapshot") {
	const output = process.argv[3];
	if (!output) {
		throw new Error("snapshot requires an output directory");
	}
	runCommandlet(tools, [`-SnapshotDirectory=${resolve(output)}`]);
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
	runCommandlet(tools, args);
}
if (action === "apply-pair") {
	const [firstInput, firstOutput, secondInput, secondOutput] = process.argv.slice(3);
	if (!firstInput || !firstOutput || !secondInput || !secondOutput) {
		throw new Error("apply-pair requires two input and two output JSON paths");
	}
	runCommandlet(tools, [
		`-ApplyRequest=${resolve(firstInput)}`,
		`-ApplyOutput=${resolve(firstOutput)}`,
		`-SecondApplyRequest=${resolve(secondInput)}`,
		`-SecondApplyOutput=${resolve(secondOutput)}`
	]);
}
