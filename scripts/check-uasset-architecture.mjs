import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function rustFiles(directory) {
	const entries = await readdir(join(repositoryRoot, directory), { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await rustFiles(path)));
		else if (entry.name.endsWith(".rs")) files.push(path);
	}
	return files;
}

async function checkPortableCrate(directory, failures) {
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
	const failures = [];
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
		if (error?.code !== "ENOENT") throw error;
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

	if (failures.length > 0) {
		throw new Error(
			`UAsset architecture check failed:\n${failures.map((value) => `- ${value}`).join("\n")}`
		);
	}
	process.stdout.write("UAsset architecture ownership checks passed.\n");
}

async function typescriptFiles(directory) {
	const entries = await readdir(join(repositoryRoot, directory), { withFileTypes: true });
	const files = [];
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

async function checkProjectIndexTypeScriptBoundary(failures) {
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
