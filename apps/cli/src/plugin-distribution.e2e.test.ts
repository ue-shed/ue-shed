import { Schema } from "effect";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSuccessfulCli } from "./cli-in-process.test-support.js";

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

async function runCli(args: readonly string[]) {
	return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await runSuccessfulCli(args)));
}

async function runCliRecord(args: readonly string[]) {
	return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(await runCli(args));
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "ue-shed-plugin-cli-"));
	source = join(root, "source");
	cache = join(root, "cache");
	const pluginRoot = join(root, "Plugins");
	for (const id of ["UEShedCore", "UEShedWorld", "UEShedCameras"]) {
		await mkdir(join(pluginRoot, id), { recursive: true });
		await copyFile(
			join(repositoryRoot, "unreal/Plugins", id, `${id}.uplugin`),
			join(pluginRoot, id, `${id}.uplugin`)
		);
		await cp(
			join(repositoryRoot, "unreal/Plugins", id, "Source"),
			join(pluginRoot, id, "Source"),
			{ recursive: true }
		);
	}
	run(process.execPath, [
		join(repositoryRoot, "scripts", "plugin-bundle.ts"),
		"bundle",
		"--version",
		releaseVersion,
		"--output",
		source,
		"--plugins",
		"UEShedCore,UEShedWorld,UEShedCameras",
		"--source-root",
		pluginRoot,
		"--license",
		join(repositoryRoot, "LICENSE")
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
	it("installs, inspects, verifies, reuses offline, and prunes an exact release", async () => {
		const manifestPath = join(source, `ue-shed-plugins-${releaseVersion}.manifest.json`);
		const manifestBytes = await readFile(manifestPath);
		const manifest = Schema.decodeUnknownSync(
			Schema.Struct({ artifact: Schema.Struct({ sha256: Schema.String }) })
		)(JSON.parse(manifestBytes.toString("utf8")));
		const manifestDigest = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
		const installed = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
			JSON.parse(
				run(process.execPath, [
					"--import",
					"tsx",
					cliIndex,
					"plugins",
					"cache",
					"install",
					"--cache",
					cache,
					"--source",
					source,
					"--release",
					releaseVersion,
					"--plugin",
					"UEShedCameras",
					"--unreal",
					"5.7",
					"--kind",
					"source",
					"--manifest-digest",
					manifestDigest,
					"--artifact-digest",
					manifest.artifact.sha256
				])
			)
		);
		expect(installed.cacheHit).toBe(false);
		expect(installed.artifactKind).toBe("source");
		expect(installed.variantIdentity).toMatch(/^pv2-[a-f0-9]{64}$/u);
		expect(installed.resolvedPluginIds).toEqual(["UEShedCore", "UEShedWorld", "UEShedCameras"]);

		const cached = await runCli(["plugins", "cache", "list", "--cache", cache]);
		expect(cached).toEqual([
			expect.objectContaining({
				plugins: expect.arrayContaining(["UEShedCore", "UEShedCameras"]),
				releaseVersion
			})
		]);
		expect(
			(
				await runCliRecord([
					"plugins",
					"cache",
					"verify",
					"--cache",
					cache,
					"--release",
					releaseVersion
				])
			).releaseVersion
		).toBe(releaseVersion);

		const offline = await runCliRecord([
			"plugins",
			"cache",
			"install",
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
			(
				await runCliRecord([
					"plugins",
					"cache",
					"prune",
					"--cache",
					cache,
					"--release",
					releaseVersion
				])
			).status
		).toBe("pruned");
		expect(await runCli(["plugins", "cache", "list", "--cache", cache])).toEqual([]);
	}, 30_000);
});
