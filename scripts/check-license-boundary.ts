import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
	isJsonObject,
	parseJson,
	parseJsonObject,
	type JsonObject,
	type JsonValue
} from "./json.ts";

const forbiddenFormulaPackages = ["hyperformula", "peculiar-sheets-ironcalc", "@ironcalc/wasm"];

/**
 * Transitive Rust dependency licenses, recorded from `cargo info <crate>@<version>`.
 *
 * `pnpm why` cannot see the Cargo graph, so every crate in Cargo.lock needs an entry here before it
 * can ship.
 */
function licensed(license: string, names: string): Record<string, string> {
	return Object.fromEntries(names.split(/\s+/).map((name) => [name, license]));
}

export const rustDependencyLicenses: Record<string, string> = Object.assign(
	{},
	licensed("(MIT OR Apache-2.0) AND Unicode-3.0", "unicode-ident"),
	licensed("Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", "wasip2 wit-bindgen"),
	licensed("BSD-2-Clause OR Apache-2.0 OR MIT", "zerocopy zerocopy-derive"),
	licensed("BSD-3-Clause", "atomic-write-file"),
	licensed(
		"MIT",
		"cfg_aliases engine-process-supervisor libsqlite3-sys rusqlite nix uasset-inspection uasset-io uasset-parser zmij"
	),
	licensed(
		"MIT OR Apache-2.0",
		"bitflags cc cfg-if find-msvc-tools getrandom hashbrown hashlink itoa libc pkg-config ppv-lite86 proc-macro2 quote rand rand_chacha rand_core serde serde_core serde_derive serde_json shlex smallvec syn windows-link windows-sys"
	),
	licensed("MIT OR Apache-2.0 OR LGPL-2.1-or-later", "r-efi"),
	licensed("MIT/Apache-2.0", "fallible-iterator fallible-streaming-iterator vcpkg"),
	licensed("Unlicense OR MIT", "memchr"),
	licensed("Zlib", "foldhash")
);

const acceptedRustLicenses = new Set([
	"MIT",
	"MIT OR Apache-2.0",
	"0BSD OR MIT OR Apache-2.0",
	"Apache-2.0",
	"Apache-2.0 AND ISC",
	"Apache-2.0 AND MIT",
	"Apache-2.0 OR BSL-1.0",
	"Apache-2.0 OR ISC OR MIT",
	"Apache-2.0 OR MIT",
	"Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT",
	"BSD-2-Clause OR Apache-2.0 OR MIT",
	"BSD-3-Clause",
	"CC0-1.0",
	"CDLA-Permissive-2.0",
	"ISC",
	"MIT/Apache-2.0",
	"MIT OR Apache-2.0 OR LGPL-2.1-or-later",
	"MIT OR Zlib OR Apache-2.0",
	"Unlicense OR MIT",
	"(MIT OR Apache-2.0) AND Unicode-3.0",
	"Zlib"
]);

/**
 * Every crate the released `uasset` executable links must carry a recorded permissive license.
 *
 * A new or removed crate fails the check so the record cannot drift away from Cargo.lock.
 */
export function validateRustDependencyLicenses({
	lockfile,
	licenses = rustDependencyLicenses
}: {
	readonly lockfile: string;
	readonly licenses?: Readonly<Record<string, string>>;
}) {
	const failures: string[] = [];
	const locked = new Set([...lockfile.matchAll(/^name = "([^"]+)"$/gm)].map(([, name]) => name));
	for (const name of [...locked].sort()) {
		const license = licenses[name];
		if (license === undefined) {
			failures.push(`Cargo.lock: ${name} has no recorded Rust dependency license`);
			continue;
		}
		if (!acceptedRustLicenses.has(license)) {
			failures.push(
				`Cargo.lock: ${name} license ${license} is not an accepted permissive license`
			);
		}
	}
	for (const name of Object.keys(licenses).sort()) {
		if (!locked.has(name)) {
			failures.push(`Cargo.lock: ${name} is recorded but no longer a Rust dependency`);
		}
	}
	return failures;
}

interface ProductionPaths {
	readonly [dependency: string]: readonly JsonValue[] | undefined;
}

interface LicenseBoundaryInput {
	readonly rootManifest: JsonObject;
	readonly rootLicense: string;
	readonly peculiarManifest: JsonObject;
	readonly productionPaths: ProductionPaths;
}

export function validateLicenseBoundary({
	rootManifest,
	rootLicense,
	peculiarManifest,
	productionPaths
}: LicenseBoundaryInput) {
	const failures: string[] = [];
	if (rootManifest.license !== "MIT") {
		failures.push("package.json: license must be MIT");
	}
	if (!rootLicense.startsWith("MIT License\n")) {
		failures.push("LICENSE: expected the MIT license text");
	}
	if (peculiarManifest.version !== "0.11.1") {
		failures.push(
			`peculiar-sheets: expected exact version 0.11.1, received ${peculiarManifest.version}`
		);
	}
	if (peculiarManifest.license !== "MIT") {
		failures.push(
			`peculiar-sheets: expected MIT metadata, received ${peculiarManifest.license ?? "none"}`
		);
	}
	const dependencies = peculiarManifest.dependencies;
	for (const dependency of forbiddenFormulaPackages) {
		if (isJsonObject(dependencies) && dependency in dependencies) {
			failures.push(
				`peculiar-sheets: production dependency ${dependency} violates the formula-free core boundary`
			);
		}
		if ((productionPaths[dependency] ?? []).length > 0) {
			failures.push(`${dependency}: found a UE Shed production dependency path`);
		}
	}
	return failures;
}

function readProductionPaths(root: string): ProductionPaths {
	const pnpmCli = process.env.npm_execpath;
	if (!pnpmCli) throw new Error("license:check must run through pnpm");
	return Object.fromEntries(
		forbiddenFormulaPackages.map((dependency) => {
			const isJavaScriptCli = /\.(?:c|m)?js$/i.test(pnpmCli);
			const command = isJavaScriptCli ? process.execPath : pnpmCli;
			const args = ["why", "--recursive", "--prod", "--json", dependency];
			if (isJavaScriptCli) args.unshift(pnpmCli);
			const result = spawnSync(command, args, {
				cwd: root,
				encoding: "utf8"
			});
			if (result.status !== 0) {
				throw new Error(
					`pnpm why failed for ${dependency}: ${result.error?.message ?? result.stderr ?? result.stdout}`
				);
			}
			const paths = parseJson(result.stdout || "[]");
			if (!Array.isArray(paths)) throw new Error(`pnpm why returned non-array JSON.`);
			return [dependency, paths] as const;
		})
	);
}

async function main() {
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const root = resolve(scriptDirectory, "..");
	const requireFromAuthoring = createRequire(
		join(root, "extensions", "data-authoring", "package.json")
	);
	const peculiarEntry = requireFromAuthoring.resolve("peculiar-sheets");
	const peculiarManifestPath = resolve(dirname(peculiarEntry), "..", "package.json");
	const [rootManifest, rootLicense, peculiarManifest, lockfile] = await Promise.all([
		readFile(join(root, "package.json"), "utf8").then(parseJsonObject),
		readFile(join(root, "LICENSE"), "utf8"),
		readFile(peculiarManifestPath, "utf8").then(parseJsonObject),
		readFile(join(root, "Cargo.lock"), "utf8")
	]);
	const failures = [
		...validateLicenseBoundary({
			rootManifest,
			rootLicense,
			peculiarManifest,
			productionPaths: readProductionPaths(root)
		}),
		...validateRustDependencyLicenses({ lockfile })
	];
	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		process.exitCode = 1;
		return;
	}
	console.log(
		"License boundary ok: MIT root, peculiar-sheets 0.11.1 core, no formula-engine production " +
			"path, permissive Rust dependency graph."
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
