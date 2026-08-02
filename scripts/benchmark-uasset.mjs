import { spawn, spawnSync } from "node:child_process";
import {
	cpus,
	arch as operatingSystemArchitecture,
	platform as operatingSystemPlatform,
	tmpdir,
	totalmem
} from "node:os";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkScript = fileURLToPath(import.meta.url);
const fixtureRoot = join(repositoryRoot, "fixtures", "unreal-project");
const fixtureProject = join(fixtureRoot, "UEShedFixture.uproject");
const fixtureContractPath = join(fixtureRoot, "fixture-contract.json");
const benchmarkAsset = join(fixtureRoot, "Content", "Fixture", "Input", "IMC_Fixture.uasset");
const benchmarkLevel = join(fixtureRoot, "Content", "Fixture", "Cameras", "L_CameraLoad.umap");
const benchmarkMap = benchmarkLevel;
const benchmarkAuthoringAsset = join(
	fixtureRoot,
	"Content",
	"Fixture",
	"Authoring",
	"DT_Scalars.uasset"
);
const benchmarkTextureRules = join(fixtureRoot, "FixtureSource", "Audits", "texture-rules.json");
const releaseExecutable = join(
	repositoryRoot,
	"target",
	"release",
	process.platform === "win32" ? "uasset.exe" : "uasset"
);
const maxOutputBytes = 64 * 1024 * 1024;
let collectMemory = true;

const usage = `Usage: node scripts/benchmark-uasset.mjs [options]

Options:
  --native-runs <count>  Native and TypeScript timed runs (default: 10)
  --unreal-runs <count>  Fresh Unreal commandlet timed runs (default: 3)
  --warmups <count>      Untimed warmups for each scenario (default: 1)
  --output <path>        Write the complete JSON result
  --json                 Print only JSON
  --memory               Add separate working-set sampling (slower)
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
		collectMemory: false,
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
			case "--memory":
				options.collectMemory = true;
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
	return { elapsedMs, stdout: result.stdout };
}

function processWorkingSetBytes(pid) {
	if (pid === undefined) return undefined;
	if (process.platform === "win32") {
		const result = spawnSync(
			"powershell",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`
			],
			{
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				windowsHide: true
			}
		);
		const value = Number(result.stdout?.trim());
		return Number.isFinite(value) && value > 0 ? value : undefined;
	}
	if (process.platform === "linux") {
		try {
			const status = readFileSync(`/proc/${pid}/status`, "utf8");
			const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
			return match === null ? undefined : Number(match[1]) * 1024;
		} catch {
			return undefined;
		}
	}
	const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		windowsHide: true
	});
	const value = Number(result.stdout?.trim());
	return Number.isFinite(value) && value > 0 ? value * 1024 : undefined;
}

async function runMemoryHelper(options) {
	const child = spawn(options.command, options.arguments, {
		cwd: repositoryRoot,
		env: { ...process.env, ...options.environmentOverrides },
		windowsHide: true
	});
	let childError;
	child.once("error", (cause) => {
		childError = cause;
	});
	child.stdout?.resume();
	child.stderr?.resume();
	let peakWorkingSetBytes;
	const sample = () => {
		const workingSetBytes = processWorkingSetBytes(child.pid);
		if (workingSetBytes !== undefined) {
			peakWorkingSetBytes = Math.max(peakWorkingSetBytes ?? 0, workingSetBytes);
		}
	};
	sample();
	const interval = setInterval(sample, 5);
	const result = await new Promise((resolvePromise) => {
		child.once("close", (code, signal) => resolvePromise({ code, signal }));
	});
	clearInterval(interval);
	sample();
	if (childError !== undefined || result.code !== 0) {
		throw new Error(
			childError?.message ??
				`memory sample target exited ${result.code ?? result.signal ?? "unknown"}`
		);
	}
	process.stdout.write(
		`${JSON.stringify({ peakWorkingSetBytes: peakWorkingSetBytes ?? null })}\n`
	);
}

function measureMemory(options) {
	const payload = Buffer.from(
		JSON.stringify({
			arguments: options.arguments,
			command: options.command,
			environmentOverrides: options.environmentOverrides ?? {}
		}),
		"utf8"
	).toString("base64url");
	const result = spawnSync(process.execPath, [benchmarkScript, "--memory-helper", payload], {
		cwd: repositoryRoot,
		encoding: "utf8",
		maxBuffer: maxOutputBytes,
		windowsHide: true
	});
	if (result.error !== undefined || result.status !== 0) {
		throw commandFailure(process.execPath, [benchmarkScript, "--memory-helper"], result);
	}
	try {
		return JSON.parse(result.stdout);
	} catch (cause) {
		throw new Error(`Memory helper returned invalid JSON: ${String(cause)}`);
	}
}

function percentile(sorted, ratio) {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
	return sorted[index] ?? 0;
}

function roundMilliseconds(value) {
	return Math.round(value * 1_000) / 1_000;
}

function formatBytes(value) {
	if (value === null || value === undefined) return "unavailable";
	return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
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
		options.beforeInvoke?.({ index, phase: "warmup" });
		invoke(options.command, options.arguments, options);
	}
	const samples = [];
	let lastStdout = "";
	for (let index = 0; index < options.runs; index += 1) {
		options.beforeInvoke?.({ index, phase: "timed" });
		const { elapsedMs, stdout } = invoke(options.command, options.arguments, options);
		samples.push(elapsedMs);
		lastStdout = stdout;
	}
	const observed = options.observe?.(lastStdout);
	return {
		command: [options.command, ...options.arguments],
		distribution: distribution(samples),
		id: options.id,
		...(options.memory === true && collectMemory ? { memory: measureMemory(options) } : {}),
		notes: options.notes,
		runs: options.runs,
		warmups: options.warmups,
		workload: options.workload,
		...(observed === undefined ? {} : { observed })
	};
}

/**
 * Reads the commandlet's self-reported level parse timings.
 *
 * The commandlet's wall-clock is mostly editor startup, so it prints the load and property-walk
 * seconds it actually spent. Without this the lane can only say "an editor is slow to boot", which
 * is true but says nothing about codec speed.
 */
function observeCommandletLevelParse(output) {
	const marker =
		/UEShedLevelParse objects=(\d+) properties=(\d+) loadSeconds=([\d.]+)\s+walkSeconds=([\d.]+)/.exec(
			output.replaceAll(/\r?\n/g, " ")
		);
	if (marker === null) {
		throw new Error("Commandlet level parse did not report its UEShedLevelParse marker.");
	}
	const loadMs = Number(marker[3]) * 1_000;
	const walkMs = Number(marker[4]) * 1_000;
	return {
		exports: Number(marker[1]),
		properties: Number(marker[2]),
		loadMs: roundMilliseconds(loadMs),
		walkMs: roundMilliseconds(walkMs),
		parseMs: roundMilliseconds(loadMs + walkMs)
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

function parseNativeScan(output) {
	return output
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => parseJsonOutput("Native scan", line));
}

function validateNativeScan(output) {
	const records = parseNativeScan(output);
	if (!records.some((record) => record?.event === "summary")) {
		throw new Error("Native scan did not return a summary record.");
	}
}

function observeNativeScan(output) {
	const summary = parseNativeScan(output).find((record) => record?.event === "summary");
	if (summary === undefined) throw new Error("Native scan did not return a summary record.");
	return {
		cacheHits: summary.cacheHits,
		emittedAssets: summary.emittedAssets,
		scannedAssets: summary.scannedAssets
	};
}

function validateNativeProjection(output, eventName, recordEvent = `${eventName}_record`) {
	const records = output
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => parseJsonOutput(`Native ${eventName} projection`, line));
	if (!records.some((record) => record?.event === recordEvent)) {
		throw new Error(`Native ${eventName} projection did not return a record.`);
	}
}

function validateAuthoringReport(output) {
	const decoded = parseJsonOutput("Authoring report", output);
	if (
		decoded?.table?.objectPath === undefined &&
		decoded?.snapshot?.table?.objectPath === undefined
	) {
		throw new Error("Authoring report returned an unexpected snapshot.");
	}
}

function validateSavedWorldReport(output) {
	const decoded = parseJsonOutput("Saved-world report", output);
	if (decoded?.authority?.kind === undefined || !Array.isArray(decoded.actors)) {
		throw new Error("Saved-world report returned an unexpected shape.");
	}
}

function validateTextReport(output) {
	const decoded = parseJsonOutput("TypeScript text report", output);
	if (decoded?.schemaVersion !== 1 || !Array.isArray(decoded.units)) {
		throw new Error("TypeScript text report returned an unexpected shape.");
	}
}

function validateTextureReport(output) {
	const decoded = parseJsonOutput("TypeScript texture report", output);
	if (decoded?.schemaVersion !== 1 || !Array.isArray(decoded.records)) {
		throw new Error("TypeScript texture report returned an unexpected shape.");
	}
}

function validateAssetScanReport(output) {
	const decoded = parseJsonOutput("TypeScript assets scan", output);
	if (!Array.isArray(decoded.assets) || decoded.summary?.scannedAssets === undefined) {
		throw new Error("TypeScript assets scan returned an unexpected report.");
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

function validateHelp(output) {
	if (!output.includes("UE Shed") && !output.includes("uasset — Unreal asset inspection")) {
		throw new Error("CLI help output did not contain its command banner.");
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
			} else if (
				entry.isFile() &&
				(entry.name.endsWith(".uasset") || entry.name.endsWith(".umap"))
			) {
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
	process.stdout.write("UAsset CLI benchmark\n");
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
		if (scenario.observed?.parseMs !== undefined) {
			process.stdout.write(
				`${" ".repeat(30)}  in-process parse=${scenario.observed.parseMs.toFixed(3)} ms ` +
					`(load=${scenario.observed.loadMs.toFixed(3)} walk=${scenario.observed.walkMs.toFixed(3)}) ` +
					`exports=${scenario.observed.exports} properties=${scenario.observed.properties}\n`
			);
		}
		if (scenario.observed?.scannedAssets !== undefined) {
			process.stdout.write(
				`${" ".repeat(30)}  scanned=${scenario.observed.scannedAssets} ` +
					`emitted=${scenario.observed.emittedAssets} cacheHits=${scenario.observed.cacheHits}\n`
			);
		}
		if (scenario.memory !== undefined) {
			process.stdout.write(
				`${" ".repeat(30)}  peak working set=${formatBytes(scenario.memory.peakWorkingSetBytes)}\n`
			);
		}
	}
	const level = result.scenarios.find((scenario) => scenario.id === "unreal.commandlet.level");
	const native = result.scenarios.find((scenario) => scenario.id === "native.inspect.level");
	if (level !== undefined && native !== undefined) {
		const endToEnd = level.distribution.p50Ms / native.distribution.p50Ms;
		const parseOnly = level.observed.parseMs / native.distribution.p50Ms;
		process.stdout.write(
			`\nLevel comparison on the same package: the parser is ${endToEnd.toFixed(1)}x faster ` +
				`end to end (what a caller pays), and ${parseOnly.toFixed(2)}x the commandlet's ` +
				"in-process parse cost. The end-to-end gap is editor startup avoided; the parse-only " +
				"figure is the closer codec comparison, and it flatters the commandlet, whose walk " +
				"excludes process start and JSON serialization.\n"
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
	collectMemory = options.collectMemory;
	if (!existsSync(benchmarkAsset)) {
		throw new Error(
			`Benchmark fixture is missing: ${relative(repositoryRoot, benchmarkAsset)}. ` +
				"Regenerate the generic Unreal fixture before benchmarking."
		);
	}
	if (options.build) {
		runSetup("cargo", ["build", "--locked", "--release", "-p", "uasset-io"], options.json);
	}
	if (!existsSync(releaseExecutable)) {
		throw new Error(
			`Release uasset executable not found at ${releaseExecutable}. Run without --no-build first.`
		);
	}
	const temporaryRoot = mkdtempSync(join(tmpdir(), "ue-shed-uasset-benchmark-"));
	process.once("exit", () => rmSync(temporaryRoot, { force: true, recursive: true }));
	const headerCachePath = join(temporaryRoot, "header-cache.json");

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
	for (const concurrency of [1, 4]) {
		scenarios.push(
			measureScenario({
				arguments: [
					"scan",
					fixtureRoot,
					"--format",
					"json",
					"--depth",
					"header",
					"--concurrency",
					String(concurrency)
				],
				command: releaseExecutable,
				id: `native.scan.header.concurrency${concurrency}`,
				notes: `Release native header scan with explicit concurrency ${concurrency}.`,
				observe: observeNativeScan,
				runs: options.nativeRuns,
				validate: validateNativeScan,
				warmups: options.warmups,
				workload: relative(repositoryRoot, fixtureRoot)
			})
		);
	}
	const cachedHeaderArguments = [
		"scan",
		fixtureRoot,
		"--format",
		"json",
		"--depth",
		"header",
		"--cache",
		headerCachePath,
		"--concurrency",
		"4"
	];
	scenarios.push(
		measureScenario({
			arguments: cachedHeaderArguments,
			beforeInvoke: () => rmSync(headerCachePath, { force: true }),
			command: releaseExecutable,
			id: "native.scan.header.cache.cold",
			notes: "Header cache absent before every sample; filesystem caches remain warm.",
			observe: observeNativeScan,
			runs: options.nativeRuns,
			validate: validateNativeScan,
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);
	invoke(releaseExecutable, cachedHeaderArguments, { validate: validateNativeScan });
	scenarios.push(
		measureScenario({
			arguments: cachedHeaderArguments,
			command: releaseExecutable,
			id: "native.scan.header.cache.warm",
			notes: "Header cache seeded before warmups and retained across samples.",
			observe: observeNativeScan,
			runs: options.nativeRuns,
			validate: validateNativeScan,
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: ["authoring", benchmarkAuthoringAsset, "--format", "json"],
			command: releaseExecutable,
			id: "native.authoring.inspect",
			notes: "Release native authoring projection for one fixture DataTable.",
			runs: options.nativeRuns,
			validate: validateAuthoringReport,
			warmups: options.warmups,
			workload: relative(repositoryRoot, benchmarkAuthoringAsset)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: ["scan", fixtureRoot, "--format", "json", "--projection", "text"],
			command: releaseExecutable,
			id: "native.text.scan",
			notes: "Release native compact text projection over the fixture.",
			runs: options.nativeRuns,
			validate: (output) => validateNativeProjection(output, "text", "text_occurrence"),
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: ["scan", fixtureRoot, "--format", "json", "--projection", "texture"],
			command: releaseExecutable,
			id: "native.texture.scan",
			notes: "Release native compact texture projection over the fixture.",
			runs: options.nativeRuns,
			validate: (output) => validateNativeProjection(output, "texture"),
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: ["saved-world", fixtureRoot, benchmarkMap, "--format", "json"],
			command: releaseExecutable,
			id: "native.saved-world.inspect",
			notes: "Release native saved-world projection for the fixture level.",
			runs: options.nativeRuns,
			validate: validateSavedWorldReport,
			warmups: options.warmups,
			workload: relative(repositoryRoot, benchmarkMap)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: ["scan", fixtureRoot, "--format", "json", "--depth", "full"],
			command: releaseExecutable,
			environmentOverrides: {},
			id: "native.scan.project",
			memory: true,
			notes: "Release native full project scan with NDJSON asset records and summary.",
			runs: options.nativeRuns,
			validate: validateNativeScan,
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: ["--help"],
			command: releaseExecutable,
			id: "native.cli.help",
			memory: true,
			notes: "Diagnostic Rust CLI startup and help rendering.",
			runs: options.nativeRuns,
			validate: validateHelp,
			warmups: options.warmups,
			workload: "uasset --help"
		})
	);

	scenarios.push(
		measureScenario({
			arguments: ["inspect", benchmarkLevel, "--format", "json"],
			command: releaseExecutable,
			id: "native.inspect.level",
			memory: true,
			notes:
				"Release native process over the fixture level, the largest package in the fixture " +
				"(16,525 exports). Directly comparable to unreal.commandlet.level.",
			runs: options.nativeRuns,
			validate: validateNativeInspection,
			warmups: options.warmups,
			workload: relative(repositoryRoot, benchmarkLevel)
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
	const applicationEnvironmentOverrides = {
		UE_SHED_UASSET_EXECUTABLE: releaseExecutable
	};
	scenarios.push(
		measureScenario({
			arguments: [
				...applicationArguments.slice(0, 3),
				"authoring",
				"inspect",
				benchmarkAuthoringAsset
			],
			command: process.execPath,
			environment: applicationEnvironment,
			environmentOverrides: applicationEnvironmentOverrides,
			id: "typescript.authoring.inspect",
			notes: "Source TypeScript authoring inspection with the release reader.",
			runs: options.nativeRuns,
			validate: validateAuthoringReport,
			warmups: options.warmups,
			workload: relative(repositoryRoot, benchmarkAuthoringAsset)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: [...applicationArguments.slice(0, 3), "text", "scan", fixtureRoot],
			command: process.execPath,
			environment: applicationEnvironment,
			environmentOverrides: applicationEnvironmentOverrides,
			id: "typescript.text.scan",
			notes: "Source TypeScript compact text scan with the release reader.",
			runs: options.nativeRuns,
			validate: validateTextReport,
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: [
				...applicationArguments.slice(0, 3),
				"audit",
				"textures",
				fixtureRoot,
				"--rules",
				benchmarkTextureRules
			],
			command: process.execPath,
			environment: applicationEnvironment,
			environmentOverrides: applicationEnvironmentOverrides,
			id: "typescript.texture.audit",
			notes: "Source TypeScript texture audit with compact reader results and fixture rules.",
			runs: options.nativeRuns,
			validate: validateTextureReport,
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: [...applicationArguments.slice(0, 3), "--help"],
			command: process.execPath,
			id: "typescript.cli.help",
			memory: true,
			notes: "Current TypeScript CLI startup and help rendering.",
			runs: options.nativeRuns,
			validate: validateHelp,
			warmups: options.warmups,
			workload: "apps/cli --help"
		})
	);
	scenarios.push(
		measureScenario({
			arguments: [...applicationArguments, benchmarkAsset],
			command: process.execPath,
			environment: applicationEnvironment,
			environmentOverrides: applicationEnvironmentOverrides,
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
			environmentOverrides: applicationEnvironmentOverrides,
			id: "typescript.input.project",
			memory: true,
			notes: "Source TypeScript application scans the fixture and invokes the release reader.",
			runs: options.nativeRuns,
			validate: validateEnhancedInputReport,
			warmups: options.warmups,
			workload: relative(repositoryRoot, fixtureRoot)
		})
	);
	scenarios.push(
		measureScenario({
			arguments: [
				...applicationArguments.slice(0, 3),
				"assets",
				"scan",
				fixtureRoot,
				"--full"
			],
			command: process.execPath,
			environment: applicationEnvironment,
			environmentOverrides: applicationEnvironmentOverrides,
			id: "typescript.assets.scan",
			memory: true,
			notes: "Source TypeScript assets scan with the full report and release reader.",
			runs: options.nativeRuns,
			validate: validateAssetScanReport,
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
		scenarios.push(
			measureScenario({
				arguments: [
					fixtureProject,
					"-run=UEShedBuildFixture",
					"-BenchmarkLevelParse",
					"-unattended",
					"-nop4",
					"-nosplash",
					"-NullRHI"
				],
				command: editorCommandlet,
				id: "unreal.commandlet.level",
				notes:
					"Fresh commandlet that loads the fixture level and walks every serialized property. " +
					"The distribution is wall-clock, so it is dominated by editor startup; `observed` " +
					"carries the load and walk milliseconds the commandlet spent on the package " +
					"itself, which is the part comparable to native.inspect.level.",
				observe: observeCommandletLevelParse,
				runs: options.unrealRuns,
				warmups: options.warmups,
				workload: relative(repositoryRoot, benchmarkLevel)
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
			memorySampling: options.collectMemory,
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

if (process.argv[2] === "--memory-helper") {
	try {
		const payload = JSON.parse(
			Buffer.from(process.argv[3] ?? "", "base64url").toString("utf8")
		);
		runMemoryHelper(payload).catch((error) => {
			process.stderr.write(
				`UAsset memory helper failed: ${error instanceof Error ? error.message : String(error)}\n`
			);
			process.exitCode = 1;
		});
	} catch (error) {
		process.stderr.write(
			`UAsset memory helper failed: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
	}
} else {
	try {
		main();
	} catch (error) {
		process.stderr.write(
			`UAsset benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
	}
}
