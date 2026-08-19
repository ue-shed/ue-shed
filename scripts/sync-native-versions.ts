import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_PACKAGES } from "./pack-public-packages.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const publicPackagePaths = PUBLIC_PACKAGES.map(({ directory }) => `${directory}/package.json`);
const cargoManifestPaths = [
	"crates/engine-process-supervisor/Cargo.toml",
	"crates/uasset-parser/Cargo.toml",
	"crates/uasset-inspection/Cargo.toml",
	"crates/uasset-io/Cargo.toml",
	"crates/uasset-inspection-wasm/Cargo.toml"
];
const cargoLocks = [
	{
		path: "Cargo.lock",
		crates: ["engine-process-supervisor", "uasset-parser", "uasset-inspection", "uasset-io"]
	},
	{
		path: "crates/uasset-inspection-wasm/Cargo.lock",
		crates: ["uasset-parser", "uasset-inspection", "uasset-inspection-wasm"]
	}
];
const pluginDescriptorPaths = [
	"unreal/Plugins/UEShedAssetAudits/UEShedAssetAudits.uplugin",
	"unreal/Plugins/UEShedAuthoring/UEShedAuthoring.uplugin",
	"unreal/Plugins/UEShedCameras/UEShedCameras.uplugin",
	"unreal/Plugins/UEShedCore/UEShedCore.uplugin",
	"unreal/Plugins/UEShedNiagara/UEShedNiagara.uplugin",
	"unreal/Plugins/UEShedObservatory/UEShedObservatory.uplugin",
	"unreal/Plugins/UEShedScenarios/UEShedScenarios.uplugin"
];

async function read(path: string) {
	return readFile(join(repositoryRoot, path), "utf8");
}

async function replace(path: string, transform: (source: string) => string) {
	const absolutePath = join(repositoryRoot, path);
	const before = await readFile(absolutePath, "utf8");
	const after = transform(before).replaceAll("\r\n", "\n");
	if (after === before) return;
	if (checkOnly) {
		throw new Error(`${path} is not synchronized with the public suite version.`);
	}
	await writeFile(absolutePath, after, "utf8");
}

const packageVersions = await Promise.all(
	publicPackagePaths.map(
		// SAFETY: every path points to a repository-owned npm package manifest with a version field.
		async (path) => (JSON.parse(await read(path)) as { readonly version: string }).version
	)
);
const versions = new Set(packageVersions);
if (versions.size !== 1) {
	throw new Error(
		`Every public package must share one suite version: ${packageVersions.join(", ")}.`
	);
}
const version = versions.values().next().value;
if (version === undefined) throw new Error("The public package suite is empty.");

for (const path of cargoManifestPaths) {
	await replace(path, (source) => {
		const pattern = /^version\s*=\s*"[^"]+"/mu;
		if (!pattern.test(source)) {
			throw new Error(`${path} has no package version to synchronize.`);
		}
		return source.replace(pattern, `version = "${version}"`);
	});
}

for (const lock of cargoLocks) {
	await replace(lock.path, (source) => {
		let updated = source;
		for (const crate of lock.crates) {
			const pattern = new RegExp(`(name = "${crate}"\\r?\\nversion = ")[^"]+`, "gu");
			if (!pattern.test(updated)) {
				throw new Error(`${lock.path} has no ${crate} package entry to synchronize.`);
			}
			pattern.lastIndex = 0;
			updated = updated.replace(pattern, `$1${version}`);
		}
		return updated;
	});
}

for (const path of pluginDescriptorPaths) {
	await replace(path, (source) => {
		const pattern = /("VersionName"\s*:\s*")[^"]+/u;
		if (!pattern.test(source)) {
			throw new Error(`${path} has no VersionName to synchronize.`);
		}
		return source.replace(pattern, `$1${version}`);
	});
}

await replace("packages/cameras/src/version.ts", (source) => {
	const pattern = /(CAMERAS_PACKAGE_VERSION = ")[^"]+/u;
	if (!pattern.test(source)) {
		throw new Error("packages/cameras/src/version.ts has no package version to synchronize.");
	}
	return source.replace(pattern, `$1${version}`);
});

console.log(
	`Public npm packages, native Rust crates, generated metadata, and Unreal plugin descriptors agree on ${version}.`
);
