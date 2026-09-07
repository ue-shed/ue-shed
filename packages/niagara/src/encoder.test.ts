import { deepStrictEqual, match, notEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { Schema } from "effect";
import { NiagaraPreviewRunManifest } from "./schema.js";
import { createHash } from "node:crypto";
import { snapshotNiagaraFrames } from "./verified-frames.js";

test("verified snapshot retains original frame bytes after source replacement", async () => {
	const root = await mkdtemp(join(tmpdir(), "niagara-snapshot-test-"));
	try {
		const source = join(root, "source");
		const staging = join(root, "staging");
		await mkdir(join(source, "frames"), { recursive: true });
		await mkdir(staging);
		const original = Buffer.from("verified original frame");
		const relativePath = "frames/frame_0000.png";
		await writeFile(join(source, relativePath), original);
		const artifacts = [
			{
				index: 0,
				timeSeconds: 0,
				width: 64,
				height: 64,
				relativePath,
				bytes: original.length,
				sha256: `sha256:${createHash("sha256").update(original).digest("hex")}`
			}
		];
		await snapshotNiagaraFrames(source, staging, artifacts);
		await writeFile(join(source, relativePath), "replaced after verification");
		deepStrictEqual(await readFile(join(staging, relativePath)), original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("encoder rejects malformed sequences and corrupted frames before launching FFmpeg", async () => {
	const root = await mkdtemp(join(tmpdir(), "niagara-encoder-test-"));
	try {
		const manifest = Schema.decodeUnknownSync(NiagaraPreviewRunManifest)(
			JSON.parse(
				await readFile(
					new URL(
						"../../protocol/contracts/niagara/preview/v1/fixtures/scene-manifest.json",
						import.meta.url
					),
					"utf8"
				)
			)
		);
		const manifestPath = join(root, "manifest.json");
		const encode = () =>
			spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"scripts/encode-niagara-preview.ts",
					"--manifest",
					manifestPath,
					"--ffmpeg",
					join(root, "absent-ffmpeg"),
					"--output",
					join(root, "video")
				],
				{
					cwd: fileURLToPath(new URL("../../../", import.meta.url)),
					encoding: "utf8",
					windowsHide: true,
					timeout: 15_000
				}
			);
		await writeFile(
			manifestPath,
			JSON.stringify({
				...manifest,
				artifacts: [...manifest.artifacts].reverse()
			})
		);
		const unordered = encode();
		notEqual(unordered.status, 0);
		match(unordered.stderr, /complete ordered sequence/u);
		await writeFile(
			manifestPath,
			JSON.stringify({
				...manifest,
				effectiveSettings: { ...manifest.effectiveSettings, width: 63 }
			})
		);
		match(encode().stderr, /requires even capture width/u);
		await writeFile(manifestPath, JSON.stringify(manifest));
		await mkdir(join(root, "frames"));
		await writeFile(join(root, "frames/frame_0000.png"), "corrupt");
		const corrupt = encode();
		notEqual(corrupt.status, 0);
		match(corrupt.stderr, /Frame integrity failed/u);
		deepStrictEqual(JSON.parse(await readFile(manifestPath, "utf8")), manifest);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
