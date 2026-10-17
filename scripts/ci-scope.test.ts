import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedFiles, selectCiScope, siteWorkspaceDirectories } from "./ci-scope.ts";
import type { WorkspaceManifest } from "./workspace-manifests.ts";

const none = { uasset_io: false, uasset_libraries: false, catalog_oracle: false, site: false };
const all = { uasset_io: true, uasset_libraries: true, catalog_oracle: true, site: true };
const site = ["apps/site", "packages/ui", "packages/protocol", "extensions/data-authoring"];

test("planning and engine-only changes do not schedule unrelated portable native/browser lanes", () => {
	for (const file of [
		"plans/058.md",
		"docs/research/results.md",
		"AGENTS.md",
		"unreal/Plugins/UEShed/Source/Host.cpp"
	]) {
		assert.deepEqual(selectCiScope([file], site, false), none);
	}
});

test("main and shared toolchain/dependency/workflow changes always exercise every lane", () => {
	assert.deepEqual(selectCiScope([], site, true), all);
	for (const file of [
		"Cargo.lock",
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"packages/game-text/package.json",
		".github/workflows/portable.yml",
		"scripts/ci-scope.ts",
		"scripts/check-dependency-paths.test.ts",
		"scripts/native-tools.ts",
		"vitest.node.config.ts",
		".cargo/config.toml"
	]) {
		assert.deepEqual(selectCiScope([file], site, false), all, file);
	}
});

test("Game Text, native index and CLI changes exercise IO without the site or Catalog oracle", () => {
	for (const file of [
		"packages/game-text/src/index.ts",
		"crates/game-text-index/src/lib.rs",
		"apps/cli/src/localization.test.ts",
		"scripts/native-game-text-join.test.ts",
		"scripts/package-text-reader.test-support.ts"
	]) {
		assert.deepEqual(selectCiScope([file], site, false), { ...none, uasset_io: true }, file);
	}
	assert.deepEqual(
		selectCiScope(["crates/uasset-io/src/direct_executor/catalog_binary.rs"], site, false),
		{ ...none, uasset_io: true, catalog_oracle: true }
	);
});

test("parser and saved-byte changes keep downstream IO and browser conformance", () => {
	for (const file of [
		"crates/uasset-parser/src/lib.rs",
		"crates/uasset-inspection-wasm/src/lib.rs",
		"fixtures/unreal-project/Content/Fixture/Map.umap",
		"scripts/build-uasset-wasm.ts"
	]) {
		assert.deepEqual(
			selectCiScope([file], site, false),
			{ ...all, catalog_oracle: false },
			file
		);
	}
	assert.deepEqual(
		selectCiScope(
			["packages/uasset-inspection-wasm/browser.mjs"],
			["packages/uasset-inspection-wasm"],
			false
		),
		{ ...none, uasset_libraries: true, site: true }
	);
});

test("website changes include transitive workspace dependencies, media and browser configuration", () => {
	for (const file of [
		"apps/site/src/App.tsx",
		"packages/ui/src/button.tsx",
		"extensions/data-authoring/src/viewer.ts",
		"apps/workbench/e2e/site/site.e2e.ts",
		"scripts/site-media-model.ts"
	]) {
		assert.equal(selectCiScope([file], site, false).site, true, file);
	}
	const workspaces: readonly WorkspaceManifest[] = [
		{
			name: "@ue-shed/site",
			directory: "apps/site",
			manifest: { dependencies: { extension: "workspace:*" } }
		},
		{
			name: "extension",
			directory: "extensions/test",
			manifest: { dependencies: { protocol: "workspace:*", external: "1.0.0" } }
		},
		{
			name: "protocol",
			directory: "packages/protocol",
			manifest: { devDependencies: { extension: "workspace:*" } }
		},
		{ name: "unrelated", directory: "packages/unrelated", manifest: {} }
	];
	assert.deepEqual(siteWorkspaceDirectories(workspaces), [
		"apps/site",
		"extensions/test",
		"packages/protocol"
	]);
	assert.throws(() => siteWorkspaceDirectories([]), /Missing website workspace/);
});

test("Git change detection includes removed/renamed inputs and fails instead of silently skipping", () => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-ci-scope-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
	try {
		git("init", "--quiet");
		git("config", "user.name", "CI fixture");
		git("config", "user.email", "ci-fixture@example.invalid");
		mkdirSync(join(root, "apps/site"), { recursive: true });
		writeFileSync(join(root, "apps/site/old.txt"), "fixture");
		git("add", ".");
		git("commit", "--quiet", "-m", "base");
		const base = git("rev-parse", "HEAD");
		git("mv", "apps/site/old.txt", "renamed.txt");
		git("commit", "--quiet", "-m", "rename");
		assert.deepEqual(changedFiles(root, base, "HEAD", true), [
			"apps/site/old.txt",
			"renamed.txt"
		]);
		assert.throws(() => changedFiles(root, "", "HEAD", true), /explicit base\/head/);
		assert.throws(() => changedFiles(root, "missing-commit", "HEAD", true));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
