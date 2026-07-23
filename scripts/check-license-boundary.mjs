import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const forbiddenFormulaPackages = ["hyperformula", "peculiar-sheets-ironcalc", "@ironcalc/wasm"];

export function validateLicenseBoundary({
	rootManifest,
	rootLicense,
	peculiarManifest,
	productionPaths
}) {
	const failures = [];
	if (rootManifest.license !== "MIT") {
		failures.push("package.json: license must be MIT");
	}
	if (!rootLicense.startsWith("MIT License\n")) {
		failures.push("LICENSE: expected the MIT license text");
	}
	if (peculiarManifest.version !== "0.11.0") {
		failures.push(
			`peculiar-sheets: expected exact version 0.11.0, received ${peculiarManifest.version}`
		);
	}
	if (peculiarManifest.license !== "MIT") {
		failures.push(
			`peculiar-sheets: expected MIT metadata, received ${peculiarManifest.license ?? "none"}`
		);
	}
	for (const dependency of forbiddenFormulaPackages) {
		if (dependency in (peculiarManifest.dependencies ?? {})) {
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

function readProductionPaths(root) {
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
			return [dependency, JSON.parse(result.stdout || "[]")];
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
	const [rootManifest, rootLicense, peculiarManifest] = await Promise.all([
		readFile(join(root, "package.json"), "utf8").then(JSON.parse),
		readFile(join(root, "LICENSE"), "utf8"),
		readFile(peculiarManifestPath, "utf8").then(JSON.parse)
	]);
	const failures = validateLicenseBoundary({
		rootManifest,
		rootLicense,
		peculiarManifest,
		productionPaths: readProductionPaths(root)
	});
	if (failures.length > 0) {
		for (const failure of failures) console.error(failure);
		process.exitCode = 1;
		return;
	}
	console.log(
		"License boundary ok: MIT root, peculiar-sheets 0.11.0 core, no formula-engine production path."
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
