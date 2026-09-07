import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NiagaraPreviewRunManifest } from "./schema.js";

/** The encoder and poster consume this private snapshot, never reopen the source frames. */
export async function snapshotNiagaraFrames(
	sourceRoot: string,
	stagingRoot: string,
	artifacts: readonly Pick<
		NiagaraPreviewRunManifest["artifacts"][number],
		"index" | "relativePath" | "bytes" | "sha256"
	>[]
) {
	const framesRoot = join(stagingRoot, "frames");
	await mkdir(framesRoot);
	for (const [index, frame] of artifacts.entries()) {
		const relativePath = `frames/frame_${String(index).padStart(4, "0")}.png`;
		if (frame.index !== index || frame.relativePath !== relativePath)
			throw new Error("Capture frames must form a complete ordered sequence.");
		const bytes = await readFile(join(sourceRoot, relativePath));
		const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
		if (bytes.length !== frame.bytes || digest !== frame.sha256)
			throw new Error(`Frame integrity failed: ${relativePath}`);
		await writeFile(join(stagingRoot, relativePath), bytes, { flag: "wx" });
	}
	return framesRoot;
}
