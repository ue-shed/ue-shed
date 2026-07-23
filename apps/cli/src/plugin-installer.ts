import { createHash, randomUUID } from "node:crypto";
import {
	access,
	cp,
	mkdtemp,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	lstat,
	writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
	PluginBundleManifest,
	PluginBundleManifestValidationError,
	validatePluginBundleManifest,
	verifyPluginBundleArtifactChecksum
} from "@ue-shed/plugin-bundles";
import { Effect, Schema } from "effect";

/**
 * This is the intentionally narrow filesystem/archive boundary consumed by the CLI. The manifest
 * package owns the canonical schema; the installer owns only project mutation and file ownership.
 */
export type PluginManifestEntry = PluginBundleManifest["plugins"][number];
export type PluginReleaseManifest = PluginBundleManifest;

export class PluginInstallerError extends Schema.TaggedErrorClass<PluginInstallerError>()(
	"PluginInstallerError",
	{ message: Schema.String }
) {}

export interface PluginVerificationReport {
	readonly artifact: {
		readonly bytes: number;
		readonly path: string;
		readonly sha256: string;
		readonly status: "verified";
	};
	readonly manifest: {
		readonly plugins: readonly string[];
		readonly releaseVersion: string;
		readonly status: "valid";
	};
}

export interface PluginListReport {
	readonly plugins: readonly PluginManifestEntry[];
	readonly releaseVersion: string;
	readonly schemaVersion: number;
	readonly unreal: PluginReleaseManifest["unreal"];
}

export interface PluginInstallOptions {
	readonly artifactPath?: string;
	readonly manifestPath: string;
	readonly projectPath: string;
}

export interface PluginInstallReport {
	readonly artifactSha256: string;
	readonly manifestPath: string;
	readonly pluginRoot: string;
	readonly plugins: readonly string[];
	readonly projectFile: string;
	readonly releaseVersion: string;
	readonly status: "installed" | "unchanged" | "updated";
}

interface OwnershipRecord {
	readonly artifactSha256: string;
	readonly files: Readonly<Record<string, string>>;
	readonly plugins: readonly string[];
	readonly releaseVersion: string;
	readonly schemaVersion: 1;
}

const ownershipFile = ".ue-shed-plugin-install.json";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const generatedPluginDirectories = new Set(["binaries", "intermediate"]);

function fail(message: string): never {
	throw new Error(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeneratedPluginPath(
	relativePath: string,
	ownedPluginDirectories: ReadonlySet<string>
): boolean {
	const [pluginDirectory, pluginChild] = relativePath.split("/");
	return (
		pluginDirectory !== undefined &&
		ownedPluginDirectories.has(pluginDirectory) &&
		pluginChild !== undefined &&
		generatedPluginDirectories.has(pluginChild.toLowerCase())
	);
}

function parseManifest(value: unknown): PluginReleaseManifest {
	try {
		return Effect.runSync(validatePluginBundleManifest(value));
	} catch (cause) {
		if (cause instanceof PluginBundleManifestValidationError) {
			fail(`${cause.message} Recovery: ${cause.recovery}`);
		}
		fail(`Plugin manifest is invalid: ${String(cause)}`);
	}
}

async function readManifest(path: string): Promise<PluginReleaseManifest> {
	const resolved = resolve(path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(resolved, "utf8")) as unknown;
	} catch (cause) {
		fail(`Could not read plugin manifest ${resolved}: ${String(cause)}`);
	}
	return parseManifest(parsed);
}

function runTar(args: readonly string[], cwd?: string): string {
	const result = spawnSync("tar", args, {
		cwd,
		encoding: "utf8",
		shell: false,
		windowsHide: true
	});
	if (result.error) fail(`Unable to run tar for plugin artifact: ${String(result.error)}`);
	if (result.status !== 0)
		fail(
			`Plugin artifact is not a readable tar archive: ${result.stderr.trim() || "tar failed"}`
		);
	return result.stdout;
}

function safeArchiveEntry(entry: string): string {
	const normalized = entry.replaceAll("\\", "/").replace(/\/+$/u, "");
	if (!normalized || normalized === ".") return normalized;
	if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized))
		fail(`Plugin artifact contains an absolute path: ${entry}`);
	if (normalized.split("/").includes(".."))
		fail(`Plugin artifact contains a parent path: ${entry}`);
	return normalized;
}

function validateArchiveEntries(
	archivePath: string,
	plugins: readonly PluginManifestEntry[]
): void {
	const resolvedArchive = resolve(archivePath);
	const entries = runTar(["-tzf", basename(resolvedArchive)], dirname(resolvedArchive))
		.split(/\r?\n/u)
		.map(safeArchiveEntry)
		.filter(Boolean);
	if (entries.length === 0) fail("Plugin artifact archive is empty.");
	const expectedRoot = "UEShed/Plugins/";
	for (const entry of entries) {
		if (
			entry !== "UEShed" &&
			entry !== "UEShed/Plugins" &&
			entry !== "UEShed/LICENSE" &&
			!entry.startsWith(expectedRoot)
		)
			fail(`Plugin artifact entry is outside UEShed/Plugins: ${entry}`);
	}
	for (const plugin of plugins) {
		const prefix = `${expectedRoot}${plugin.directory}/`;
		if (!entries.some((entry) => entry.startsWith(prefix)))
			fail(`Plugin artifact does not contain declared plugin ${plugin.id}.`);
	}
}

async function digestFile(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function fileDigests(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const walk = async (directory: string): Promise<void> => {
		const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name)
		);
		for (const entry of entries) {
			const path = join(directory, entry.name);
			const relativePath = relative(root, path).replaceAll(sep, "/");
			if (entry.isSymbolicLink())
				fail(`Plugin installation contains an unsupported symlink: ${relativePath}`);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) result[relativePath] = await digestFile(path);
			else
				fail(
					`Plugin installation contains an unsupported filesystem entry: ${relativePath}`
				);
		}
	};
	await walk(root);
	return result;
}

async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

async function readJsonRecord(path: string): Promise<Readonly<Record<string, unknown>>> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(value)) fail(`Expected JSON object in ${path}.`);
		return value;
	} catch (cause) {
		fail(`Could not read JSON file ${path}: ${String(cause)}`);
	}
}

function parseOwnership(value: Readonly<Record<string, unknown>>, path: string): OwnershipRecord {
	if (value.schemaVersion !== 1) fail(`Unsupported plugin ownership record in ${path}.`);
	const artifactSha256 = value.artifactSha256;
	const releaseVersion = value.releaseVersion;
	const plugins = value.plugins;
	const files = value.files;
	if (
		typeof artifactSha256 !== "string" ||
		!sha256Pattern.test(artifactSha256) ||
		typeof releaseVersion !== "string" ||
		!Array.isArray(plugins) ||
		plugins.some((plugin) => typeof plugin !== "string") ||
		!isRecord(files) ||
		Object.values(files).some(
			(digest) => typeof digest !== "string" || !sha256Pattern.test(digest)
		)
	)
		fail(`Malformed plugin ownership record in ${path}.`);
	return {
		artifactSha256,
		files: files as Readonly<Record<string, string>>,
		plugins: plugins as readonly string[],
		releaseVersion,
		schemaVersion: 1
	};
}

async function assertOwnedFilesUnmodified(
	destination: string,
	ownership: OwnershipRecord
): Promise<void> {
	for (const [relativePath, expectedDigest] of Object.entries(ownership.files)) {
		const path = join(destination, ...relativePath.split("/"));
		try {
			const details = await lstat(path);
			if (!details.isFile())
				fail(`Installer-owned path is no longer a regular file: ${relativePath}`);
		} catch (cause) {
			if (cause instanceof Error && cause.message.startsWith("Installer-owned path"))
				throw cause;
			fail(`Installer-owned file is missing or inaccessible: ${relativePath}`);
		}
		if ((await digestFile(path)) !== expectedDigest)
			fail(
				`Installer-owned file was modified: ${relativePath}. Restore it or remove the project plugin installation.`
			);
	}
	const actualFiles = await fileDigests(destination);
	delete actualFiles[ownershipFile];
	const ownedPluginDirectories = new Set(
		Object.keys(ownership.files)
			.map((relativePath) => relativePath.split("/")[0])
			.filter((directory): directory is string => directory !== undefined)
	);
	const unownedFiles = Object.keys(actualFiles).filter(
		(relativePath) =>
			ownership.files[relativePath] === undefined &&
			!isGeneratedPluginPath(relativePath, ownedPluginDirectories)
	);
	if (unownedFiles.length > 0)
		fail(
			`Plugin installation contains files not recorded by the installer: ${unownedFiles.join(", ")}. Move them outside Plugins/UEShed before upgrading.`
		);
}

async function projectFileFor(
	input: string
): Promise<{ readonly projectFile: string; readonly root: string }> {
	const resolved = resolve(input);
	let details;
	try {
		details = await stat(resolved);
	} catch (cause) {
		fail(`Project path does not exist: ${resolved} (${String(cause)})`);
	}
	if (details.isFile()) {
		if (extname(resolved).toLowerCase() !== ".uproject")
			fail(`Project file must have a .uproject extension: ${resolved}`);
		return { projectFile: resolved, root: dirname(resolved) };
	}
	if (!details.isDirectory())
		fail(`Project path is neither a directory nor a .uproject file: ${resolved}`);
	const projects = (await readdir(resolved, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".uproject")
		.map((entry) => join(resolved, entry.name));
	if (projects.length !== 1)
		fail(`Project directory must contain exactly one .uproject file: ${resolved}`);
	return { projectFile: projects[0]!, root: resolved };
}

async function updateProjectFile(
	projectFile: string,
	pluginNames: readonly string[],
	previouslyOwnedPluginNames: readonly string[]
): Promise<{ readonly original: string; readonly updated: string }> {
	const original = await readFile(projectFile, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(original) as unknown;
	} catch (cause) {
		fail(`Project file is not valid JSON: ${projectFile} (${String(cause)})`);
	}
	if (!isRecord(parsed)) fail(`Project file must contain a JSON object: ${projectFile}`);
	const existing = parsed.Plugins;
	if (existing !== undefined && !Array.isArray(existing))
		fail(`Project Plugins field must be an array: ${projectFile}`);
	const requestedPlugins = new Set(pluginNames);
	const previouslyOwnedPlugins = new Set(previouslyOwnedPluginNames);
	const plugins = (
		Array.isArray(existing)
			? existing.map((item, index) => {
					if (!isRecord(item))
						fail(`Project Plugins entry ${index} must be an object: ${projectFile}`);
					return { ...item };
				})
			: []
	).filter(
		(item) =>
			typeof item.Name !== "string" ||
			!previouslyOwnedPlugins.has(item.Name) ||
			requestedPlugins.has(item.Name)
	);
	for (const name of pluginNames) {
		const entry = plugins.find((item) => item.Name === name);
		if (entry) entry.Enabled = true;
		else plugins.push({ Name: name, Enabled: true });
	}
	const updatedObject = { ...parsed, Plugins: plugins };
	return { original, updated: `${JSON.stringify(updatedObject, null, "\t")}\n` };
}

async function writeAtomic(path: string, content: string): Promise<void> {
	const temporary = `${path}.ue-shed-tmp-${randomUUID()}`;
	try {
		await writeFile(temporary, content, "utf8");
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function verifyArtifact(
	manifest: PluginReleaseManifest,
	artifactPath: string
): Promise<PluginVerificationReport> {
	const artifact = resolve(artifactPath);
	try {
		await access(artifact);
	} catch (cause) {
		fail(`Plugin artifact does not exist: ${artifact} (${String(cause)})`);
	}
	const details = await stat(artifact);
	if (!details.isFile()) fail(`Plugin artifact is not a regular file: ${artifact}`);
	const digest = await digestFile(artifact);
	if (details.size !== manifest.artifact.bytes)
		fail(
			`Plugin artifact size mismatch: expected ${manifest.artifact.bytes}, received ${details.size}.`
		);
	try {
		Effect.runSync(verifyPluginBundleArtifactChecksum(manifest, digest));
	} catch (cause) {
		if (cause instanceof PluginBundleManifestValidationError)
			fail(`${cause.message} Recovery: ${cause.recovery}`);
		fail(`Plugin artifact checksum validation failed: ${String(cause)}`);
	}
	validateArchiveEntries(artifact, manifest.plugins);
	return {
		artifact: { bytes: details.size, path: artifact, sha256: digest, status: "verified" },
		manifest: {
			plugins: manifest.plugins.map((plugin) => plugin.id),
			releaseVersion: manifest.releaseVersion,
			status: "valid"
		}
	};
}

function artifactPathFor(
	manifest: PluginReleaseManifest,
	manifestPath: string,
	artifactPath?: string
): string {
	if (artifactPath) return artifactPath;
	if (manifest.artifact.path) return join(dirname(resolve(manifestPath)), manifest.artifact.path);
	fail("A plugin artifact path is required because the manifest does not declare artifact.path.");
}

async function install(options: PluginInstallOptions): Promise<PluginInstallReport> {
	const manifestPath = resolve(options.manifestPath);
	const manifest = await readManifest(manifestPath);
	const artifactPath = artifactPathFor(manifest, manifestPath, options.artifactPath);
	const verification = await verifyArtifact(manifest, artifactPath);
	const project = await projectFileFor(options.projectPath);
	const destination = join(project.root, "Plugins", "UEShed");
	await ensureDirectory(dirname(destination));

	let existingOwnership: OwnershipRecord | undefined;
	let destinationExists = false;
	try {
		const destinationDetails = await lstat(destination);
		destinationExists = true;
		if (!destinationDetails.isDirectory())
			fail(`Plugin destination is not a directory: ${destination}`);
		try {
			existingOwnership = parseOwnership(
				await readJsonRecord(join(destination, ownershipFile)),
				join(destination, ownershipFile)
			);
		} catch {
			const entries = await readdir(destination);
			if (entries.length > 0)
				fail(
					`Refusing to install over an existing non-UE Shed plugin directory: ${destination}`
				);
		}
	} catch (cause) {
		if (cause instanceof Error && cause.message.startsWith("Refusing to install")) throw cause;
		if (cause instanceof Error && cause.message.startsWith("Plugin destination")) throw cause;
		if (cause instanceof Error && cause.message.startsWith("Malformed plugin")) throw cause;
		destinationExists = false;
	}
	if (existingOwnership) await assertOwnedFilesUnmodified(destination, existingOwnership);

	const stageRoot = await mkdtemp(join(dirname(destination), ".ue-shed-plugin-install-"));
	const stageDestination = join(stageRoot, "UEShed");
	let backupPath: string | undefined;
	let projectChanged = false;
	let projectOriginal: string | undefined;
	try {
		await ensureDirectory(stageDestination);
		if (destinationExists)
			await cp(destination, stageDestination, { recursive: true, force: true });
		const extractionRoot = join(stageRoot, "artifact");
		await ensureDirectory(extractionRoot);
		const resolvedArtifact = resolve(artifactPath);
		const stagedArtifact = join(extractionRoot, ".ue-shed-artifact.tar.gz");
		await cp(resolvedArtifact, stagedArtifact, { force: true });
		try {
			runTar(["-xzf", basename(stagedArtifact)], extractionRoot);
		} finally {
			await rm(stagedArtifact, { force: true });
		}
		const sourceRoot = join(extractionRoot, "UEShed", "Plugins");
		const sourceDetails = await stat(sourceRoot).catch(() => undefined);
		if (!sourceDetails?.isDirectory())
			fail("Plugin artifact is missing UEShed/Plugins archive root.");
		await fileDigests(sourceRoot);
		for (const plugin of manifest.plugins) {
			const source = join(sourceRoot, plugin.directory);
			const destinationPlugin = join(stageDestination, plugin.directory);
			const details = await lstat(source).catch(() => undefined);
			if (!details?.isDirectory()) fail(`Plugin artifact is missing ${plugin.id}/.`);
			const descriptor = join(sourceRoot, plugin.descriptorPath);
			const descriptorDetails = await lstat(descriptor).catch(() => undefined);
			if (!descriptorDetails?.isFile())
				fail(`Plugin artifact is missing descriptor ${plugin.descriptorPath}.`);
			await rm(destinationPlugin, { force: true, recursive: true });
			await cp(source, destinationPlugin, { recursive: true, force: true });
		}
		if (existingOwnership) {
			const nextDirectories = new Set(manifest.plugins.map((plugin) => plugin.directory));
			const removedDirectories = new Set(
				Object.keys(existingOwnership.files)
					.map((relativePath) => relativePath.split("/")[0])
					.filter(
						(directory): directory is string =>
							directory !== undefined && !nextDirectories.has(directory)
					)
			);
			for (const directory of removedDirectories)
				await rm(join(stageDestination, directory), { force: true, recursive: true });
		}
		const files = await fileDigests(stageDestination);
		delete files[ownershipFile];
		for (const relativePath of Object.keys(files)) {
			const topLevel = relativePath.split("/")[0];
			if (!manifest.plugins.some((plugin) => plugin.directory === topLevel))
				delete files[relativePath];
		}
		if (existingOwnership) {
			const currentFiles = new Set(Object.keys(files));
			for (const relativePath of Object.keys(existingOwnership.files)) {
				if (!currentFiles.has(relativePath))
					await rm(join(stageDestination, ...relativePath.split("/")), { force: true });
			}
		}
		const finalFiles = await fileDigests(stageDestination);
		delete finalFiles[ownershipFile];
		for (const relativePath of Object.keys(finalFiles)) {
			const topLevel = relativePath.split("/")[0];
			if (!manifest.plugins.some((plugin) => plugin.directory === topLevel))
				delete finalFiles[relativePath];
		}
		const ownership: OwnershipRecord = {
			artifactSha256: verification.artifact.sha256,
			files: finalFiles,
			plugins: manifest.plugins.map((plugin) => plugin.id),
			releaseVersion: manifest.releaseVersion,
			schemaVersion: 1
		};
		await writeFile(
			join(stageDestination, ownershipFile),
			`${JSON.stringify(ownership, null, "\t")}\n`,
			"utf8"
		);
		const projectUpdate = await updateProjectFile(
			project.projectFile,
			ownership.plugins,
			existingOwnership?.plugins ?? []
		);
		projectOriginal = projectUpdate.original;
		const priorStatus = existingOwnership
			? existingOwnership.artifactSha256 === verification.artifact.sha256 &&
				JSON.stringify(existingOwnership.plugins) === JSON.stringify(ownership.plugins) &&
				JSON.stringify(existingOwnership.files) === JSON.stringify(ownership.files)
				? "unchanged"
				: "updated"
			: "installed";
		await writeAtomic(project.projectFile, projectUpdate.updated);
		projectChanged = true;
		if (destinationExists) {
			backupPath = `${destination}.backup-${randomUUID()}`;
			await rename(destination, backupPath);
		}
		await rename(stageDestination, destination);
		if (backupPath) await rm(backupPath, { force: true, recursive: true });
		return {
			artifactSha256: verification.artifact.sha256,
			manifestPath,
			pluginRoot: destination,
			plugins: ownership.plugins,
			projectFile: project.projectFile,
			releaseVersion: manifest.releaseVersion,
			status: priorStatus
		};
	} catch (cause) {
		if (backupPath) {
			await rm(destination, { force: true, recursive: true }).catch(() => undefined);
			await rename(backupPath, destination).catch(() => undefined);
		}
		if (projectChanged && projectOriginal !== undefined)
			await writeAtomic(project.projectFile, projectOriginal).catch(() => undefined);
		throw cause;
	} finally {
		await rm(stageRoot, { force: true, recursive: true });
	}
}

function fromPromise<A>(thunk: () => Promise<A>): Effect.Effect<A, PluginInstallerError> {
	return Effect.tryPromise({
		catch: (cause) =>
			new PluginInstallerError({
				message: cause instanceof Error ? cause.message : String(cause)
			}),
		try: thunk
	});
}

export function readPluginManifest(
	path: string
): Effect.Effect<PluginReleaseManifest, PluginInstallerError> {
	return fromPromise(() => readManifest(path));
}

export function listPluginManifest(
	path: string
): Effect.Effect<PluginListReport, PluginInstallerError> {
	return readPluginManifest(path).pipe(
		Effect.map((manifest) => ({
			plugins: manifest.plugins,
			releaseVersion: manifest.releaseVersion,
			schemaVersion: manifest.schemaVersion,
			unreal: manifest.unreal
		}))
	);
}

export function verifyPluginManifest(options: {
	readonly artifactPath?: string;
	readonly manifestPath: string;
}): Effect.Effect<PluginVerificationReport, PluginInstallerError> {
	return readPluginManifest(options.manifestPath).pipe(
		Effect.flatMap((manifest) =>
			fromPromise(() =>
				verifyArtifact(
					manifest,
					artifactPathFor(manifest, options.manifestPath, options.artifactPath)
				)
			)
		)
	);
}

export function installPluginBundle(
	options: PluginInstallOptions
): Effect.Effect<PluginInstallReport, PluginInstallerError> {
	return fromPromise(() => install(options));
}
