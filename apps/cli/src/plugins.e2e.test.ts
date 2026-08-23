import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const cliIndex = join(repositoryRoot, "apps", "cli", "src", "index.ts");
const roots: string[] = [];

function run(args: readonly string[]) {
	const result = spawnSync(process.execPath, ["--import", "tsx", cliIndex, ...args], {
		cwd: repositoryRoot,
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true
	});
	if (result.error) throw result.error;
	return result;
}

function digest(bytes: Uint8Array) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

afterEach(async () => {
	while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("compiled plugin CLI boundary", () => {
	it("acquires an explicitly requested source graph through a real process", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-plugin-cli-"));
		roots.push(root);
		const sourceRoot = join(root, "source");
		const bundle = spawnSync(
			process.execPath,
			[
				join(repositoryRoot, "scripts", "plugin-bundle.ts"),
				"bundle",
				"--version",
				"0.4.0",
				"--output",
				sourceRoot,
				"--plugins",
				"UEShedCore,UEShedCameras"
			],
			{ cwd: repositoryRoot, encoding: "utf8", timeout: 30_000, windowsHide: true }
		);
		expect(bundle.status, bundle.stderr).toBe(0);
		const manifestPath = join(sourceRoot, "plugins.manifest.json");
		await copyFile(manifestPath, join(sourceRoot, "ue-shed-plugins-0.4.0.manifest.json"));
		// SAFETY: the release script just wrote this manifest; only the two asserted artifact fields are read.
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			readonly artifact: { readonly path: string; readonly sha256: string };
		};
		const manifestDigest = digest(await readFile(manifestPath));
		const result = run([
			"plugins",
			"cache",
			"install",
			"--cache",
			join(root, "cache"),
			"--release",
			"0.4.0",
			"--source",
			sourceRoot,
			"--kind",
			"source",
			"--plugin",
			"UEShedCameras",
			"--manifest-digest",
			manifestDigest,
			"--artifact-digest",
			manifest.artifact.sha256
		]);
		expect(result.status, result.stderr).toBe(0);
		// SAFETY: successful CLI output is its JSON contract; every field used below is asserted.
		const installed = JSON.parse(result.stdout) as {
			readonly artifactKind: string;
			readonly resolvedPluginIds: readonly string[];
			readonly variantIdentity: string;
		};
		expect(installed.artifactKind).toBe("source");
		expect(installed.resolvedPluginIds).toEqual(["UEShedCore", "UEShedCameras"]);
		expect(installed.variantIdentity).toMatch(/^pv2-[a-f0-9]{64}$/u);
	}, 30_000);

	it("rejects a binary request that omits exact engine identity", () => {
		const result = run([
			"plugins",
			"cache",
			"install",
			"--cache",
			"fixture-cache",
			"--release",
			"0.4.0",
			"--kind",
			"compiled",
			"--plugin",
			"UEShedCore"
		]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("require exact --unreal and --build-id");
	});
});
