import { spawnSync } from "node:child_process";
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
	const isBatchFile = command.endsWith(".bat");
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
		editor: join(engineRoot, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe")
	};
}

function build(tools) {
	run(tools.build, ["UEShedFixtureEditor", "Win64", "Development", projectFile, "-WaitMutex"]);
}

function runCommandlet(tools, extraArgs = []) {
	run(tools.editor, [
		projectFile,
		"-run=UEShedBuildFixture",
		...extraArgs,
		"-unattended",
		"-nop4",
		"-nosplash",
		"-NullRHI"
	]);
}

const action = process.argv[2];
if (!new Set(["build", "generate", "verify"]).has(action)) {
	throw new Error("Usage: node scripts/unreal-fixture.mjs <build|generate|verify>");
}

const tools = engineTools(discoverEngineRoot());
build(tools);
if (action === "generate" || action === "verify") {
	runCommandlet(tools);
}
if (action === "verify") {
	runCommandlet(tools, ["-VerifyOnly"]);
}
