import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const nativePackagePaths = [
	"packages/uasset/package.json",
	"packages/uasset-inspection-wasm/package.json",
	"packages/uasset-win32-x64/package.json"
];
const cargoManifestPaths = [
	"crates/uasset-parser/Cargo.toml",
	"crates/uasset-inspection/Cargo.toml",
	"crates/uasset-io/Cargo.toml",
	"crates/uasset-inspection-wasm/Cargo.toml"
];
const cargoLocks = [
	{
		path: "Cargo.lock",
		crates: ["uasset-parser", "uasset-inspection", "uasset-io"]
	},
	{
		path: "crates/uasset-inspection-wasm/Cargo.lock",
		crates: ["uasset-parser", "uasset-inspection", "uasset-inspection-wasm"]
	}
];

async function read(path) {
	return readFile(join(repositoryRoot, path), "utf8");
}

async function replace(path, transform) {
	const absolutePath = join(repositoryRoot, path);
	const before = await readFile(absolutePath, "utf8");
	const after = transform(before);
	if (after === before) return;
	if (checkOnly) {
		throw new Error(`${path} is not synchronized with the fixed native npm package group.`);
	}
	await writeFile(absolutePath, after, "utf8");
}

const packageVersions = await Promise.all(
	nativePackagePaths.map(async (path) => JSON.parse(await read(path)).version)
);
const versions = new Set(packageVersions);
if (versions.size !== 1) {
	throw new Error(
		`The fixed native package group must share one version: ${packageVersions.join(", ")}.`
	);
}
const [version] = versions;

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

console.log(`Native Rust and npm packages agree on ${version}.`);
