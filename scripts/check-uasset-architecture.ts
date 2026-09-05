import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function rustFiles(directory: string): Promise<string[]> {
	const entries = await readdir(join(repositoryRoot, directory), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await rustFiles(path)));
		else if (entry.name.endsWith(".rs")) files.push(path);
	}
	return files;
}

async function checkPortableCrate(directory: string, failures: string[]) {
	for (const path of await rustFiles(directory)) {
		const absolute = join(repositoryRoot, path);
		const source = await readFile(absolute, "utf8");
		// Test modules may load fixtures from disk; production code above the test module must not.
		const production = source.split("#[cfg(test)]", 1)[0];
		for (const pattern of [
			/\bstd::fs\b/,
			/\bstd::process\b/,
			/\bstd::thread\b/,
			/\bstd::sync\b/,
			/\b(?:rayon|tokio)\b/,
			/\bCommand::new\b/,
			/\bFile::open\b/
		]) {
			if (pattern.test(production)) {
				failures.push(`${relative(repositoryRoot, absolute)} uses ${pattern}`);
			}
		}
	}
}

async function main() {
	const failures: string[] = [];
	await checkPortableCrate("crates/uasset-parser/src", failures);
	await checkPortableCrate("crates/uasset-inspection/src", failures);

	const parserBin = join(repositoryRoot, "crates", "uasset-parser", "src", "bin");
	try {
		const entries = await readdir(parserBin);
		if (entries.length > 0) {
			failures.push(
				"crates/uasset-parser/src/bin still contains an executable; ownership belongs to uasset-io"
			);
		}
	} catch (error) {
		if (!(error instanceof Object) || !("code" in error) || error.code !== "ENOENT") {
			throw error;
		}
	}

	const executable = await readFile(
		join(repositoryRoot, "crates", "uasset-io", "src", "bin", "uasset.rs"),
		"utf8"
	);
	if (executable.split(/\r?\n/).length > 40) {
		failures.push("uasset-io/src/bin/uasset.rs is no longer a thin executable adapter");
	}
	for (const needle of ["std::fs", "std::thread", "File::open", "read_dir", "Command::new"]) {
		if (executable.includes(needle)) failures.push(`uasset executable contains ${needle}`);
	}

	const wasm = await readFile(
		join(repositoryRoot, "crates", "uasset-inspection-wasm", "src", "lib.rs"),
		"utf8"
	);
	if (/include!\s*\(/.test(wasm)) {
		failures.push("uasset-inspection-wasm source-includes executable code");
	}

	await checkProjectIndexTypeScriptBoundary(failures);
	await checkCatalogStorageBoundary(failures);

	if (failures.length > 0) {
		throw new Error(
			`UAsset architecture check failed:\n${failures.map((value) => `- ${value}`).join("\n")}`
		);
	}
	process.stdout.write("UAsset architecture ownership checks passed.\n");
}

async function typescriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(join(repositoryRoot, directory), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			files.push(...(await typescriptFiles(path)));
		} else if (/\.[cm]?tsx?$/.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

/**
 * Catalog adapters are the only places that may know how the Catalog is stored.
 *
 * Coordinator, seam, in-memory adapter, scanner, protocol, and conformance code must stay
 * storage-neutral so the same conformance suite runs unchanged against every adapter.
 */
const CATALOG_STORAGE_ADAPTERS = new Set([
	join("crates", "uasset-io", "src", "direct_executor", "catalog_binary.rs"),
	join("crates", "uasset-io", "src", "direct_executor", "catalog_sqlite.rs")
]);

async function checkCatalogStorageBoundary(failures: string[]) {
	const forbidden = [
		{ label: "a SQLite crate", pattern: /\brusqlite\b/ },
		{ label: "SQLite vocabulary", pattern: /\bsqlite\b/i },
		{ label: "a DuckDB crate", pattern: /\bduckdb\b/ },
		{ label: "a SQL pragma", pattern: /\bPRAGMA\b/ },
		{ label: "SQL data definition", pattern: /\bCREATE (?:TABLE|INDEX)\b/i },
		{ label: "a SQL statement", pattern: /\b(?:SELECT|INSERT INTO|DELETE FROM|UPDATE) \b/ },
		{
			label: "a journal or migration detail",
			pattern: /\b(?:journal_mode|user_version|-wal)\b/
		}
	];
	const adaptersFound = new Set();
	for (const path of await rustFiles(join("crates", "uasset-io", "src"))) {
		if (CATALOG_STORAGE_ADAPTERS.has(path)) {
			adaptersFound.add(path);
			continue;
		}
		const source = await readFile(join(repositoryRoot, path), "utf8");
		for (const rule of forbidden) {
			if (rule.pattern.test(source)) {
				failures.push(`${path} leaks ${rule.label} outside a Catalog storage adapter`);
			}
		}
	}
	for (const adapter of CATALOG_STORAGE_ADAPTERS) {
		if (!adaptersFound.has(adapter)) {
			failures.push(`${adapter} is missing; every selected Catalog adapter must exist`);
		}
	}
	for (const crate of ["uasset-parser", "uasset-inspection", "uasset-inspection-wasm"]) {
		const manifest = await readFile(
			join(repositoryRoot, "crates", crate, "Cargo.toml"),
			"utf8"
		);
		if (/\b(?:rusqlite|sqlite|duckdb)\b/i.test(manifest)) {
			failures.push(`crates/${crate} must stay free of a native Catalog dependency`);
		}
	}
	const ioManifest = await readFile(
		join(repositoryRoot, "crates", "uasset-io", "Cargo.toml"),
		"utf8"
	);
	if (/^duckdb\s*=/m.test(ioManifest)) {
		failures.push("uasset-io must not retain the retired DuckDB dependency");
	}
	const sqlite = ioManifest.match(/^rusqlite = \{([^}]*)\}$/m)?.[1] ?? "";
	if (!/version = "=\d+\.\d+\.\d+"/.test(sqlite)) {
		failures.push("uasset-io must pin an exact rusqlite version");
	}
	if (!/default-features = false/.test(sqlite)) {
		failures.push("uasset-io must disable rusqlite default features");
	}
	if (!/features\s*=\s*\[\s*"bundled"\s*\]/.test(sqlite)) {
		failures.push("uasset-io must enable only SQLite's bundled engine");
	}
	if (
		!/optional = true/.test(sqlite) ||
		!/^catalog-oracle = \["dep:rusqlite"\]$/m.test(ioManifest)
	) {
		failures.push("uasset-io must keep SQLite behind its explicit test oracle feature");
	}
	if (/^default\s*=/m.test(ioManifest)) {
		failures.push("uasset-io must not enable database features by default");
	}
	const modules = await readFile(
		join(repositoryRoot, "crates", "uasset-io", "src", "direct_executor.rs"),
		"utf8"
	);
	if (!modules.includes('#[cfg(all(test, feature = "catalog-oracle"))]\nmod catalog_sqlite;')) {
		failures.push("the SQLite adapter must compile only in explicit oracle tests");
	}
	const dependencies = spawnSync(
		"cargo",
		["tree", "--locked", "-p", "uasset-io", "-e", "normal"],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
			windowsHide: true
		}
	);
	if (dependencies.error || dependencies.status !== 0) {
		failures.push("could not verify the native Catalog runtime dependency tree");
	} else if (/\b(?:rusqlite|libsqlite3-sys|duckdb|libduckdb-sys)\b/.test(dependencies.stdout)) {
		failures.push("the default native runtime must not include a database engine");
	}
}

async function checkProjectIndexTypeScriptBoundary(failures: string[]) {
	const forbidden = [
		{ label: "apps/workbench import", pattern: /from\s+["'][^"']*apps\/workbench/ },
		{ label: "@ue-shed/workbench dependency", pattern: /@ue-shed\/workbench/ },
		{ label: "electron import", pattern: /from\s+["']electron(?:\/|$)/ },
		{ label: "SQLite client import", pattern: /\b(?:better-sqlite3|sql\.js|node:sqlite)\b/ },
		{ label: "SQLite SQL surface", pattern: /\b(?:CREATE TABLE|PRAGMA|sqlite3|rusqlite)\b/i }
	];
	for (const path of await typescriptFiles("packages/unreal-assets/src")) {
		const absolute = join(repositoryRoot, path);
		const source = await readFile(absolute, "utf8");
		for (const rule of forbidden) {
			if (rule.pattern.test(source)) {
				failures.push(
					`${relative(repositoryRoot, absolute)} leaks ${rule.label} across the Project Index TypeScript seam`
				);
			}
		}
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
