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
	licensed("0BSD OR MIT OR Apache-2.0", "adler2"),
	licensed(
		"Apache-2.0",
		"arrow arrow-arith arrow-buffer arrow-cast arrow-data arrow-ord arrow-row arrow-schema arrow-select arrow-string zopfli"
	),
	licensed("Apache-2.0 AND ISC", "ring"),
	licensed("Apache-2.0 AND MIT", "arrow-array"),
	licensed("Apache-2.0 OR BSL-1.0", "ryu"),
	licensed("Apache-2.0 OR ISC OR MIT", "rustls"),
	licensed("Apache-2.0 OR MIT", "autocfg equivalent indexmap pin-project-lite zeroize"),
	licensed(
		"Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT",
		"linux-raw-sys rustix wasi wasip2 wit-bindgen"
	),
	licensed("BSD-2-Clause OR Apache-2.0 OR MIT", "zerocopy zerocopy-derive"),
	licensed("BSD-3-Clause", "atomic-write-file subtle"),
	licensed("CC0-1.0", "tiny-keccak"),
	licensed("CDLA-Permissive-2.0", "webpki-roots"),
	licensed("ISC", "rustls-webpki untrusted"),
	licensed(
		"MIT",
		"atoi bytes cfg_aliases comfy-table crossterm crossterm_winapi crunchy duckdb engine-process-supervisor libduckdb-sys libm nix redox_syscall simd-adler32 slab strum strum_macros uasset-inspection uasset-io uasset-parser uasset-source-gen zip zmij"
	),
	licensed(
		"MIT OR Apache-2.0",
		"ahash android_system_properties arbitrary base64 bitflags bumpalo cast cc cfg-if chrono const-random const-random-macro core-foundation-sys crc32fast derive_arbitrary errno find-msvc-tools flate2 futures-core futures-task futures-util getrandom half hashbrown hashlink heck http httparse iana-time-zone iana-time-zone-haiku itoa jobserver js-sys libc lock_api log num num-bigint num-complex num-integer num-iter num-rational num-traits once_cell parking_lot parking_lot_core percent-encoding pkg-config ppv-lite86 proc-macro2 quote rand rand_chacha rand_core regex regex-automata regex-syntax rustls-pki-types rustversion scopeguard serde serde_core serde_derive serde_json shlex smallvec syn tar unicode-segmentation unicode-width ureq ureq-proto utf8-zero wasm-bindgen wasm-bindgen-macro wasm-bindgen-macro-support wasm-bindgen-shared windows_aarch64_gnullvm windows_aarch64_msvc windows_i686_gnu windows_i686_gnullvm windows_i686_msvc windows_x86_64_gnu windows_x86_64_gnullvm windows_x86_64_msvc windows-core windows-implement windows-interface windows-link windows-result windows-strings windows-sys windows-targets xattr"
	),
	licensed("MIT OR Apache-2.0 OR LGPL-2.1-or-later", "r-efi"),
	licensed("MIT OR Zlib OR Apache-2.0", "miniz_oxide"),
	licensed(
		"MIT/Apache-2.0",
		"fallible-iterator fallible-streaming-iterator filetime lexical-core lexical-parse-float lexical-parse-integer lexical-util lexical-write-float lexical-write-integer vcpkg version_check winapi winapi-i686-pc-windows-gnu winapi-x86_64-pc-windows-gnu"
	),
	licensed("Unlicense OR MIT", "aho-corasick memchr"),
	licensed("Zlib", "foldhash zlib-rs")
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
