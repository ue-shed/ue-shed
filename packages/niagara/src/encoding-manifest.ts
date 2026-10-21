import type { NiagaraPreviewRunManifest } from "./schema.js";

/** Validate the capture sequence before snapshotting or starting FFmpeg. */
export function validateNiagaraEncodingManifest(manifest: NiagaraPreviewRunManifest): void {
	if (manifest.effectiveSettings.width % 2 !== 0 || manifest.effectiveSettings.height % 2 !== 0) {
		throw new Error("H.264/yuv420p requires even capture width and height.");
	}
	if (
		manifest.artifacts.length !== manifest.effectiveSettings.frameCount ||
		manifest.artifacts.some(
			(frame, index) =>
				frame.index !== index ||
				frame.relativePath !== `frames/frame_${String(index).padStart(4, "0")}.png` ||
				frame.width !== manifest.effectiveSettings.width ||
				frame.height !== manifest.effectiveSettings.height
		)
	) {
		throw new Error(
			"Capture frames must form the complete ordered sequence at the effective dimensions."
		);
	}
}
