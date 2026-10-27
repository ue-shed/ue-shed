import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	findStrayTypeScriptOutput,
	PUBLIC_PACKAGES,
	PUBLIC_VERSION,
	publicPackageSelectionArgs,
	validateEffectPeers,
	validatePackedManifest
} from "./pack-public-packages.ts";

function emitted(source: string) {
	const stem = source.replace(/\.ts$/u, "");
	return [".js", ".js.map", ".d.ts", ".d.ts.map"].map(
		(suffix) => `package/dist/${stem}${suffix}`
	);
}

const sourceFiles = ["index.ts", "review-preview.ts", "contracts/review.ts"];
const cleanFiles = [
	"package/package.json",
	"package/README.md",
	"package/LICENSE",
	...sourceFiles.flatMap(emitted)
];

test("published Effect runtimes are required compatible peers", () => {
	const manifest = {
		name: "@ue-shed/observability",
		version: PUBLIC_VERSION,
		peerDependencies: { effect: "^4.0.0", "@effect/opentelemetry": "^4.0.0" }
	};
	assert.deepEqual(validateEffectPeers(manifest), []);
	for (const field of ["dependencies", "optionalDependencies"] as const) {
		for (const name of ["effect", "@effect/opentelemetry"]) {
			assert.deepEqual(validateEffectPeers({ ...manifest, [field]: { [name]: "4.0.4" } }), [
				`${manifest.name} must declare ${name} as a peer dependency`
			]);
		}
	}
	for (const name of ["effect", "@effect/opentelemetry"]) {
		for (const range of ["4.0.4", "catalog:", "^3.0.0"]) {
			assert.deepEqual(
				validateEffectPeers({
					...manifest,
					peerDependencies: { ...manifest.peerDependencies, [name]: range }
				}),
				[`${manifest.name} must declare required peer ${name} ^4.0.0`]
			);
		}
		assert.deepEqual(
			validateEffectPeers({
				...manifest,
				peerDependenciesMeta: { [name]: { optional: true } }
			}),
			[`${manifest.name} must declare required peer ${name} ^4.0.0`]
		);
	}
});

test("accepts dist files that the current sources emit", () => {
	assert.deepEqual(findStrayTypeScriptOutput({ files: cleanFiles, sourceFiles }), []);
	assert.deepEqual(
		findStrayTypeScriptOutput({
			files: cleanFiles,
			sourceFiles: ["index.ts", "review-preview.ts", "contracts\\review.ts"]
		}),
		[],
		"Windows-relative source paths must match packed paths"
	);
});

test("rejects the stale cameras 0.9.1 build output", () => {
	// 0.9.1 shipped these from an uncleaned dist after their sources were renamed or removed.
	const stale = ["json-file.ts", "review-preview-live.ts", "sha256.ts"].flatMap(emitted);
	assert.deepEqual(
		findStrayTypeScriptOutput({ files: [...cleanFiles, ...stale], sourceFiles }),
		stale
	);
});

test("rejects dist files with no TypeScript output shape", () => {
	assert.deepEqual(
		findStrayTypeScriptOutput({
			files: [...cleanFiles, "package/dist/index.tsbuildinfo", "package/dist/notes.txt"],
			sourceFiles
		}),
		["package/dist/index.tsbuildinfo", "package/dist/notes.txt"]
	);
});

test("fails pack validation with the stray files named", () => {
	const manifest = {
		name: "@ue-shed/cameras",
		version: PUBLIC_VERSION,
		license: "MIT",
		repository: { url: "git+https://github.com/ue-shed/ue-shed.git" },
		main: "./dist/index.js",
		types: "./dist/index.d.ts",
		exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }
	};
	const validate = (files: readonly string[]) =>
		validatePackedManifest({
			manifest,
			manifestRaw: JSON.stringify(manifest),
			expectedName: manifest.name,
			expectedVersion: PUBLIC_VERSION,
			files,
			typeScriptSources: sourceFiles
		});
	assert.deepEqual(validate(cleanFiles), []);
	const failures = validate([...cleanFiles, "package/dist/sha256.js"]);
	assert.equal(failures.length, 1);
	assert.match(failures[0] ?? "", /no current source emits.*package\/dist\/sha256\.js/u);
});

test("package builds start from an empty dist", async () => {
	const packageDirectory = await mkdtemp(join(tmpdir(), "ue-shed-clean-dist-"));
	try {
		await writeFile(join(packageDirectory, "package.json"), "{}\n");
		await mkdir(join(packageDirectory, "dist", "nested"), { recursive: true });
		await writeFile(join(packageDirectory, "dist", "nested", "retired.js"), "");
		const result = spawnSync(
			process.execPath,
			[join(import.meta.dirname, "clean-package-dist.ts")],
			{ cwd: packageDirectory, encoding: "utf8" }
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(packageDirectory, "dist")), false);
		assert.equal(existsSync(join(packageDirectory, "package.json")), true);
	} finally {
		await rm(packageDirectory, { recursive: true, force: true });
	}
});

test("public package builds follow the workspace dependency graph", async () => {
	const repositoryRoot = join(import.meta.dirname, "..");
	const workDirectory = await mkdtemp(join(tmpdir(), "ue-shed-build-order-"));
	const orderFile = join(workDirectory, "order.txt");
	const recorder = join(workDirectory, "record.mjs");
	try {
		await writeFile(
			recorder,
			[
				'import { appendFileSync } from "node:fs";',
				"appendFileSync(process.env.ORDER_FILE, `${process.env.PNPM_PACKAGE_NAME}\\n`);",
				""
			].join("\n")
		);
		const isWindows = process.platform === "win32";
		const pnpmArgs = [
			...publicPackageSelectionArgs(),
			"--workspace-concurrency=1",
			"exec",
			"node",
			recorder
		];
		const result = spawnSync(
			isWindows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm",
			isWindows ? ["/d", "/s", "/c", "pnpm", ...pnpmArgs] : pnpmArgs,
			{
				cwd: repositoryRoot,
				encoding: "utf8",
				env: { ...process.env, ORDER_FILE: orderFile }
			}
		);
		assert.equal(result.status, 0, result.stderr);
		const order = (await readFile(orderFile, "utf8")).trim().split("\n");
		const position = new Map(order.map((name, index) => [name, index]));
		for (const { name } of PUBLIC_PACKAGES) assert.ok(position.has(name), `${name} not built`);

		const violations: string[] = [];
		for (const directory of await workspacePackageDirectories(repositoryRoot)) {
			// SAFETY: repository-owned workspace manifests with string dependency ranges.
			const manifest = JSON.parse(
				await readFile(join(directory, "package.json"), "utf8")
			) as WorkspaceManifest;
			const own = position.get(manifest.name);
			if (own === undefined) continue;
			for (const dependencies of [
				manifest.dependencies,
				manifest.devDependencies,
				manifest.optionalDependencies,
				manifest.peerDependencies
			]) {
				for (const [dependency, range] of Object.entries(dependencies ?? {})) {
					if (!range.startsWith("workspace:")) continue;
					const before = position.get(dependency);
					if (before === undefined || before > own) {
						violations.push(`${manifest.name} builds before ${dependency}`);
					}
				}
			}
		}
		assert.deepEqual(violations, []);
	} finally {
		await rm(workDirectory, { recursive: true, force: true });
	}
});

interface WorkspaceManifest {
	readonly name: string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
}

async function workspacePackageDirectories(repositoryRoot: string) {
	const directories: string[] = [];
	for (const root of ["packages", "extensions", "apps", "examples"]) {
		const parent = join(repositoryRoot, root);
		if (!existsSync(parent)) continue;
		for (const entry of await readdir(parent, { withFileTypes: true })) {
			const directory = join(parent, entry.name);
			if (entry.isDirectory() && existsSync(join(directory, "package.json"))) {
				directories.push(directory);
			}
		}
	}
	return directories;
}

test("Game Text packs focused entry points without aggregate fallbacks", async () => {
	const manifest = JSON.parse(
		await readFile(join(import.meta.dirname, "../packages/game-text/package.json"), "utf8")
	);
	delete manifest.devDependencies;
	manifest.dependencies = Object.fromEntries(
		Object.keys(manifest.dependencies).map((name) => [name, PUBLIC_VERSION])
	);
	assert.equal(manifest.main, undefined);
	assert.equal(manifest.types, undefined);
	assert.deepEqual(Object.keys(manifest.exports).sort(), [
		"./checks",
		"./corpus",
		"./index",
		"./labels",
		"./rules",
		"./schema",
		"./workspace"
	]);
	const typeScriptSources = Object.keys(manifest.exports).map(
		(subpath) => `entry-${subpath.slice(2)}.ts`
	);
	const files = [
		"package/package.json",
		"package/LICENSE",
		"package/README.md",
		"package/ADOPTING.md",
		"package/adoption.manifest.json",
		...typeScriptSources.flatMap(emitted)
	];
	assert.deepEqual(
		validatePackedManifest({
			manifest,
			manifestRaw: JSON.stringify(manifest),
			expectedName: manifest.name,
			expectedVersion: PUBLIC_VERSION,
			files,
			typeScriptSources
		}),
		[]
	);
});
