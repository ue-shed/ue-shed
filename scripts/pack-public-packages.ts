import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	cp,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export interface PublicPackage {
	readonly name: string;
	readonly directory: string;
}

export interface PackageManifest {
	readonly name: string;
	readonly version: string;
	readonly license?: string;
	readonly private?: boolean;
	readonly type?: string;
	readonly publishConfig?: { readonly access?: string };
	readonly repository?: { readonly url?: string };
	readonly exports?: Readonly<Record<string, unknown>>;
	readonly main?: string;
	readonly types?: string;
	readonly bin?: string | Readonly<Record<string, string>>;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly os?: readonly string[];
	readonly cpu?: readonly string[];
}

export interface PackedPackage {
	readonly name: string;
	readonly filename: string;
	readonly path: string;
	readonly manifest: PackageManifest;
	readonly sha256: string;
	readonly bytes: number;
}

interface RunOptions {
	readonly cwd?: string;
}

export const WASM_PACKAGE_NAME = "@ue-shed/uasset-inspection-wasm";
export const GAME_TEXT_PACKAGE_NAME = "@ue-shed/game-text";
export const MAP_HISTORY_PACKAGE_NAME = "@ue-shed/map-history";
/**
 * Exact public npm allowlist for candidate construction and protected publication.
 * Plan 025 shipped the parser slice; Plans 030 and 031 add the headless Map Review and Observatory
 * closures without making a UI package public. Plan 036 adds the bytes-only WASM inspection
 * surface. Game Text and World Log's Map History boundary add headless existing-host features
 * without publishing their Workbench presentation.
 */
export const PUBLIC_PACKAGES: readonly PublicPackage[] = [
	{ name: "@ue-shed/protocol", directory: "packages/protocol" },
	{ name: "@ue-shed/observability", directory: "packages/observability" },
	{ name: "@ue-shed/unreal-connection", directory: "packages/unreal-connection" },
	{ name: "@ue-shed/cameras", directory: "packages/cameras" },
	{ name: "@ue-shed/observatory", directory: "packages/observatory" },
	{ name: WASM_PACKAGE_NAME, directory: "packages/uasset-inspection-wasm" },
	{ name: "@ue-shed/uasset-win32-x64", directory: "packages/uasset-win32-x64" },
	{ name: "@ue-shed/unreal-assets", directory: "packages/unreal-assets" },
	{ name: MAP_HISTORY_PACKAGE_NAME, directory: "packages/map-history" },
	{ name: "@ue-shed/uasset", directory: "packages/uasset" },
	{ name: GAME_TEXT_PACKAGE_NAME, directory: "packages/game-text" }
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Legacy source/plugin candidates still have one release identity. npm packages are independently
// versioned by Changesets; the launcher version remains the candidate identity until the post-1.0
// hosted lane is redesigned around Changesets' release plan.
export const PUBLIC_VERSION = (
	JSON.parse(
		await readFile(join(repositoryRoot, "packages/uasset/package.json"), "utf8")
	) as PackageManifest
).version;
const localProtocolPattern = /(?:workspace|catalog|file|link|portal):/;
const canonicalRepository = "git+https://github.com/ue-shed/ue-shed.git";
const exactEffectVersion = "4.0.0-beta.98";
const exactUnrealRcVersion = "0.5.3";

function packedPath(path: string) {
	return `package/${path.replace(/^\.\//u, "")}`;
}

function executable(name: string) {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command: string, args: readonly string[], options: RunOptions = {}) {
	const isCommandShim = process.platform === "win32" && command.endsWith(".cmd");
	const result = spawnSync(
		isCommandShim ? (process.env.ComSpec ?? "cmd.exe") : command,
		isCommandShim ? ["/d", "/s", "/c", command, ...args] : args,
		{
			cwd: options.cwd ?? repositoryRoot,
			encoding: "utf8",
			shell: false
		}
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
		);
	}
	return result.stdout.trim();
}

async function ensureEmptyOutput(output: string) {
	if (existsSync(output) && (await readdir(output)).length > 0) {
		throw new Error(`Package output must be absent or empty: ${output}`);
	}
	await mkdir(output, { recursive: true });
}

async function assertPublicPackageSet() {
	const expected = new Set(PUBLIC_PACKAGES.map(({ name }) => name));
	const actual: string[] = [];
	for (const root of ["apps", "examples", "extensions", "packages"]) {
		const directory = join(repositoryRoot, root);
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifestPath = join(directory, entry.name, "package.json");
			if (!existsSync(manifestPath)) continue;
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
			if (manifest.private !== true) actual.push(manifest.name);
		}
	}
	const unexpected = actual.filter((name) => !expected.has(name));
	const missing = [...expected].filter((name) => !actual.includes(name));
	if (unexpected.length > 0 || missing.length > 0) {
		throw new Error(
			`Public package set differs from the release allowlist.` +
				`\nUnexpected: ${unexpected.join(", ") || "none"}` +
				`\nMissing: ${missing.join(", ") || "none"}`
		);
	}
}

async function digest(path: string) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

function readPackedFile(tarball: string, path: string) {
	return run("tar", ["-xOf", basename(tarball), path], { cwd: dirname(tarball) });
}

function listPackedFiles(tarball: string) {
	return run("tar", ["-tzf", basename(tarball)], { cwd: dirname(tarball) })
		.split(/\r?\n/u)
		.filter(Boolean);
}

async function packWorkspacePackage(workspacePackage: PublicPackage, outputDirectory: string) {
	const packageDirectory = join(repositoryRoot, workspacePackage.directory);
	const before = new Set(await readdir(outputDirectory));
	let packDirectory = packageDirectory;
	let stagedDirectory: string | undefined;
	if (workspacePackage.name === WASM_PACKAGE_NAME) {
		stagedDirectory = await mkdtemp(join(tmpdir(), "ue-shed-wasm-package-"));
		await Promise.all([
			copyFile(join(packageDirectory, "LICENSE"), join(stagedDirectory, "LICENSE")),
			copyFile(join(packageDirectory, "README.md"), join(stagedDirectory, "README.md")),
			copyFile(join(packageDirectory, "package.json"), join(stagedDirectory, "package.json")),
			cp(join(packageDirectory, "dist"), join(stagedDirectory, "dist"), {
				recursive: true,
				filter: (source) => basename(source) !== ".gitignore"
			})
		]);
		packDirectory = stagedDirectory;
	}
	try {
		const packCommand = stagedDirectory === undefined ? executable("pnpm") : executable("npm");
		const packArguments = ["pack", "--pack-destination", outputDirectory];
		if (stagedDirectory !== undefined) packArguments.push("--ignore-scripts");
		run(packCommand, packArguments, { cwd: packDirectory });
		const filename = (await readdir(outputDirectory)).find(
			(entry) => !before.has(entry) && entry.endsWith(".tgz")
		);
		if (!filename) throw new Error(`${workspacePackage.name} did not produce a tarball.`);
		return join(outputDirectory, filename);
	} finally {
		if (stagedDirectory !== undefined) {
			await rm(stagedDirectory, { recursive: true, force: true });
		}
	}
}

function collectExportTargets(
	exportsValue: unknown,
	failures: string[],
	prefix = "exports"
): string[] {
	if (typeof exportsValue === "string") return [exportsValue];
	if (Array.isArray(exportsValue)) {
		return exportsValue.flatMap((value, index) =>
			collectExportTargets(value, failures, `${prefix}[${index}]`)
		);
	}
	if (exportsValue === null || typeof exportsValue !== "object") {
		failures.push(`${prefix} must be a string or object`);
		return [];
	}
	const targets: string[] = [];
	for (const [key, value] of Object.entries(exportsValue)) {
		targets.push(...collectExportTargets(value, failures, `${prefix}.${key}`));
	}
	return targets;
}

export function validateWasmPackageManifest({
	manifest,
	files
}: {
	readonly manifest: PackageManifest;
	readonly files: readonly string[];
}) {
	const failures: string[] = [];
	if (manifest.type !== "module") failures.push("WASM package must use ES modules");
	if (manifest.publishConfig?.access !== "public") {
		failures.push("WASM package must declare publishConfig.access public");
	}
	if (manifest.exports === undefined) failures.push("WASM package must declare exports");
	const exportTargets = collectExportTargets(manifest.exports, failures);
	const exportDescription = JSON.stringify(manifest.exports ?? "");
	const hasBrowserTarget =
		/\b(?:browser|web)\b/iu.test(exportDescription) ||
		exportTargets.some((target) => /(?:^|[/._-])(?:browser|web)(?:[/._-]|$)/iu.test(target));
	const hasNodeTarget =
		/\b(?:node|server)\b/iu.test(exportDescription) ||
		exportTargets.some((target) => /(?:^|[/._-])(?:node|server)(?:[/._-]|$)/iu.test(target));
	if (!hasBrowserTarget) failures.push("WASM package must expose a browser runtime target");
	if (!hasNodeTarget) failures.push("WASM package must expose a Node runtime target");
	if (!files.some((path) => path.endsWith(".wasm"))) {
		failures.push("WASM package must contain a generated .wasm artifact");
	}
	if (!files.some((path) => path.endsWith(".d.ts"))) {
		failures.push("WASM package must contain generated TypeScript declarations");
	}
	if (!files.includes("package/dist/build-info.json")) {
		failures.push("WASM package must contain dist/build-info.json build evidence");
	}
	const sourceLeak = files.filter((path) =>
		/(?:^|\/)(?:Cargo\.(?:toml|lock)|\.cargo|target)(?:\/|$)/iu.test(path)
	);
	if (sourceLeak.length > 0) {
		failures.push(`WASM package contains source-build files: ${sourceLeak.join(", ")}`);
	}
	return failures;
}

export function validatePackedManifest({
	manifest,
	manifestRaw,
	expectedName,
	expectedVersion,
	files
}: {
	readonly manifest: PackageManifest;
	readonly manifestRaw: string;
	readonly expectedName: string;
	readonly expectedVersion: string;
	readonly files: readonly string[];
}) {
	const failures: string[] = [];
	if (manifest.name !== expectedName) failures.push(`expected package name ${expectedName}`);
	if (manifest.version !== expectedVersion) {
		failures.push(`expected exact version ${expectedVersion}, received ${manifest.version}`);
	}
	if (manifest.private === true) failures.push("package must not be private");
	if (manifest.license !== "MIT") failures.push("package license must be MIT");
	if (manifest.repository?.url !== canonicalRepository) {
		failures.push(`repository must be ${canonicalRepository}`);
	}
	for (const requiredFile of ["package/LICENSE", "package/README.md"]) {
		if (!files.includes(requiredFile)) failures.push(`archive is missing ${requiredFile}`);
	}
	if (localProtocolPattern.test(manifestRaw)) {
		failures.push("packed manifest contains a local workspace/catalog/file/link protocol");
	}
	for (const field of ["main", "types"] as const) {
		if (typeof manifest[field] === "string" && !files.includes(packedPath(manifest[field]))) {
			failures.push(`${field} points to missing packed file ${manifest[field]}`);
		}
	}
	for (const exportPath of collectExportTargets(manifest.exports, failures)) {
		if (!files.includes(packedPath(exportPath))) {
			failures.push(`exports points to missing packed file ${exportPath}`);
		}
	}
	if (expectedName === WASM_PACKAGE_NAME) {
		failures.push(...validateWasmPackageManifest({ manifest, files }));
	}
	if (expectedName === GAME_TEXT_PACKAGE_NAME) {
		for (const requiredFile of ["package/ADOPTING.md", "package/adoption.manifest.json"]) {
			if (!files.includes(requiredFile)) failures.push(`archive is missing ${requiredFile}`);
		}
	}
	const bins =
		typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : manifest.bin;
	for (const path of Object.values(bins ?? {})) {
		if (!files.includes(packedPath(path)))
			failures.push(`bin points to missing packed file ${path}`);
	}
	const forbidden = files.filter((path) => {
		const isPromisedProtocolFixture =
			expectedName === "@ue-shed/protocol" && path.startsWith("package/contracts/");
		return (
			/(?:^|\/)(?:node_modules|target|test-results|\.worktrees)(?:\/|$)|\.test\./u.test(
				path
			) ||
			(!isPromisedProtocolFixture && /(?:^|\/)fixtures(?:\/|$)/u.test(path))
		);
	});
	if (forbidden.length > 0)
		failures.push(`archive contains forbidden files: ${forbidden.join(", ")}`);
	return failures;
}

function requireExactDependency(
	manifest: PackageManifest | undefined,
	name: string,
	expected: string,
	failures: string[]
) {
	const actual = manifest?.dependencies?.[name];
	if (actual !== expected) {
		failures.push(`${manifest?.name ?? "package"} must pin ${name} ${expected}`);
	}
}

function requireExactPeerDependency(
	manifest: PackageManifest | undefined,
	name: string,
	expected: string,
	failures: string[]
) {
	const actual = manifest?.peerDependencies?.[name];
	if (actual !== expected) {
		failures.push(`${manifest?.name ?? "package"} must peer-pin ${name} ${expected}`);
	}
}

function requireExactInternalDependency(
	manifest: PackageManifest | undefined,
	targetName: string,
	byName: ReadonlyMap<string, PackageManifest>,
	failures: string[]
) {
	const target = byName.get(targetName);
	if (target === undefined) {
		failures.push(
			`${manifest?.name ?? "package"} references missing public package ${targetName}`
		);
		return;
	}
	requireExactDependency(manifest, targetName, target.version, failures);
}

function validateExactPackageGraph(manifests: readonly PackedPackage[]) {
	const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry.manifest]));
	const failures: string[] = [];
	const protocol = byName.get("@ue-shed/protocol");
	const observability = byName.get("@ue-shed/observability");
	const unrealConnection = byName.get("@ue-shed/unreal-connection");
	const cameras = byName.get("@ue-shed/cameras");
	const observatory = byName.get("@ue-shed/observatory");
	const wasm = byName.get(WASM_PACKAGE_NAME);
	const unrealAssets = byName.get("@ue-shed/unreal-assets");
	const launcher = byName.get("@ue-shed/uasset");
	const platform = byName.get("@ue-shed/uasset-win32-x64");
	const gameText = byName.get(GAME_TEXT_PACKAGE_NAME);
	const mapHistory = byName.get(MAP_HISTORY_PACKAGE_NAME);
	requireExactDependency(protocol, "effect", exactEffectVersion, failures);
	requireExactDependency(observability, "effect", exactEffectVersion, failures);
	requireExactDependency(observability, "@effect/opentelemetry", exactEffectVersion, failures);
	requireExactInternalDependency(unrealConnection, "@ue-shed/protocol", byName, failures);
	requireExactDependency(unrealConnection, "effect", exactEffectVersion, failures);
	requireExactDependency(unrealConnection, "unreal-rc", exactUnrealRcVersion, failures);
	requireExactInternalDependency(cameras, "@ue-shed/observability", byName, failures);
	requireExactInternalDependency(cameras, "@ue-shed/protocol", byName, failures);
	requireExactInternalDependency(cameras, "@ue-shed/unreal-connection", byName, failures);
	requireExactDependency(cameras, "effect", exactEffectVersion, failures);
	requireExactInternalDependency(observatory, "@ue-shed/observability", byName, failures);
	requireExactInternalDependency(observatory, "@ue-shed/unreal-connection", byName, failures);
	requireExactDependency(observatory, "effect", exactEffectVersion, failures);
	requireExactInternalDependency(unrealAssets, "@ue-shed/protocol", byName, failures);
	requireExactDependency(unrealAssets, "effect", exactEffectVersion, failures);
	requireExactInternalDependency(gameText, "@ue-shed/unreal-assets", byName, failures);
	requireExactPeerDependency(gameText, "effect", exactEffectVersion, failures);
	requireExactInternalDependency(mapHistory, "@ue-shed/protocol", byName, failures);
	requireExactInternalDependency(mapHistory, "@ue-shed/unreal-assets", byName, failures);
	requireExactDependency(mapHistory, "effect", exactEffectVersion, failures);
	requireExactDependency(mapHistory, "p4client-ts", "0.7.1", failures);
	for (const dependencyField of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies"
	] as const) {
		if (gameText?.[dependencyField]?.["@ue-shed/uasset"] !== undefined) {
			failures.push(
				`${GAME_TEXT_PACKAGE_NAME} must select its native reader through host configuration, not ${dependencyField}`
			);
		}
	}
	if (wasm?.license !== "MIT") {
		failures.push(`${WASM_PACKAGE_NAME} must retain MIT license metadata`);
	}
	const platformVersion =
		launcher?.optionalDependencies?.["@ue-shed/uasset-win32-x64"] ??
		launcher?.dependencies?.["@ue-shed/uasset-win32-x64"];
	if (platformVersion !== platform?.version) {
		failures.push(`@ue-shed/uasset must pin its Windows package ${platform?.version}`);
	}
	if (JSON.stringify(platform?.os) !== JSON.stringify(["win32"])) {
		failures.push("@ue-shed/uasset-win32-x64 must declare os [win32]");
	}
	if (JSON.stringify(platform?.cpu) !== JSON.stringify(["x64"])) {
		failures.push("@ue-shed/uasset-win32-x64 must declare cpu [x64]");
	}
	if (cameras?.exports?.["./review-contracts"] === undefined) {
		failures.push("@ue-shed/cameras must export ./review-contracts");
	}
	if (observability?.exports?.["./health"] === undefined) {
		failures.push("@ue-shed/observability must export ./health");
	}
	if (observatory?.exports?.["./presentation"] === undefined) {
		failures.push("@ue-shed/observatory must export ./presentation");
	}
	if (gameText?.exports?.["./browser"] === undefined) {
		failures.push(`${GAME_TEXT_PACKAGE_NAME} must export ./browser`);
	}
	for (const entrypoint of ["./contract", "./playback"]) {
		if (mapHistory?.exports?.[entrypoint] === undefined) {
			failures.push(`${MAP_HISTORY_PACKAGE_NAME} must export ${entrypoint}`);
		}
	}
	if (failures.length > 0)
		throw new Error(`Invalid public package graph:\n- ${failures.join("\n- ")}`);
}

export async function packPublicPackages({
	output,
	build = true
}: {
	readonly output: string;
	readonly build?: boolean;
}): Promise<PackedPackage[]> {
	const outputDirectory = resolve(output);
	await ensureEmptyOutput(outputDirectory);
	await assertPublicPackageSet();
	if (build) {
		run("cargo", ["build", "--locked", "--release", "-p", "uasset-io"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/protocol", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/observability", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/unreal-connection", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/cameras", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/observatory", "build"]);
		run(executable("pnpm"), ["--filter", WASM_PACKAGE_NAME, "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/unreal-assets", "build"]);
		run(executable("pnpm"), ["--filter", MAP_HISTORY_PACKAGE_NAME, "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/uasset-win32-x64", "assemble"]);
		run(executable("pnpm"), ["--filter", GAME_TEXT_PACKAGE_NAME, "build"]);
	}
	const packed: PackedPackage[] = [];
	for (const workspacePackage of PUBLIC_PACKAGES) {
		const workspaceManifest = JSON.parse(
			await readFile(join(repositoryRoot, workspacePackage.directory, "package.json"), "utf8")
		) as PackageManifest;
		const path = await packWorkspacePackage(workspacePackage, outputDirectory);
		const filename = basename(path);
		const manifestRaw = readPackedFile(path, "package/package.json");
		const manifest = JSON.parse(manifestRaw) as PackageManifest;
		const files = listPackedFiles(path);
		const failures = validatePackedManifest({
			manifest,
			manifestRaw,
			expectedName: workspacePackage.name,
			expectedVersion: workspaceManifest.version,
			files
		});
		if (failures.length > 0) {
			throw new Error(
				`${workspacePackage.name} pack validation failed:\n- ${failures.join("\n- ")}`
			);
		}
		packed.push({
			name: workspacePackage.name,
			filename,
			path,
			manifest,
			sha256: await digest(path),
			bytes: (await stat(path)).size
		});
	}
	validateExactPackageGraph(packed);
	await writeFile(
		join(outputDirectory, "SHA256SUMS"),
		`${packed.map((entry) => `${entry.sha256}  ${entry.filename}`).join("\n")}\n`,
		"utf8"
	);
	await writeFile(
		join(outputDirectory, "packages-manifest.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				version: PUBLIC_VERSION,
				packages: packed.map(({ name, filename, sha256, bytes, manifest }) => ({
					name,
					version: manifest.version,
					license: manifest.license,
					filename,
					sha256,
					bytes
				}))
			},
			null,
			2
		)}\n`,
		"utf8"
	);
	return packed;
}

function parseOutput(args: readonly string[]) {
	const index = args.indexOf("--output");
	const output = index === -1 ? undefined : args[index + 1];
	if (!output)
		throw new Error("Usage: node scripts/pack-public-packages.ts --output <empty-dir>");
	return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const output = parseOutput(process.argv.slice(2));
	const packed = await packPublicPackages({ output });
	console.log(
		`Packed ${packed.length} public packages at ${relative(repositoryRoot, resolve(output))}.`
	);
}
