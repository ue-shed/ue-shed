import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(repositoryRoot, "target", "uasset-inspection-wasm-node");

mkdirSync(outputDirectory, { recursive: true });

const command = process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack";
const result = spawnSync(
	command,
	[
		"build",
		"crates/uasset-inspection-wasm",
		"--target",
		"nodejs",
		"--out-dir",
		"../../target/uasset-inspection-wasm-node",
		"--release"
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
	throw new Error(`wasm-pack failed with exit code ${result.status}`);
}
