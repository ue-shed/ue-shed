import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "./json.ts";
import { checkReleasePlan } from "./check-release-plan.ts";

async function fixture(mixed: boolean) {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-release-plan-"));
	const json = (path: string, value: JsonValue) =>
		writeFile(join(root, path), JSON.stringify(value));
	await mkdir(join(root, ".changeset"));
	await mkdir(join(root, "packages/public"), { recursive: true });
	await mkdir(join(root, "packages/private"));
	await json("package.json", { name: "release-fixture", private: true, version: "0.0.0" });
	await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
	await json("packages/public/package.json", { name: "@fixture/public", version: "1.0.0" });
	await json("packages/private/package.json", {
		name: "@fixture/private",
		version: "0.0.0",
		private: true
	});
	await json(".changeset/config.json", {
		changelog: false,
		commit: false,
		fixed: [],
		linked: [],
		access: "public",
		baseBranch: "main",
		updateInternalDependencies: "patch",
		ignore: []
	});
	await writeFile(
		join(root, ".changeset/change.md"),
		`---\n"@fixture/public": minor\n${mixed ? '"@fixture/private": patch\n' : ""}---\n\nFixture change.\n`
	);
	return root;
}

test("validates the complete accumulated plan without Git metadata or a main ref", async () => {
	const root = await fixture(false);
	try {
		assert.equal(existsSync(join(root, ".git")), false);
		const plan = await checkReleasePlan(root);
		assert.deepEqual(
			plan.releases.map(({ name, newVersion }) => ({ name, newVersion })),
			[{ name: "@fixture/public", newVersion: "1.1.0" }]
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects accumulated notes mixing private and public releases without Git metadata", async () => {
	const root = await fixture(true);
	try {
		await assert.rejects(checkReleasePlan(root), /mixed changeset[\s\S]*@fixture\/private/iu);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
