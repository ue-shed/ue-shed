import { spawnSync } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliIndex = join(repositoryRoot, "apps", "cli", "src", "index.ts");
const releaseVersion = "0.3.1";
let root = "";
let source = "";
let cache = "";

function run(command: string, args: readonly string[], cwd = repositoryRoot) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: process.env,
		timeout: 30_000,
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} exited with ${String(result.status)} for ${args.join(" ")}\n${result.stderr}`
		);
	}
	return result.stdout;
}

function runCli(args: readonly string[]) {
	return Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(run(process.execPath, ["--import", "tsx", cliIndex, ...args]))
	);
}

function runCliRecord(args: readonly string[]) {
	return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(runCli(args));
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "ue-shed-plugin-cli-"));
	source = join(root, "source");
	cache = join(root, "cache");
	run(process.execPath, [
		join(repositoryRoot, "scripts", "plugin-bundle.ts"),
		"bundle",
		"--version",
		releaseVersion,
		"--output",
		source,
		"--plugins",
		"UEShedCore,UEShedCameras"
	]);
	await rename(
		join(source, "plugins.manifest.json"),
		join(source, `ue-shed-plugins-${releaseVersion}.manifest.json`)
	);
});

afterAll(async () => {
	if (root.length > 0) await rm(root, { force: true, recursive: true });
});

describe("plugin distribution CLI process", () => {
	it("acquires, inspects, verifies, reuses offline, and prunes an exact release", () => {
		const acquired = runCliRecord([
			"plugins",
			"acquire",
			"--cache",
			cache,
			"--source",
			source,
			"--release",
			releaseVersion,
			"--plugin",
			"UEShedCameras",
			"--unreal",
			"5.7"
		]);
		expect(acquired.cacheHit).toBe(false);
		expect(acquired.resolvedPluginIds).toEqual(["UEShedCore", "UEShedCameras"]);

		const cached = runCli(["plugins", "cache-list", "--cache", cache]);
		expect(cached).toEqual([
			expect.objectContaining({
				plugins: expect.arrayContaining(["UEShedCore", "UEShedCameras"]),
				releaseVersion
			})
		]);
		expect(
			runCliRecord(["plugins", "cache-verify", "--cache", cache, "--release", releaseVersion])
				.releaseVersion
		).toBe(releaseVersion);

		const offline = runCliRecord([
			"plugins",
			"acquire",
			"--cache",
			cache,
			"--cache-only",
			"--source",
			join(root, "unavailable"),
			"--release",
			releaseVersion,
			"--plugin",
			"UEShedCameras"
		]);
		expect(offline.cacheHit).toBe(true);

		expect(
			runCliRecord(["plugins", "prune", "--cache", cache, "--release", releaseVersion]).status
		).toBe("pruned");
		expect(runCli(["plugins", "cache-list", "--cache", cache])).toEqual([]);
	}, 30_000);
});
