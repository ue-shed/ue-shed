import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DISPOSABLE_MARKER_CONTENT,
	DISPOSABLE_MARKER_FILE,
	resolveDisposableMutationTarget,
	withChangedPackage,
	withDeletedPackage
} from "./benchmark-project-index-support.js";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

async function project(name: string, disposable: boolean) {
	const root = await mkdtemp(join(tmpdir(), `ue-shed-${name}-`));
	roots.push(root);
	await mkdir(join(root, "Content", "Fixture"), { recursive: true });
	await writeFile(join(root, `${name}.uproject`), "{}\n", "utf8");
	if (disposable) {
		await writeFile(join(root, DISPOSABLE_MARKER_FILE), DISPOSABLE_MARKER_CONTENT, "utf8");
	}
	return root;
}

describe("project-index benchmark mutation safety", () => {
	it("requires a distinct project with the exact disposable marker", async () => {
		const primary = await project("primary", false);
		const mutation = await project("mutation", true);
		await writeFile(join(mutation, "Content", "Fixture", "A.uasset"), "asset", "utf8");

		await expect(
			resolveDisposableMutationTarget({
				primaryProjectRoot: primary,
				mutationProjectRoot: primary
			})
		).rejects.toThrow("distinct");
		await expect(
			resolveDisposableMutationTarget({
				primaryProjectRoot: mutation,
				mutationProjectRoot: primary
			})
		).rejects.toThrow(DISPOSABLE_MARKER_FILE);

		const target = await resolveDisposableMutationTarget({
			primaryProjectRoot: primary,
			mutationProjectRoot: mutation
		});
		expect(target.packagePath).toContain("A.uasset");
	});

	it("restores changed timestamps and deleted package companions", async () => {
		const primary = await project("primary", false);
		const mutation = await project("mutation", true);
		const packagePath = join(mutation, "Content", "Fixture", "A.uasset");
		const sidecarPath = join(mutation, "Content", "Fixture", "A.uexp");
		await writeFile(packagePath, "asset", "utf8");
		await writeFile(sidecarPath, "sidecar", "utf8");
		const target = await resolveDisposableMutationTarget({
			primaryProjectRoot: primary,
			mutationProjectRoot: mutation
		});
		const originalMtime = (await stat(packagePath)).mtimeMs;

		await withChangedPackage(target, async () => {
			expect((await stat(packagePath)).mtimeMs).toBeGreaterThan(originalMtime);
		});
		expect((await stat(packagePath)).mtimeMs).toBeCloseTo(originalMtime, -1);

		await withDeletedPackage(target, async () => {
			await expect(access(packagePath)).rejects.toBeDefined();
			await expect(access(sidecarPath)).rejects.toBeDefined();
		});
		await expect(access(packagePath)).resolves.toBeUndefined();
		await expect(access(sidecarPath)).resolves.toBeUndefined();
	});
});
