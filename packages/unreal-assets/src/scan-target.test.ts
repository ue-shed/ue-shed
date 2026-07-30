import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { resolveScanTarget } from "./index.js";

const fixtureRoot = resolve(
	fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url))
);
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const run = (path: string) => Effect.runPromise(resolveScanTarget(path));
const runExit = (path: string) => Effect.runPromise(Effect.exit(resolveScanTarget(path)));

describe("scan target resolution", () => {
	it("scans all of Content for a project root", async () => {
		expect(await run(fixtureRoot)).toEqual({ paths: [], projectRoot: fixtureRoot });
	});

	it("scans all of Content for a .uproject file", async () => {
		expect(await run(join(fixtureRoot, "UEShedFixture.uproject"))).toEqual({
			paths: [],
			projectRoot: fixtureRoot
		});
	});

	it("scopes a subdirectory to itself under the owning project", async () => {
		const subdirectory = join(fixtureRoot, "Content", "Fixture", "Input");
		expect(await run(subdirectory)).toEqual({
			paths: [subdirectory],
			projectRoot: fixtureRoot
		});
	});

	it("scopes a single asset to itself under the owning project", async () => {
		const asset = join(fixtureRoot, "Content", "Fixture", "Input", "IA_Jump.uasset");
		expect(await run(asset)).toEqual({ paths: [asset], projectRoot: fixtureRoot });
	});

	it("resolves a relative path against the working directory", async () => {
		expect(await run("fixtures/unreal-project")).toEqual({
			paths: [],
			projectRoot: fixtureRoot
		});
	});

	it("refuses a path with no project above it", async () => {
		// The repository root itself holds no .uproject, so nothing anchors `/Game`.
		const exit = await runExit(repositoryRoot);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("refuses a path that does not exist", async () => {
		const exit = await runExit(join(fixtureRoot, "Content", "NoSuchDirectory"));
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
