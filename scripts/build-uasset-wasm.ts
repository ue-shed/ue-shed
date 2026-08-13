import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const crateDirectory = join(repositoryRoot, "crates", "uasset-inspection-wasm");
const packageDirectory = join(repositoryRoot, "packages", "uasset-inspection-wasm");
const packageDist = join(packageDirectory, "dist");
const wasmDirectory = join(packageDist, "wasm");
const packageManifest = JSON.parse(
	readFileSync(join(packageDirectory, "package.json"), "utf8")
) as { readonly name: string; readonly version: string };
const crateManifest = readFileSync(join(crateDirectory, "Cargo.toml"), "utf8");
const crateVersion = crateManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (crateVersion === undefined || crateVersion !== packageManifest.version) {
	throw new Error(
		`WASM crate/package versions must match; crate=${crateVersion ?? "missing"}, ` +
			`package=${packageManifest.version}`
	);
}

const command = process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack";
const targets = [
	["nodejs", join(wasmDirectory, "node")],
	["web", join(wasmDirectory, "browser")]
];

rmSync(packageDist, { recursive: true, force: true });
mkdirSync(wasmDirectory, { recursive: true });

for (const [target, outputDirectory] of targets) {
	const result = spawnSync(
		command,
		[
			"build",
			"crates/uasset-inspection-wasm",
			"--target",
			target,
			"--out-dir",
			relative(crateDirectory, outputDirectory),
			"--release",
			"--no-opt",
			"--",
			"--locked"
		],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
			stdio: "inherit"
		}
	);

	if (result.error) {
		throw new Error(
			`Could not start wasm-pack. Install it with "cargo install wasm-pack": ${result.error.message}`
		);
	}
	if (result.status !== 0) {
		throw new Error(`wasm-pack ${target} build failed with exit code ${result.status}`);
	}
	// wasm-pack protects standalone generated packages with a `*` .gitignore. The npm assembly
	// package intentionally owns these generated files, so retaining that marker would silently
	// omit the actual JavaScript and WASM payload from the packed tarball.
	rmSync(join(outputDirectory, ".gitignore"), { force: true });
}

for (const file of [
	"runtime.js",
	"node.js",
	"browser.js",
	"types.d.ts",
	"node.d.ts",
	"browser.d.ts",
	"index.d.ts"
]) {
	cpSync(join(packageDirectory, "src", file), join(packageDist, file));
}

for (const [target, outputDirectory] of targets) {
	validateGeneratedManifest(outputDirectory, target, packageManifest.version);
}

const buildInfo = {
	schemaVersion: 1,
	packageVersion: packageManifest.version,
	crateVersion,
	targets: targets.map(([target]) => target),
	cargoLocked: true,
	tools: {
		rustc: commandVersion("rustc", ["--version"]),
		wasmPack: commandVersion(command, ["--version"]),
		wasmBindgen: cargoLockVersion("wasm-bindgen"),
		wasmOpt: "disabled (--no-opt)"
	},
	optimizer: {
		name: "wasm-opt",
		status: "disabled",
		reason: "wasm-pack --no-opt",
		command: null,
		version: null,
		enabled: false
	},
	limits: {
		maxInputBytes: 64 * 1024 * 1024,
		maxOutputBytes: 64 * 1024 * 1024,
		maxExports: 100_000,
		maxProjectionItems: 1_000_000
	}
};
writeFileSync(join(packageDist, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);

process.stdout.write(
	`WASM browser and Node artifacts assembled at ${packageDist} for ${packageManifest.name}@${packageManifest.version}.\n`
);

function validateGeneratedManifest(outputDirectory: string, target: string, version: string) {
	const manifestPath = join(outputDirectory, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const expectedFiles = [
		"uasset_inspection_wasm_bg.wasm",
		"uasset_inspection_wasm.js",
		"uasset_inspection_wasm.d.ts"
	];

	if (manifest.name !== "uasset-inspection-wasm" || manifest.version !== version) {
		throw new Error(`Generated ${target} manifest has unexpected name or version.`);
	}
	if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
		throw new Error(`Generated ${target} manifest has an unexpected file allowlist.`);
	}
	if (JSON.stringify(manifest).includes("workspace:")) {
		throw new Error(`Generated ${target} manifest contains a workspace dependency.`);
	}
	if (containsAbsolutePath(manifest)) {
		throw new Error(`Generated ${target} manifest contains a local absolute path.`);
	}
}

function containsAbsolutePath(value: unknown): boolean {
	if (typeof value === "string") {
		return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
	}
	if (Array.isArray(value)) return value.some(containsAbsolutePath);
	if (value !== null && typeof value === "object") {
		return Object.values(value).some(containsAbsolutePath);
	}
	return false;
}

function commandVersion(program: string, args: readonly string[]) {
	try {
		return execFileSync(program, args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
	} catch (error) {
		return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function cargoLockVersion(name: string) {
	const lock = readFileSync(join(crateDirectory, "Cargo.lock"), "utf8");
	const match = lock.match(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`));
	return match?.[1] ?? "unavailable";
}
