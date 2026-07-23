import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

async function publicWorkspacePackages() {
	const roots = ["apps", "examples", "extensions", "packages"];
	const packages = [];
	for (const root of roots) {
		const directory = join(repositoryRoot, root);
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const packageDirectory = join(directory, entry.name);
			const manifestPath = join(packageDirectory, "package.json");
			if (!existsSync(manifestPath)) continue;
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			if (manifest.private !== true) packages.push({ directory: packageDirectory, manifest });
		}
	}
	return packages;
}

async function packPublicPackages({ output, version }) {
	const packageOutput = join(output, "npm");
	const packages = await publicWorkspacePackages();
	if (packages.length === 0) return [];
	await mkdir(packageOutput, { recursive: true });
	const packed = [];
	for (const workspacePackage of packages) {
		if (workspacePackage.manifest.version !== version) {
			throw new Error(
				`${workspacePackage.manifest.name} must use exact candidate version ${version} before packing.`
			);
		}
		const before = new Set(await readdir(packageOutput));
		const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
		run(pnpm, ["pack", "--pack-destination", packageOutput], {
			cwd: workspacePackage.directory
		});
		const filename = (await readdir(packageOutput)).find((entry) => !before.has(entry));
		if (!filename?.endsWith(".tgz")) {
			throw new Error(`${workspacePackage.manifest.name} did not produce an npm tarball.`);
		}
		packed.push({ path: join(packageOutput, filename), name: workspacePackage.manifest.name });
	}
	return packed;
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

export async function createReleaseCandidate({
	version,
	commit,
	ref,
	output,
	unrealEvidenceDirectory,
	unrealRunId
}) {
	validateCandidateVersion(version);
	validateCommit(commit);
	if (unrealRunId !== undefined) validateRunId(unrealRunId);
	if ((unrealEvidenceDirectory === undefined) !== (unrealRunId === undefined)) {
		throw new Error("Unreal evidence directory and run ID must be supplied together.");
	}
	const outputDirectory = resolve(output);
	await ensureEmptyOutput(outputDirectory);

	const sourcePath = join(outputDirectory, `ue-shed-${version}-source.tar.gz`);
	const pluginsPath = join(outputDirectory, `ue-shed-${version}-plugin-sources.tar.gz`);
	gitArchive({ commit, output: sourcePath, prefix: `ue-shed-${version}` });
	gitArchive({
		commit,
		output: pluginsPath,
		prefix: `ue-shed-plugins-${version}`,
		paths: ["unreal/Plugins"]
	});

	const artifacts = [
		await artifact(sourcePath, outputDirectory, "source"),
		await artifact(pluginsPath, outputDirectory, "unreal-plugin-source")
	];
	for (const packed of await packPublicPackages({ output: outputDirectory, version })) {
		artifacts.push({
			...(await artifact(packed.path, outputDirectory, "npm-package")),
			package: packed.name
		});
	}
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
			repository: "https://github.com/peculiarnewbie/ue-shed",
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
