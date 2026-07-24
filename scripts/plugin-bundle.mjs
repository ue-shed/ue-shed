import { createHash } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPluginRoot = join(repositoryRoot, "unreal", "Plugins");
const canonicalRepository = "https://github.com/ue-shed/ue-shed";
const archivePrefix = "UEShed/Plugins";
const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

/** Exact Unreal plugin graph for Plan 028's first Map Review vertical. */
export const MAP_REVIEW_PLUGIN_IDS = Object.freeze(["UEShedCore", "UEShedCameras"]);
/** Exact Unreal plugin graph for the headless Observatory host. */
export const OBSERVATORY_PLUGIN_IDS = Object.freeze(["UEShedObservatory"]);

const ignoredDirectoryNames = new Set([
	".git",
	".ue-shed",
	".vs",
	"binaries",
	"deriveddatacache",
	"intermediate",
	"node_modules",
	"saved",
	"target"
]);

const ignoredFilePattern = /(?:\.sln|\.suo|\.user|\.userprefs|\.vcxproj\.user|\.xcuserstate)$/iu;

function toPosix(path) {
	return path.replaceAll("\\", "/");
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: "utf8",
		shell: false,
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
		);
	}
	return result.stdout ?? "";
}

async function sha256(path) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

function validateReleaseVersion(value) {
	if (!releaseVersionPattern.test(value)) {
		throw new Error(`Plugin release version must be SemVer, received ${value}.`);
	}
	return value;
}

function validateCommit(value) {
	if (value === undefined || value === null) return value;
	if (!commitPattern.test(value)) {
		throw new Error(
			`Plugin source commit must be a full lowercase Git SHA, received ${value}.`
		);
	}
	return value;
}

function validateUnrealRange(unreal) {
	const minimum = unreal?.minimum ?? "5.7";
	const maximum = unreal?.maximum ?? minimum;
	if (typeof minimum !== "string" || minimum.length === 0) {
		throw new Error("Unreal compatibility minimum must be a non-empty version string.");
	}
	if (typeof maximum !== "string" || maximum.length === 0) {
		throw new Error("Unreal compatibility maximum must be a non-empty version string.");
	}
	return { minimum, maximum };
}

function isIgnoredPath(path) {
	const normalized = toPosix(path);
	const parts = normalized.split("/");
	return (
		parts.some((part) => ignoredDirectoryNames.has(part.toLowerCase())) ||
		ignoredFilePattern.test(parts.at(-1) ?? "")
	);
}

function relativePluginPath(pluginRoot, path) {
	const relativePath = toPosix(relative(pluginRoot, path));
	if (!relativePath || relativePath === "." || relativePath.startsWith("../")) {
		throw new Error(`Plugin source path escapes the plugin root: ${path}`);
	}
	return relativePath;
}

async function walkFiles(directory, prefix = "") {
	const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0
	);
	const files = [];
	for (const entry of entries) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (isIgnoredPath(relativePath)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkFiles(path, relativePath)));
		} else if (entry.isFile()) {
			files.push(relativePath);
		} else if (entry.isSymbolicLink()) {
			throw new Error(`Plugin source cannot contain symbolic links: ${relativePath}`);
		}
	}
	return files;
}

function gitPaths({ gitRoot, sourceCommit, pluginRoot }) {
	const relativeRoot = toPosix(relative(gitRoot, pluginRoot));
	if (!relativeRoot || relativeRoot.startsWith("../")) return [];
	const output = sourceCommit
		? run("git", ["ls-tree", "-r", "--name-only", "-z", sourceCommit, "--", relativeRoot], {
				cwd: gitRoot
			})
		: run("git", ["ls-files", "-z", "--", relativeRoot], { cwd: gitRoot });
	const prefix = `${relativeRoot}/`;
	return output
		.split("\0")
		.filter(Boolean)
		.filter((path) => path.startsWith(prefix))
		.map((path) => path.slice(prefix.length))
		.filter((path) => !isIgnoredPath(path))
		.sort();
}

async function sourcePaths({ pluginRoot, gitRoot, sourceCommit }) {
	const pluginRootExists = await stat(pluginRoot).catch(() => undefined);
	if (!pluginRootExists?.isDirectory())
		throw new Error(`Plugin source root does not exist: ${pluginRoot}`);
	const canUseGit =
		resolve(pluginRoot) === resolve(defaultPluginRoot) ||
		resolve(gitRoot) !== resolve(repositoryRoot);
	if (canUseGit) {
		const tracked = gitPaths({ gitRoot, sourceCommit, pluginRoot });
		if (tracked.length > 0) return tracked;
	}
	return walkFiles(pluginRoot);
}

async function readDescriptors({ pluginRoot, paths, requestedPlugins }) {
	const directories = new Set(paths.map((path) => path.split("/")[0]));
	const requested = requestedPlugins ? new Set(requestedPlugins) : undefined;
	const descriptors = [];
	for (const directory of [...directories].sort()) {
		if (requested && !requested.has(directory)) continue;
		const descriptorPath = join(pluginRoot, directory, `${directory}.uplugin`);
		const descriptorExists = await stat(descriptorPath).catch(() => undefined);
		if (!descriptorExists?.isFile()) {
			if (requested)
				throw new Error(
					`Requested plugin ${directory} has no ${directory}.uplugin descriptor.`
				);
			continue;
		}
		const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
		if (descriptor.Name !== undefined && descriptor.Name !== directory) {
			throw new Error(
				`Plugin descriptor ${directory}.uplugin declares mismatched Name ${descriptor.Name}.`
			);
		}
		const version =
			descriptor.VersionName ??
			(descriptor.Version === undefined ? undefined : String(descriptor.Version));
		if (!version)
			throw new Error(
				`Plugin descriptor ${directory}.uplugin must declare VersionName or Version.`
			);
		const dependencies = [
			...new Set(
				(descriptor.Plugins ?? []).map((dependency) => dependency?.Name).filter(Boolean)
			)
		].sort();
		descriptors.push({
			directory,
			id: descriptor.Name ?? directory,
			version,
			dependencies,
			descriptorPath: `${directory}/${directory}.uplugin`
		});
	}
	if (descriptors.length === 0)
		throw new Error(`No Unreal plugin descriptors found below ${pluginRoot}.`);
	const ids = new Set(descriptors.map((descriptor) => descriptor.id));
	for (const descriptor of descriptors) {
		const missing = descriptor.dependencies.filter((dependency) => !ids.has(dependency));
		if (missing.length > 0) {
			throw new Error(
				`${descriptor.id} declares missing plugin dependencies: ${missing.join(", ")}.`
			);
		}
	}
	return descriptors;
}

function sortArchivePaths(paths) {
	return [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function prepareArchiveTree({ pluginRoot, sourceFiles, licensePath, stageRoot }) {
	const archivePaths = [];
	for (const sourceFile of sourceFiles) {
		const relativePath = relativePluginPath(pluginRoot, join(pluginRoot, sourceFile));
		const destination = join(stageRoot, archivePrefix, relativePath);
		await mkdir(dirname(destination), { recursive: true });
		const source = join(pluginRoot, sourceFile);
		const details = await lstat(source);
		if (!details.isFile())
			throw new Error(`Plugin source must be a regular file: ${sourceFile}`);
		await copyFile(source, destination);
		archivePaths.push(`${archivePrefix}/${relativePath}`);
	}
	if (licensePath) {
		const details = await lstat(licensePath).catch(() => undefined);
		if (details?.isFile()) {
			const destination = join(stageRoot, "UEShed", "LICENSE");
			await mkdir(dirname(destination), { recursive: true });
			await copyFile(licensePath, destination);
			archivePaths.push("UEShed/LICENSE");
		}
	}
	return sortArchivePaths(archivePaths);
}

async function writeArchive({ stageRoot, archivePaths, output }) {
	const tarName = "plugins.tar";
	const tarPath = join(stageRoot, tarName);
	const listName = ".ue-shed-archive-files.txt";
	const listPath = join(stageRoot, listName);
	await writeFile(listPath, `${archivePaths.join("\n")}\n`, "utf8");
	run(
		"tar",
		[
			"--format=ustar",
			"--mtime=1970-01-01 00:00:00Z",
			"-c",
			"--file",
			tarName,
			"-C",
			stageRoot,
			"-T",
			listName
		],
		{ cwd: stageRoot }
	);
	const tarBytes = await readFile(tarPath);
	await writeFile(output, gzipSync(tarBytes, { level: 9, mtime: 0 }));
}

async function candidateProvenance(path, releaseVersion, outputDirectory) {
	if (!path) {
		return {
			version: releaseVersion,
			manifestPath: "local-candidate-manifest.json",
			sha256: `sha256:${"0".repeat(64)}`
		};
	}
	const resolvedPath = resolve(path);
	const raw = await readFile(resolvedPath, "utf8");
	const candidate = JSON.parse(raw);
	const version = candidate.candidateVersion ?? candidate.version;
	if (version && version !== releaseVersion) {
		throw new Error(
			`Candidate manifest version ${version} does not match plugin release ${releaseVersion}.`
		);
	}
	if (Array.isArray(candidate.packages)) {
		const mismatched = candidate.packages.filter((entry) => entry?.version !== releaseVersion);
		if (mismatched.length > 0) {
			throw new Error(
				`Candidate package manifest contains versions other than ${releaseVersion}.`
			);
		}
	}
	const relativeManifestPath = toPosix(relative(outputDirectory, resolvedPath));
	const siblingManifestPath = toPosix(relative(dirname(outputDirectory), resolvedPath));
	const manifestPath =
		relativeManifestPath && !relativeManifestPath.startsWith("../")
			? relativeManifestPath
			: siblingManifestPath && !siblingManifestPath.startsWith("../")
				? siblingManifestPath
				: basename(resolvedPath);
	return {
		version: version ?? releaseVersion,
		manifestPath,
		sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`
	};
}

async function ensureEmptyOutput(output) {
	await mkdir(output, { recursive: true });
	const entries = await readdir(output);
	if (entries.length > 0)
		throw new Error(`Plugin bundle output must be absent or empty: ${output}`);
}

/**
 * Build a deterministic, source-compatible Unreal plugin bundle and its release manifest.
 *
 * The source tree is read from Git when the default repository plugin root is used, so ignored
 * build output and untracked local files cannot accidentally enter a release artifact. A custom
 * pluginRoot is useful for fixtures and is walked with the same portability exclusions.
 */
export async function buildPluginBundle({
	output,
	releaseVersion,
	pluginRoot = defaultPluginRoot,
	gitRoot = repositoryRoot,
	sourceCommit,
	sourceRef = null,
	repository = canonicalRepository,
	candidateManifest,
	licensePath,
	unreal,
	requestedPlugins
}) {
	validateReleaseVersion(releaseVersion);
	validateCommit(sourceCommit);
	const outputDirectory = resolve(output);
	await ensureEmptyOutput(outputDirectory);
	const resolvedPluginRoot = resolve(pluginRoot);
	const resolvedGitRoot = resolve(gitRoot);
	const defaultSourceCommit =
		sourceCommit ??
		(resolvedPluginRoot === resolve(defaultPluginRoot)
			? run("git", ["rev-parse", "HEAD"], { cwd: resolvedGitRoot }).trim()
			: undefined);
	validateCommit(defaultSourceCommit);
	const provenanceCommit = defaultSourceCommit ?? "0".repeat(40);
	const provenanceRef = sourceRef ?? "local";
	const paths = await sourcePaths({
		pluginRoot: resolvedPluginRoot,
		gitRoot: resolvedGitRoot,
		sourceCommit: defaultSourceCommit
	});
	const descriptors = await readDescriptors({
		pluginRoot: resolvedPluginRoot,
		paths,
		requestedPlugins
	});
	const pluginIds = new Set(descriptors.map((descriptor) => descriptor.directory));
	const sourceFiles = paths.filter((path) => pluginIds.has(path.split("/")[0]));
	const resolvedLicensePath =
		licensePath === undefined
			? join(resolvedPluginRoot, "..", "..", "LICENSE")
			: licensePath === null
				? undefined
				: resolve(licensePath);
	const unrealRange = validateUnrealRange(unreal);
	const tempRoot = await mkdtemp(join(outputDirectory, ".plugin-bundle-"));
	try {
		const archiveName = `ue-shed-plugins-${releaseVersion}.tar.gz`;
		const archivePath = join(outputDirectory, archiveName);
		const stageRoot = join(tempRoot, "tree");
		await mkdir(stageRoot, { recursive: true });
		const archivePaths = await prepareArchiveTree({
			pluginRoot: resolvedPluginRoot,
			sourceFiles,
			licensePath: resolvedLicensePath,
			stageRoot
		});
		await writeArchive({ stageRoot, archivePaths, output: archivePath });
		const candidateManifestData = await candidateProvenance(
			candidateManifest,
			releaseVersion,
			outputDirectory
		);
		const archiveDetails = await stat(archivePath);
		const manifest = {
			schemaVersion: 1,
			releaseVersion,
			unreal: unrealRange,
			plugins: descriptors.map(
				({ id, version, directory, descriptorPath, dependencies }) => ({
					id,
					version,
					descriptorPath,
					directory,
					dependencies
				})
			),
			artifact: {
				id: `ue-shed-plugin-source-${releaseVersion}`,
				kind: "plugin-source",
				path: archiveName,
				bytes: archiveDetails.size,
				sha256: `sha256:${await sha256(archivePath)}`
			},
			provenance: {
				candidateManifest: candidateManifestData,
				source: {
					repository,
					commit: provenanceCommit,
					ref: provenanceRef
				}
			}
		};
		const manifestName = "plugins.manifest.json";
		const manifestPath = join(outputDirectory, manifestName);
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		return { manifest, archivePath, manifestPath };
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function parseArguments(args) {
	if (args[0] !== "bundle") {
		throw new Error(
			"Usage: node scripts/plugin-bundle.mjs bundle --version <semver> --output <empty-dir> [options]"
		);
	}
	const values = new Map();
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith("--") || value === undefined) {
			throw new Error(`Expected --key value arguments, received ${args.join(" ")}.`);
		}
		values.set(key.slice(2), value);
	}
	for (const required of ["version", "output"]) {
		if (!values.has(required)) throw new Error(`Missing required --${required} argument.`);
	}
	return values;
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const requestedPlugins = args.get("plugins")?.split(",").filter(Boolean);
	const result = await buildPluginBundle({
		output: args.get("output"),
		releaseVersion: args.get("version"),
		pluginRoot: args.get("source-root"),
		sourceCommit: args.get("commit"),
		sourceRef: args.get("ref") ?? null,
		candidateManifest: args.get("candidate-manifest"),
		repository: args.get("repository") ?? canonicalRepository,
		licensePath: args.get("license"),
		unreal: {
			minimum: args.get("ue-minimum") ?? "5.7",
			maximum: args.get("ue-maximum") ?? args.get("ue-minimum") ?? "5.7"
		},
		requestedPlugins
	});
	console.log(
		`Built ${result.manifest.plugins.length} Unreal plugin sources: ${relative(repositoryRoot, result.archivePath)}`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
