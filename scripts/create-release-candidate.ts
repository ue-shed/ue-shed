import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isJsonString } from "./json.ts";
import { packPublicPackages, PUBLIC_VERSION, WASM_PACKAGE_NAME } from "./pack-public-packages.ts";
import { buildPluginBundle } from "./plugin-bundle.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/;
const commitPattern = /^[0-9a-f]{40}$/;

export interface WasmBuildInfo {
	readonly schemaVersion: number;
	readonly cargoLocked: boolean;
	readonly packageVersion: string;
	readonly crateVersion: string;
	readonly targets: readonly string[];
	readonly tools: Readonly<Record<string, string>> & {
		readonly rustc: string;
		readonly wasmPack: string;
		readonly wasmBindgen: string;
		readonly wasmOpt: string;
	};
	readonly optimizer: {
		readonly name: string;
		readonly enabled: boolean;
		readonly status?: string;
		readonly reason?: string;
		readonly command: string | null;
		readonly version: string | null;
	};
	readonly limits: Readonly<Record<string, number>>;
}

interface CandidateArtifact {
	readonly kind: string;
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly package?: string;
	readonly version?: string;
}

interface TrustedEvidenceManifest {
	readonly evidence?: {
		readonly unrealWorkflow?: string | null;
		readonly unrealRunId?: string | null;
	};
	readonly artifacts?: ReadonlyArray<{ readonly kind?: string }>;
}

interface RunOptions {
	readonly cwd?: string;
}

export function validateCandidateVersion(value: string) {
	if (!candidateVersionPattern.test(value)) {
		throw new Error(`Candidate version must be exact x.y.z-rc.n SemVer, received ${value}.`);
	}
	return value;
}

export function validateCommit(value: string) {
	if (!commitPattern.test(value)) {
		throw new Error(`Candidate commit must be a full lowercase Git SHA, received ${value}.`);
	}
	return value;
}

export function validateRunId(value: string) {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error(
			`Unreal evidence run ID must be an exact positive integer, received ${value}.`
		);
	}
	return value;
}

export async function sha256(path: string) {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

function run(command: string, args: readonly string[], options: RunOptions = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: "utf8",
		shell: false
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
		);
	}
	return result.stdout.trim();
}

const expectedWasmTargets = ["nodejs", "web"];
const expectedWasmLimits = {
	maxInputBytes: 64 * 1024 * 1024,
	maxOutputBytes: 64 * 1024 * 1024,
	maxExports: 100_000,
	maxProjectionItems: 1_000_000
};

export function validateWasmBuildInfo(buildInfo: WasmBuildInfo) {
	const failures: string[] = [];
	if (buildInfo?.schemaVersion !== 1) failures.push("schemaVersion must be 1");
	if (buildInfo?.cargoLocked !== true) failures.push("cargoLocked must be true");
	if (buildInfo?.packageVersion !== PUBLIC_VERSION) {
		failures.push(`packageVersion must be ${PUBLIC_VERSION}`);
	}
	if (buildInfo?.crateVersion !== PUBLIC_VERSION) {
		failures.push(`crateVersion must be ${PUBLIC_VERSION}`);
	}
	if (JSON.stringify(buildInfo?.targets) !== JSON.stringify(expectedWasmTargets)) {
		failures.push(`targets must be ${JSON.stringify(expectedWasmTargets)}`);
	}
	for (const tool of ["rustc", "wasmPack", "wasmBindgen"]) {
		const identity = buildInfo?.tools?.[tool];
		if (!isJsonString(identity) || identity.length === 0) {
			failures.push(`tools.${tool} must record the build identity`);
		}
	}
	const optimizer = buildInfo?.optimizer;
	if (optimizer?.name !== "wasm-opt") failures.push("optimizer.name must be wasm-opt");
	if (optimizer?.enabled !== true && optimizer?.enabled !== false) {
		failures.push("optimizer.enabled must state whether wasm-opt ran");
	}
	if (!buildInfo?.tools?.wasmOpt) {
		failures.push("tools.wasmOpt must describe the optimizer state");
	}
	if (optimizer?.enabled === true) {
		if (!optimizer.version) {
			failures.push("enabled optimizer must record a concrete version");
		}
		if (!optimizer.command) {
			failures.push("enabled optimizer must record its invocation");
		}
		if (optimizer.version && /(?:unavailable|disabled|not[ -]?run)/iu.test(optimizer.version)) {
			failures.push("enabled optimizer must have a concrete version");
		}
		if (buildInfo.tools.wasmOpt !== optimizer.version) {
			failures.push("tools.wasmOpt must match the enabled optimizer version");
		}
	}
	if (optimizer?.enabled === false) {
		if (optimizer.status !== "disabled") {
			failures.push("disabled optimizer must record status disabled");
		}
		if (!optimizer.reason) {
			failures.push("disabled optimizer must record why it did not run");
		}
		if (!/(?:disabled|no[ -]?opt|not[ -]?run|not[ -]?used)/iu.test(buildInfo.tools.wasmOpt)) {
			failures.push("tools.wasmOpt must explicitly record that optimization was disabled");
		}
	}
	for (const [name, expected] of Object.entries(expectedWasmLimits)) {
		if (buildInfo?.limits?.[name] !== expected) {
			failures.push(`limits.${name} must be ${expected}`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`Invalid WASM build-info.json:\n- ${failures.join("\n- ")}`);
	}
	return buildInfo;
}

async function readWasmBuildInfo() {
	const path = join(
		repositoryRoot,
		"packages",
		"uasset-inspection-wasm",
		"dist",
		"build-info.json"
	);
	let buildInfo: WasmBuildInfo;
	try {
		// SAFETY: the WASM build writes this contract and validateWasmBuildInfo checks every field next.
		buildInfo = JSON.parse(await readFile(path, "utf8")) as WasmBuildInfo;
	} catch (cause) {
		throw new Error(`Could not read generated WASM build evidence at ${path}.`, { cause });
	}
	return validateWasmBuildInfo(buildInfo);
}

const trustedUnrealEvidenceFiles = ["runner.json", "unreal-build.json", "unreal-check.log"];

function assertEvidenceDirectory(directory: string) {
	const missing = trustedUnrealEvidenceFiles.filter(
		(file) => !existsSync(join(resolve(directory), file))
	);
	if (missing.length > 0) {
		throw new Error(
			`Trusted Unreal evidence is missing required files: ${missing.join(", ")}.`
		);
	}
}

export function assertTrustedUnrealEvidence({
	manifest,
	expectedRunId
}: {
	readonly manifest: TrustedEvidenceManifest;
	readonly expectedRunId: string;
}) {
	if (manifest.evidence?.unrealWorkflow !== "Trusted Unreal") {
		throw new Error("Candidate is not bound to the Trusted Unreal workflow.");
	}
	if (manifest.evidence?.unrealRunId !== expectedRunId) {
		throw new Error(
			`Candidate is bound to Unreal run ${manifest.evidence?.unrealRunId ?? "none"}, expected ${expectedRunId}.`
		);
	}
	if (
		!manifest.artifacts?.some(
			(artifactEntry) => artifactEntry.kind === "trusted-unreal-evidence"
		)
	) {
		throw new Error("Candidate does not contain a trusted-unreal-evidence artifact.");
	}
}

async function ensureEmptyOutput(output: string) {
	if (existsSync(output)) {
		const entries = await readdir(output);
		if (entries.length > 0) {
			throw new Error(`Candidate output must be absent or empty: ${output}`);
		}
	}
	await mkdir(output, { recursive: true });
}

async function artifact(path: string, output: string, kind: string): Promise<CandidateArtifact> {
	const details = await stat(path);
	return {
		kind,
		path: relative(output, path).replaceAll("\\", "/"),
		sha256: await sha256(path),
		bytes: details.size
	};
}

function gitArchive({
	commit,
	output,
	prefix,
	paths = []
}: {
	readonly commit: string;
	readonly output: string;
	readonly prefix: string;
	readonly paths?: readonly string[];
}) {
	run("git", [
		"archive",
		"--format=tar.gz",
		`--prefix=${prefix}/`,
		`--output=${output}`,
		commit,
		...paths
	]);
}

function tarDirectory({ directory, output }: { directory: string; output: string }) {
	run("tar", ["-czf", output, "-C", directory, "."]);
}

function assertCandidateSource(commit: string) {
	const head = run("git", ["rev-parse", "HEAD"]);
	if (head !== commit) {
		throw new Error(`Candidate commit ${commit} does not match checked-out HEAD ${head}.`);
	}
	const changes = run("git", ["status", "--porcelain", "--untracked-files=all"]);
	if (changes !== "") {
		throw new Error("Candidate construction requires a clean worktree.");
	}
}

export async function createReleaseCandidate({
	version,
	commit,
	ref,
	output,
	unrealEvidenceDirectory,
	unrealRunId,
	requireTrustedUnrealEvidence = false
}: {
	readonly version: string;
	readonly commit: string;
	readonly ref: string;
	readonly output: string;
	readonly unrealEvidenceDirectory?: string | undefined;
	readonly unrealRunId?: string | undefined;
	readonly requireTrustedUnrealEvidence?: boolean;
}) {
	validateCandidateVersion(version);
	if (version !== PUBLIC_VERSION) {
		throw new Error(`Public packages are frozen at ${PUBLIC_VERSION}, received ${version}.`);
	}
	validateCommit(commit);
	if (unrealRunId !== undefined) validateRunId(unrealRunId);
	if ((unrealEvidenceDirectory === undefined) !== (unrealRunId === undefined)) {
		throw new Error("Unreal evidence directory and run ID must be supplied together.");
	}
	if (requireTrustedUnrealEvidence && unrealRunId === undefined) {
		throw new Error("Actual publication requires a successful Trusted Unreal evidence run.");
	}
	if (unrealEvidenceDirectory !== undefined) assertEvidenceDirectory(unrealEvidenceDirectory);
	assertCandidateSource(commit);
	const outputDirectory = resolve(output);
	await ensureEmptyOutput(outputDirectory);

	const sourcePath = join(outputDirectory, `ue-shed-${version}-source.tar.gz`);
	gitArchive({ commit, output: sourcePath, prefix: `ue-shed-${version}` });
	const packageOutput = join(outputDirectory, "npm");
	const artifacts: CandidateArtifact[] = [await artifact(sourcePath, outputDirectory, "source")];
	for (const packed of await packPublicPackages({ output: packageOutput })) {
		artifacts.push({
			...(await artifact(packed.path, outputDirectory, "npm-package")),
			package: packed.name,
			version: packed.manifest.version
		});
	}
	artifacts.push(
		await artifact(
			join(packageOutput, "packages-manifest.json"),
			outputDirectory,
			"npm-manifest"
		),
		await artifact(join(packageOutput, "SHA256SUMS"), outputDirectory, "npm-checksums")
	);
	const pluginOutput = join(outputDirectory, "plugins");
	const pluginBundle = await buildPluginBundle({
		candidateManifest: join(packageOutput, "packages-manifest.json"),
		output: pluginOutput,
		releaseVersion: version,
		sourceCommit: commit,
		sourceRef: ref,
		unreal: { maximum: "5.7", minimum: "5.7" }
	});
	artifacts.push(
		await artifact(pluginBundle.archivePath, outputDirectory, "unreal-plugin-source"),
		await artifact(pluginBundle.manifestPath, outputDirectory, "unreal-plugin-manifest")
	);
	if (unrealEvidenceDirectory !== undefined) {
		const evidencePath = join(outputDirectory, `ue-shed-${version}-unreal-evidence.tar.gz`);
		tarDirectory({ directory: resolve(unrealEvidenceDirectory), output: evidencePath });
		artifacts.push(await artifact(evidencePath, outputDirectory, "trusted-unreal-evidence"));
	}
	artifacts.sort((left, right) => left.path.localeCompare(right.path));

	const wasmBuildInfo = await readWasmBuildInfo();
	// SAFETY: the repository root package.json owns the packageManager field used for evidence.
	const rootManifest = JSON.parse(
		await readFile(join(repositoryRoot, "package.json"), "utf8")
	) as { readonly packageManager: string };
	const lockfilePath = join(repositoryRoot, "pnpm-lock.yaml");
	const createdAt = run("git", ["show", "-s", "--format=%cI", commit]);
	const manifest = {
		schemaVersion: 1,
		candidateVersion: version,
		createdAt,
		source: {
			repository: "https://github.com/ue-shed/ue-shed",
			commit,
			ref
		},
		toolchain: {
			packageManager: rootManifest.packageManager,
			lockfileSha256: await sha256(lockfilePath),
			wasm: wasmBuildInfo
		},
		evidence: {
			portableCommand: "pnpm check",
			unrealCommand: unrealRunId === undefined ? null : "pnpm check:unreal",
			unrealWorkflow: unrealRunId === undefined ? null : "Trusted Unreal",
			unrealRunId: unrealRunId ?? null
		},
		compatibility: {
			wasmPackage: WASM_PACKAGE_NAME,
			inspectionSchemaVersion: 8,
			projectionSchemaVersion: 1,
			input: "package-bytes",
			runtimes: ["browser", "node"]
		},
		artifacts
	};
	if (requireTrustedUnrealEvidence) {
		assertTrustedUnrealEvidence({ manifest, expectedRunId: unrealRunId! });
	}
	const manifestPath = join(outputDirectory, "candidate-manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	const checksumEntries = [
		...artifacts,
		await artifact(manifestPath, outputDirectory, "manifest")
	];
	await writeFile(
		join(outputDirectory, "SHA256SUMS"),
		`${checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
		"utf8"
	);
	return manifest;
}

function parseArguments(args: readonly string[]) {
	const values = new Map<string, string | boolean>();
	for (let index = 0; index < args.length; index += 1) {
		const key = args[index];
		if (!key?.startsWith("--")) {
			throw new Error(`Expected --key value arguments, received ${args.join(" ")}.`);
		}
		if (key === "--require-unreal-evidence") {
			values.set("require-unreal-evidence", true);
			continue;
		}
		const value = args[index + 1];
		if (value === undefined) {
			throw new Error(`Expected --key value arguments, received ${args.join(" ")}.`);
		}
		values.set(key.slice(2), value);
		index += 1;
	}
	for (const required of ["version", "commit", "ref", "output"]) {
		if (!values.has(required)) throw new Error(`Missing required --${required} argument.`);
	}
	return values;
}

function requiredArgument(values: ReadonlyMap<string, string | boolean>, key: string): string {
	const value = values.get(key);
	if (value === undefined || value === true || value === false)
		throw new Error(`Missing required --${key} argument.`);
	return value;
}

function optionalArgument(
	values: ReadonlyMap<string, string | boolean>,
	key: string
): string | undefined {
	const value = values.get(key);
	return value === undefined || value === true || value === false ? undefined : value;
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const manifest = await createReleaseCandidate({
		version: requiredArgument(args, "version"),
		commit: requiredArgument(args, "commit"),
		ref: requiredArgument(args, "ref"),
		output: requiredArgument(args, "output"),
		unrealEvidenceDirectory: optionalArgument(args, "unreal-evidence"),
		unrealRunId: optionalArgument(args, "unreal-run-id"),
		requireTrustedUnrealEvidence: args.has("require-unreal-evidence")
	});
	console.log(
		`Candidate ${manifest.candidateVersion} contains ${manifest.artifacts.length} checksummed artifacts.`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
