import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packPublicPackages, PUBLIC_VERSION } from "./pack-public-packages.mjs";
import { buildPluginBundle } from "./plugin-bundle.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/;
const commitPattern = /^[0-9a-f]{40}$/;

export function validateCandidateVersion(value) {
	if (!candidateVersionPattern.test(value)) {
		throw new Error(`Candidate version must be exact x.y.z-rc.n SemVer, received ${value}.`);
	}
	return value;
}

export function validateCommit(value) {
	if (!commitPattern.test(value)) {
		throw new Error(`Candidate commit must be a full lowercase Git SHA, received ${value}.`);
	}
	return value;
}

export function validateRunId(value) {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error(
			`Unreal evidence run ID must be an exact positive integer, received ${value}.`
		);
	}
	return value;
}

export async function sha256(path) {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args, options = {}) {
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

async function ensureEmptyOutput(output) {
	if (existsSync(output)) {
		const entries = await readdir(output);
		if (entries.length > 0) {
			throw new Error(`Candidate output must be absent or empty: ${output}`);
		}
	}
	await mkdir(output, { recursive: true });
}

async function artifact(path, output, kind) {
	const details = await stat(path);
	return {
		kind,
		path: relative(output, path).replaceAll("\\", "/"),
		sha256: await sha256(path),
		bytes: details.size
	};
}

function gitArchive({ commit, output, prefix, paths = [] }) {
	run("git", [
		"archive",
		"--format=tar.gz",
		`--prefix=${prefix}/`,
		`--output=${output}`,
		commit,
		...paths
	]);
}

function tarDirectory({ directory, output }) {
	run("tar", ["-czf", output, "-C", directory, "."]);
}

function assertCandidateSource(commit) {
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
	unrealRunId
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
	assertCandidateSource(commit);
	const outputDirectory = resolve(output);
	await ensureEmptyOutput(outputDirectory);

	const sourcePath = join(outputDirectory, `ue-shed-${version}-source.tar.gz`);
	gitArchive({ commit, output: sourcePath, prefix: `ue-shed-${version}` });
	const packageOutput = join(outputDirectory, "npm");
	const artifacts = [await artifact(sourcePath, outputDirectory, "source")];
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

	const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
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
			lockfileSha256: await sha256(lockfilePath)
		},
		evidence: {
			portableCommand: "pnpm check",
			unrealCommand: unrealRunId === undefined ? null : "pnpm check:unreal",
			unrealRunId: unrealRunId ?? null
		},
		artifacts
	};
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

function parseArguments(args) {
	const values = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || value === undefined) {
			throw new Error(`Expected --key value arguments, received ${args.join(" ")}.`);
		}
		values.set(key.slice(2), value);
	}
	for (const required of ["version", "commit", "ref", "output"]) {
		if (!values.has(required)) throw new Error(`Missing required --${required} argument.`);
	}
	return values;
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const manifest = await createReleaseCandidate({
		version: args.get("version"),
		commit: args.get("commit"),
		ref: args.get("ref"),
		output: args.get("output"),
		unrealEvidenceDirectory: args.get("unreal-evidence"),
		unrealRunId: args.get("unreal-run-id")
	});
	console.log(
		`Candidate ${manifest.candidateVersion} contains ${manifest.artifacts.length} checksummed artifacts.`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
