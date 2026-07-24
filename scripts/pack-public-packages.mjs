import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PUBLIC_VERSION = "0.1.0-rc.3";
/**
 * Exact public npm allowlist for candidate construction and protected publication.
 * Plan 025 shipped the parser slice; Plans 030 and 031 add the headless Map Review and Observatory
 * closures without making a UI package public.
 */
export const PUBLIC_PACKAGES = [
	{ name: "@ue-shed/protocol", directory: "packages/protocol" },
	{ name: "@ue-shed/observability", directory: "packages/observability" },
	{ name: "@ue-shed/unreal-connection", directory: "packages/unreal-connection" },
	{ name: "@ue-shed/cameras", directory: "packages/cameras" },
	{ name: "@ue-shed/observatory", directory: "packages/observatory" },
	{ name: "@ue-shed/uasset-win32-x64", directory: "packages/uasset-win32-x64" },
	{ name: "@ue-shed/unreal-assets", directory: "packages/unreal-assets" },
	{ name: "@ue-shed/uasset", directory: "packages/uasset" }
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localProtocolPattern = /(?:workspace|catalog|file|link|portal):/;
const canonicalRepository = "git+https://github.com/ue-shed/ue-shed.git";
const exactEffectVersion = "4.0.0-beta.98";
const exactUnrealRcVersion = "0.5.3";

function packedPath(path) {
	return `package/${path.replace(/^\.\//u, "")}`;
}

function executable(name) {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, options = {}) {
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

async function ensureEmptyOutput(output) {
	if (existsSync(output) && (await readdir(output)).length > 0) {
		throw new Error(`Package output must be absent or empty: ${output}`);
	}
	await mkdir(output, { recursive: true });
}

async function assertPublicPackageSet() {
	const expected = new Set(PUBLIC_PACKAGES.map(({ name }) => name));
	const actual = [];
	for (const root of ["apps", "examples", "extensions", "packages"]) {
		const directory = join(repositoryRoot, root);
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifestPath = join(directory, entry.name, "package.json");
			if (!existsSync(manifestPath)) continue;
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
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

async function digest(path) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

function readPackedFile(tarball, path) {
	return run("tar", ["-xOf", basename(tarball), path], { cwd: dirname(tarball) });
}

function listPackedFiles(tarball) {
	return run("tar", ["-tzf", basename(tarball)], { cwd: dirname(tarball) })
		.split(/\r?\n/u)
		.filter(Boolean);
}

function collectExportTargets(exportsValue, failures, prefix = "exports") {
	if (typeof exportsValue === "string") return [exportsValue];
	if (exportsValue === null || typeof exportsValue !== "object") {
		failures.push(`${prefix} must be a string or object`);
		return [];
	}
	const targets = [];
	for (const [key, value] of Object.entries(exportsValue)) {
		if (typeof value === "string") targets.push(value);
		else if (value && typeof value === "object") {
			for (const [condition, target] of Object.entries(value)) {
				if (typeof target === "string") targets.push(target);
				else
					failures.push(
						`${prefix}.${key}.${condition} must resolve to a packed file path`
					);
			}
		} else {
			failures.push(`${prefix}.${key} must resolve to a packed file path`);
		}
	}
	return targets;
}

export function validatePackedManifest({ manifest, manifestRaw, expectedName, files }) {
	const failures = [];
	if (manifest.name !== expectedName) failures.push(`expected package name ${expectedName}`);
	if (manifest.version !== PUBLIC_VERSION) {
		failures.push(`expected exact version ${PUBLIC_VERSION}, received ${manifest.version}`);
	}
	if (manifest.private === true) failures.push("package must not be private");
	if (manifest.license !== "MIT") failures.push("package license must be MIT");
	if (manifest.repository?.url !== canonicalRepository) {
		failures.push(`repository must be ${canonicalRepository}`);
	}
	if (localProtocolPattern.test(manifestRaw)) {
		failures.push("packed manifest contains a local workspace/catalog/file/link protocol");
	}
	for (const field of ["main", "types"]) {
		if (typeof manifest[field] === "string" && !files.includes(packedPath(manifest[field]))) {
			failures.push(`${field} points to missing packed file ${manifest[field]}`);
		}
	}
	for (const exportPath of collectExportTargets(manifest.exports, failures)) {
		if (!files.includes(packedPath(exportPath))) {
			failures.push(`exports points to missing packed file ${exportPath}`);
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

function requireExactDependency(manifest, name, expected, failures) {
	const actual = manifest?.dependencies?.[name];
	if (actual !== expected) {
		failures.push(`${manifest?.name ?? "package"} must pin ${name} ${expected}`);
	}
}

function validateExactPackageGraph(manifests) {
	const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry.manifest]));
	const failures = [];
	const protocol = byName.get("@ue-shed/protocol");
	const observability = byName.get("@ue-shed/observability");
	const unrealConnection = byName.get("@ue-shed/unreal-connection");
	const cameras = byName.get("@ue-shed/cameras");
	const observatory = byName.get("@ue-shed/observatory");
	const unrealAssets = byName.get("@ue-shed/unreal-assets");
	const launcher = byName.get("@ue-shed/uasset");
	const platform = byName.get("@ue-shed/uasset-win32-x64");
	requireExactDependency(protocol, "effect", exactEffectVersion, failures);
	requireExactDependency(observability, "effect", exactEffectVersion, failures);
	requireExactDependency(observability, "@effect/opentelemetry", exactEffectVersion, failures);
	requireExactDependency(unrealConnection, "@ue-shed/protocol", PUBLIC_VERSION, failures);
	requireExactDependency(unrealConnection, "effect", exactEffectVersion, failures);
	requireExactDependency(unrealConnection, "unreal-rc", exactUnrealRcVersion, failures);
	requireExactDependency(cameras, "@ue-shed/protocol", PUBLIC_VERSION, failures);
	requireExactDependency(cameras, "@ue-shed/unreal-connection", PUBLIC_VERSION, failures);
	requireExactDependency(cameras, "effect", exactEffectVersion, failures);
	requireExactDependency(observatory, "@ue-shed/observability", PUBLIC_VERSION, failures);
	requireExactDependency(observatory, "@ue-shed/unreal-connection", PUBLIC_VERSION, failures);
	requireExactDependency(observatory, "effect", exactEffectVersion, failures);
	requireExactDependency(unrealAssets, "@ue-shed/protocol", PUBLIC_VERSION, failures);
	requireExactDependency(unrealAssets, "effect", exactEffectVersion, failures);
	const platformVersion =
		launcher?.optionalDependencies?.["@ue-shed/uasset-win32-x64"] ??
		launcher?.dependencies?.["@ue-shed/uasset-win32-x64"];
	if (platformVersion !== PUBLIC_VERSION) {
		failures.push(`@ue-shed/uasset must pin its Windows package ${PUBLIC_VERSION}`);
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
	if (failures.length > 0)
		throw new Error(`Invalid public package graph:\n- ${failures.join("\n- ")}`);
}

export async function packPublicPackages({ output, build = true }) {
	const outputDirectory = resolve(output);
	await ensureEmptyOutput(outputDirectory);
	await assertPublicPackageSet();
	if (build) {
		run("cargo", ["build", "--locked", "--release", "-p", "uasset-parser"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/protocol", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/observability", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/unreal-connection", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/cameras", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/observatory", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/unreal-assets", "build"]);
		run(executable("pnpm"), ["--filter", "@ue-shed/uasset-win32-x64", "assemble"]);
	}
	const packed = [];
	for (const workspacePackage of PUBLIC_PACKAGES) {
		const packageDirectory = join(repositoryRoot, workspacePackage.directory);
		const before = new Set(await readdir(outputDirectory));
		run(executable("pnpm"), ["pack", "--pack-destination", outputDirectory], {
			cwd: packageDirectory
		});
		const filename = (await readdir(outputDirectory)).find(
			(entry) => !before.has(entry) && entry.endsWith(".tgz")
		);
		if (!filename) throw new Error(`${workspacePackage.name} did not produce a tarball.`);
		const path = join(outputDirectory, filename);
		const manifestRaw = readPackedFile(path, "package/package.json");
		const manifest = JSON.parse(manifestRaw);
		const files = listPackedFiles(path);
		const failures = validatePackedManifest({
			manifest,
			manifestRaw,
			expectedName: workspacePackage.name,
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
				packages: packed.map(({ name, filename, sha256, bytes }) => ({
					name,
					version: PUBLIC_VERSION,
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

function parseOutput(args) {
	const index = args.indexOf("--output");
	const output = index === -1 ? undefined : args[index + 1];
	if (!output)
		throw new Error("Usage: node scripts/pack-public-packages.mjs --output <empty-dir>");
	return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const output = parseOutput(process.argv.slice(2));
	const packed = await packPublicPackages({ output });
	console.log(
		`Packed ${packed.length} public packages at ${relative(repositoryRoot, resolve(output))}.`
	);
}
