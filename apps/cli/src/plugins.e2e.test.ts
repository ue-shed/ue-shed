import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	CompiledPluginVariantRequest,
	variantPluginReleaseAssetNames
} from "@ue-shed/plugin-distribution";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const cliIndex = join(repositoryRoot, "apps", "cli", "src", "index.ts");
const roots: string[] = [];

interface TarEntry {
	readonly body: Uint8Array;
	readonly name: string;
}

function writeOctal(block: Buffer, offset: number, length: number, value: number) {
	const encoded = value.toString(8).padStart(length - 1, "0");
	block.write(encoded, offset, length - 1, "ascii");
	block[offset + length - 1] = 0;
}

function archive(entries: readonly TarEntry[]) {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.body);
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf8");
		writeOctal(header, 100, 8, 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, body.byteLength);
		writeOctal(header, 136, 12, 0);
		header.fill(32, 148, 156);
		header[156] = "0".charCodeAt(0);
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		writeOctal(header, 148, 8, checksum);
		blocks.push(header, body);
		const padding = (512 - (body.byteLength % 512)) % 512;
		if (padding > 0) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks), { level: 9 });
}

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

	it("acquires commit-qualified compiled output through default asset names", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-plugin-cli-compiled-"));
		roots.push(root);
		const sourceRoot = join(root, "source");
		await mkdir(sourceRoot);
		const engineSourceCommit = "b".repeat(40);
		const artifactRequest = Schema.decodeUnknownSync(CompiledPluginVariantRequest)({
			architecture: "x64",
			configuration: "Development",
			engineBuildId: "47537391",
			engineSourceCommit,
			kind: "compiled",
			platform: "Win64",
			target: "UnrealEditor",
			unrealVersion: "5.7.4"
		});
		const names = variantPluginReleaseAssetNames("0.4.0", artifactRequest);
		const compiledArchive = archive([
			{
				body: Buffer.from(
					'{"FileVersion":3,"Modules":[{"Name":"UEShedCore","Type":"Runtime"}]}\n'
				),
				name: "UEShed/Plugins/UEShedCore/UEShedCore.uplugin"
			},
			{
				body: Buffer.from("compiled core\n"),
				name: "UEShed/Plugins/UEShedCore/Binaries/Win64/UnrealEditor-UEShedCore.dll"
			},
			{
				body: Buffer.from(
					JSON.stringify({
						BuildId: "47537391",
						Modules: { UEShedCore: "UnrealEditor-UEShedCore.dll" }
					})
				),
				name: "UEShed/Plugins/UEShedCore/Binaries/Win64/UnrealEditor.modules"
			}
		]);
		const compiledManifest = {
			artifact: {
				bytes: compiledArchive.byteLength,
				id: "ue-shed-plugin-compiled-0.4.0",
				kind: "unreal-editor-plugin-binary",
				path: names.artifact,
				sha256: digest(compiledArchive)
			},
			build: {
				builder: "@ue-shed/plugin-distribution",
				builderVersion: "1",
				compiler: {
					compiler: "MSVC",
					compilerVersion: "19.44",
					toolchain: "Visual Studio",
					toolchainVersion: "2022"
				},
				invocationSha256: `sha256:${"d".repeat(64)}`,
				requestedPluginIds: ["UEShedCore"],
				resolvedPluginIds: ["UEShedCore"],
				sourceArtifactSha256: `sha256:${"e".repeat(64)}`,
				sourceManifestSha256: `sha256:${"f".repeat(64)}`
			},
			compatibility: artifactRequest,
			plugins: [
				{
					dependencies: [],
					descriptorPath: "UEShedCore/UEShedCore.uplugin",
					directory: "UEShedCore",
					engineDependencies: [],
					id: "UEShedCore",
					version: "0.4.0"
				}
			],
			provenance: {
				candidateManifest: {
					manifestPath: "candidate-manifest.json",
					sha256: `sha256:${"c".repeat(64)}`,
					version: "0.4.0"
				},
				source: {
					commit: "a".repeat(40),
					ref: "refs/tags/v0.4.0",
					repository: "https://github.com/ue-shed/ue-shed"
				}
			},
			releaseVersion: "0.4.0",
			schemaVersion: 2
		};
		await writeFile(join(sourceRoot, names.artifact), compiledArchive, { flag: "wx" });
		await writeFile(join(sourceRoot, names.manifest), `${JSON.stringify(compiledManifest)}\n`, {
			flag: "wx"
		});

		const result = run([
			"plugins",
			"cache",
			"install",
			"--cache",
			join(root, "cache"),
			"--source",
			sourceRoot,
			"--release",
			"0.4.0",
			"--kind",
			"compiled",
			"--plugin",
			"UEShedCore",
			"--unreal",
			"5.7.4",
			"--build-id",
			"47537391",
			"--engine-source-commit",
			engineSourceCommit
		]);
		expect(result.status, result.stderr).toBe(0);
		// SAFETY: successful CLI output is its JSON contract; every field used below is asserted.
		const installed = JSON.parse(result.stdout) as {
			readonly artifactKind: string;
			readonly resolvedPluginIds: readonly string[];
		};
		expect(installed.artifactKind).toBe("compiled");
		expect(installed.resolvedPluginIds).toEqual(["UEShedCore"]);
	}, 30_000);
});
