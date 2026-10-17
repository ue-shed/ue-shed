import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateDependencyPaths } from "./check-dependency-paths.ts";
import type { WorkspaceManifest } from "./workspace-manifests.ts";

test("dependency checks catch the missing temporary tarball before installation", () => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-ci-dependencies-"));
	try {
		const workspaces: readonly WorkspaceManifest[] = [
			{
				name: "fixture",
				directory: "packages/fixture",
				manifest: {
					dependencies: {
						"p4client-ts": "file:../../../../tmp/p4client-0.13/p4client-ts-0.13.0.tgz"
					}
				}
			}
		];
		const lockfile =
			"resolution: {tarball: file:../../tmp/p4client-0.13/p4client-ts-0.13.0.tgz}";
		const failures = validateDependencyPaths(root, workspaces, lockfile, []);
		assert.equal(failures.length, 2);
		assert.ok(
			failures.every((failure) =>
				failure.includes("use a registry version or workspace reference")
			)
		);
		assert.match(failures[1]!, /pnpm-lock.yaml tarball/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("registry/workspace dependencies and checked-in local files remain supported", () => {
	const root = mkdtempSync(join(tmpdir(), "ue-shed-ci-dependencies-"));
	try {
		mkdirSync(join(root, "packages/fixture"), { recursive: true });
		writeFileSync(join(root, "packages/fixture/package.json"), "{}");
		writeFileSync(join(root, "fixture.tgz"), "fixture");
		const workspaces: readonly WorkspaceManifest[] = [
			{
				name: "fixture",
				directory: ".",
				manifest: {
					dependencies: {
						registry: "0.13.0",
						workspace: "workspace:*",
						linked: "link:packages/fixture",
						archive: "file:fixture.tgz"
					}
				}
			}
		];
		assert.deepEqual(
			validateDependencyPaths(root, workspaces, "resolution: {tarball: file:fixture.tgz}", [
				"packages/fixture/package.json",
				"fixture.tgz"
			]),
			[]
		);
		assert.equal(validateDependencyPaths(root, workspaces, "", []).length, 2);
		assert.equal(
			validateDependencyPaths(
				root,
				[
					{
						name: "fixture",
						directory: ".",
						manifest: {
							dependencies: {
								absolute: `file:${join(root, "fixture.tgz")}`,
								relative: "../outside"
							}
						}
					}
				],
				"",
				["fixture.tgz"]
			).length,
			2
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a local dependency cannot escape the checkout through a directory link", () => {
	const parent = mkdtempSync(join(tmpdir(), "ue-shed-ci-dependencies-"));
	const root = join(parent, "checkout");
	const outside = join(parent, "outside");
	try {
		mkdirSync(root);
		mkdirSync(outside);
		writeFileSync(join(outside, "package.json"), "{}");
		symlinkSync(
			outside,
			join(root, "linked"),
			process.platform === "win32" ? "junction" : "dir"
		);
		assert.equal(
			validateDependencyPaths(
				root,
				[
					{
						name: "fixture",
						directory: ".",
						manifest: { optionalDependencies: { linked: "file:linked" } }
					}
				],
				"",
				["linked/package.json"]
			).length,
			1
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
