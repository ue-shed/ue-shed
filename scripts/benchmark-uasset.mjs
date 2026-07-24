import { spawnSync } from "node:child_process";
import {
	cpus,
	arch as operatingSystemArchitecture,
	platform as operatingSystemPlatform,
	totalmem
} from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repositoryRoot, "fixtures", "unreal-project");
const fixtureProject = join(fixtureRoot, "UEShedFixture.uproject");
const fixtureContractPath = join(fixtureRoot, "fixture-contract.json");
const benchmarkAsset = join(fixtureRoot, "Content", "Fixture", "Input", "IMC_Fixture.uasset");
const releaseExecutable = join(
	repositoryRoot,
	"target",
	"release",
	process.platform === "win32" ? "uasset.exe" : "uasset"
);
const maxOutputBytes = 64 * 1024 * 1024;

const usage = `Usage: node scripts/benchmark-uasset.mjs [options]

Options:
  --native-runs <count>  Native and TypeScript timed runs (default: 10)
  --unreal-runs <count>  Fresh Unreal commandlet timed runs (default: 3)
  --warmups <count>      Untimed warmups for each scenario (default: 1)
  --output <path>        Write the complete JSON result
  --json                 Print only JSON
  --no-build             Reuse existing release parser and fixture binaries
  --unreal               Include the Unreal commandlet scenario
  -h, --help             Show this help
`;

function integerArgument(name, input, { minimum }) {
	if (input === undefined) throw new Error(`${name} requires a value.`);
	const value = Number(input);
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
	}
	return value;
}

function parseArguments(arguments_) {
	const options = {
		build: true,
		json: false,
		nativeRuns: 10,
		output: undefined,
		unreal: false,
		unrealRuns: 3,
		warmups: 1
	};
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		switch (argument) {
			case "--native-runs":
				index += 1;
				options.nativeRuns = integerArgument(argument, arguments_[index], { minimum: 1 });
				break;
			case "--unreal-runs":
				index += 1;
				options.unrealRuns = integerArgument(argument, arguments_[index], { minimum: 1 });
				break;
			case "--warmups":
				index += 1;
				options.warmups = integerArgument(argument, arguments_[index], { minimum: 0 });
				break;
			case "--output":
				index += 1;
				if (arguments_[index] === undefined) throw new Error("--output requires a path.");
				options.output = resolve(repositoryRoot, arguments_[index]);
				break;
			case "--json":
				options.json = true;
				break;
			case "--no-build":
				options.build = false;
				break;
			case "--unreal":
				options.unreal = true;
				break;
			case "-h":
			case "--help":
				return { help: true };
			default:
				throw new Error(`Unknown benchmark option: ${argument}`);
		}
	}
	return { help: false, options };
}

function commandFailure(command, arguments_, result) {
	const detail =
		result.stderr?.trim() ||
		result.stdout?.trim() ||
		result.error?.message ||
		`exit code ${result.status ?? "unknown"}`;
	return new Error(`${command} ${arguments_.join(" ")} failed: ${detail}`);
}

function runSetup(command, arguments_, jsonOnly) {
	const result = spawnSync(command, arguments_, {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: process.env,
		maxBuffer: maxOutputBytes,
		stdio: jsonOnly ? ["ignore", "ignore", "inherit"] : "inherit",
		windowsHide: true
	});
	if (result.error !== undefined || result.status !== 0) {
		throw commandFailure(command, arguments_, result);
	}
}

function invoke(command, arguments_, options) {
	const started = performance.now();
	const result = spawnSync(command, arguments_, {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: options.environment ?? process.env,
		maxBuffer: maxOutputBytes,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true
	});
	const elapsedMs = performance.now() - started;
	if (result.error !== undefined || result.status !== 0) {
		throw commandFailure(command, arguments_, result);
	}
	if (options.validate !== undefined) options.validate(result.stdout);
	return elapsedMs;
}

function percentile(sorted, ratio) {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
	return sorted[index] ?? 0;
}

function roundMilliseconds(value) {
	return Math.round(value * 1_000) / 1_000;
}

function distribution(samples) {
	const sorted = [...samples].sort((left, right) => left - right);
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		count: sorted.length,
		maxMs: roundMilliseconds(sorted.at(-1) ?? 0),
		meanMs: roundMilliseconds(sorted.length === 0 ? 0 : sum / sorted.length),
		minMs: roundMilliseconds(sorted[0] ?? 0),
		p50Ms: roundMilliseconds(percentile(sorted, 0.5)),
		p95Ms: roundMilliseconds(percentile(sorted, 0.95)),
		samplesMs: samples.map(roundMilliseconds)
	};
}

function measureScenario(options) {
	for (let index = 0; index < options.warmups; index += 1) {
		invoke(options.command, options.arguments, options);
	}
	const samples = [];
	for (let index = 0; index < options.runs; index += 1) {
		samples.push(invoke(options.command, options.arguments, options));
	}
	return {
		command: [options.command, ...options.arguments],
		distribution: distribution(samples),
		id: options.id,
		notes: options.notes,
		runs: options.runs,
		warmups: options.warmups,
		workload: options.workload
	};
}

function parseJsonOutput(label, output) {
	try {
		return JSON.parse(output);
	} catch (cause) {
		throw new Error(`${label} returned invalid JSON: ${String(cause)}`);
	}
}

function validateNativeInspection(output) {
	const decoded = parseJsonOutput("Native parser", output);
	if (
		!Number.isSafeInteger(decoded?.schema_version) ||
		!Array.isArray(decoded?.assets) ||
		decoded?.package === undefined
	) {
		throw new Error("Native parser returned an unexpected inspection contract.");
	}
}

function validateEnhancedInputReport(output) {
	const decoded = parseJsonOutput("TypeScript input projection", output);
	if (
		decoded?.schemaVersion !== 1 ||
		!Array.isArray(decoded.actions) ||
		!Array.isArray(decoded.mappingContexts)
	) {
		throw new Error("TypeScript input projection returned an unexpected report.");
	}
}

function capture(command, arguments_) {
	const result = spawnSync(command, arguments_, {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: process.env,
		maxBuffer: maxOutputBytes,
		windowsHide: true
	});
	if (result.error !== undefined || result.status !== 0) {
		throw commandFailure(command, arguments_, result);
	}
	return result.stdout.trim();
}

function fixtureStatistics(directory) {
	let packages = 0;
	let bytes = 0;
	const visit = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.isFile() && entry.name.endsWith(".uasset")) {
				packages += 1;
				bytes += statSync(path).size;
			}
		}
	};
	visit(join(directory, "Content"));
	return { bytes, packages };
}

function engineVersion(engineRoot) {
	const versionPath = join(engineRoot, "Engine", "Build", "Build.version");
	if (!existsSync(versionPath)) return undefined;
	const version = JSON.parse(readFileSync(versionPath, "utf8"));
	return {
		major: version.MajorVersion,
		minor: version.MinorVersion,
		patch: version.PatchVersion
	};
}

function matchingEngine(engineRoot, expected) {
	const version = engineVersion(engineRoot);
	return version?.major === expected.major && version?.minor === expected.minor;
}

function discoverEngineRoot(expected) {
	const configured = process.env.UE_SHED_UNREAL_ENGINE_ROOT;
	if (configured !== undefined) {
		const root = resolve(configured);
		if (!matchingEngine(root, expected)) {
			throw new Error(
				`UE_SHED_UNREAL_ENGINE_ROOT must point to Unreal ${expected.major}.${expected.minor}.`
			);
		}
		return root;
	}
	if (process.platform !== "win32") {
		throw new Error(
			"Automatic Unreal discovery is currently available only on Windows. " +
				"Set UE_SHED_UNREAL_ENGINE_ROOT."
		);
	}
	const epicRoot = join(process.env.ProgramFiles ?? "C:\\Program Files", "Epic Games");
	if (!existsSync(epicRoot)) {
		throw new Error(
			`Could not find Unreal ${expected.major}.${expected.minor} under ${epicRoot}.`
		);
	}
	const candidates = readdirSync(epicRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("UE_"))
		.map((entry) => join(epicRoot, entry.name))
		.filter((path) => matchingEngine(path, expected))
		.sort();
	const root = candidates.at(-1);
	if (root === undefined) {
		throw new Error(
			`Could not discover Unreal ${expected.major}.${expected.minor}. ` +
				"Set UE_SHED_UNREAL_ENGINE_ROOT."
		);
	}
	return root;
}

function gitContext() {
	return {
		dirty: capture("git", ["status", "--porcelain"]).length > 0,
		revision: capture("git", ["rev-parse", "HEAD"])
	};
}

function machineContext() {
	const processors = cpus();
	return {
		architecture: operatingSystemArchitecture(),
		cpuCount: processors.length,
		cpuModel: processors[0]?.model ?? "unknown",
		memoryBytes: totalmem(),
		nodeVersion: process.version,
		operatingSystem: operatingSystemPlatform(),
		rustVersion: capture("rustc", ["--version"])
	};
}

function printHuman(result) {
	process.stdout.write("UAsset parser benchmark\n");
	process.stdout.write(
		`revision=${result.git.revision.slice(0, 12)} dirty=${String(result.git.dirty)} ` +
			`platform=${result.machine.operatingSystem}/${result.machine.architecture}\n`
	);
	process.stdout.write(
		`fixture packages=${result.fixture.packages} bytes=${result.fixture.bytes} ` +
			`buildsExcluded=${String(result.configuration.buildsExcluded)}\n\n`
	);
	for (const scenario of result.scenarios) {
		const measured = scenario.distribution;
		process.stdout.write(
			`${scenario.id.padEnd(30)} p50=${measured.p50Ms.toFixed(3)} ms ` +
				`p95=${measured.p95Ms.toFixed(3)} ms ` +
				`min=${measured.minMs.toFixed(3)} ms max=${measured.maxMs.toFixed(3)} ms ` +
				`n=${measured.count}\n`
		);
	}
	if (result.scenarios.some((scenario) => scenario.id === "unreal.commandlet.verify")) {
		process.stdout.write(
			"\nUnreal verifies the fixture and performs more semantic work. Treat that lane as " +
				"fresh-commandlet startup plus verification, not an equivalent codec throughput ratio.\n"
		);
	}
}

function writeResult(path, result) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(result, null, "\t")}\n`, "utf8");
}

function main() {
	const parsed = parseArguments(process.argv.slice(2));
	if (parsed.help) {
		process.stdout.write(usage);
		return;
	}
	const options = parsed.options;
	if (!existsSync(benchmarkAsset)) {
		throw new Error(
			`Benchmark fixture is missing: ${relative(repositoryRoot, benchmarkAsset)}. ` +
				"Regenerate the generic Unreal fixture before benchmarking."
		);
	}
	if (options.build) {
		runSetup("cargo", ["build", "--locked", "--release", "-p", "uasset-parser"], options.json);
	}
	if (!existsSync(releaseExecutable)) {
		throw new Error(
			`Release parser not found at ${releaseExecutable}. Run without --no-build first.`
		);
	}

	const scenarios = [];
	const nativeArguments = ["inspect", benchmarkAsset, "--format", "json"];
	scenarios.push(
		measureScenario({
			arguments: nativeArguments,
			command: releaseExecutable,
			id: "native.inspect.single",
			notes: "Release native process; includes file read, decode, and JSON serialization.",
			runs: options.nativeRuns,
			validate: validateNativeInspection,
			warmups: options.warmups,
			workload: relative(repositoryRoot, benchmarkAsset)
		})
	);

	const applicationArguments = [
		"--import",
		"tsx",
		join(repositoryRoot, "apps", "cli", "src", "index.ts"),
		"input",
		"inspect"
	];
	const applicationEnvironment = {
		...process.env,
		UE_SHED_UASSET_EXECUTABLE: releaseExecutable
	};
	scenarios.push(
		measureScenario({
			arguments: [...applicationArguments, benchmarkAsset],
			command: process.execPath,
			environment: applicationEnvironment,
			id: "typescript.input.single",
			notes: "Source TypeScript application with release reader; excludes the Cargo launcher.",
			runs: options.nativeRuns,
			validate: validateEnhancedInputReport,
			warmups: options.warmups,
			workload: relative(repositoryRoot, benchmarkAsset)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: [...applicationArguments, fixtureRoot],
			command: process.execPath,
			environment: applicationEnvironment,
			id: "typescript.input.project",
			notes: "Source TypeScript application scans the fixture and invokes the release reader.",
			runs: options.nativeRuns,
			validate: validateEnhancedInputReport,
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);

	let unreal;
	if (options.unreal) {
		const fixtureContract = JSON.parse(readFileSync(fixtureContractPath, "utf8"));
		const engineRoot = discoverEngineRoot(fixtureContract.engine);
		const editorCommandlet = join(
			engineRoot,
			"Engine",
			"Binaries",
			"Win64",
			"UnrealEditor-Cmd.exe"
		);
		if (!existsSync(editorCommandlet)) {
			throw new Error(`Unreal commandlet not found at ${editorCommandlet}.`);
		}
		if (options.build) {
			runSetup(
				process.execPath,
				[join(repositoryRoot, "scripts", "unreal-fixture.mjs"), "build"],
				options.json
			);
		}
		const unrealArguments = [
			fixtureProject,
			"-run=UEShedBuildFixture",
			"-VerifyOnly",
			"-unattended",
			"-nop4",
			"-nosplash",
			"-NullRHI"
		];
		scenarios.push(
			measureScenario({
				arguments: unrealArguments,
				command: editorCommandlet,
				id: "unreal.commandlet.verify",
				notes: "Fresh commandlet startup plus fixture verification; not equivalent parser work.",
				runs: options.unrealRuns,
				warmups: options.warmups,
				workload: relative(repositoryRoot, fixtureProject)
			})
		);
		unreal = {
			engineRoot,
			version: engineVersion(engineRoot)
		};
	}

	const result = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		configuration: {
			buildsExcluded: true,
			nativeRuns: options.nativeRuns,
			unrealIncluded: options.unreal,
			unrealRuns: options.unrealRuns,
			warmups: options.warmups
		},
		fixture: fixtureStatistics(fixtureRoot),
		git: gitContext(),
		machine: machineContext(),
		scenarios,
		...(unreal === undefined ? {} : { unreal })
	};

	if (options.output !== undefined) writeResult(options.output, result);
	if (options.json) {
		process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
	} else {
		printHuman(result);
		if (options.output !== undefined) {
			process.stdout.write(`\nJSON written to ${options.output}\n`);
		}
	}
}

try {
	main();
} catch (error) {
	process.stderr.write(
		`UAsset benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`
	);
	process.exitCode = 1;
}
