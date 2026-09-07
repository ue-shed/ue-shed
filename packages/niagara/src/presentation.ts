import { Schema } from "effect";
import { NiagaraPreviewSettings, type NiagaraPreviewRunManifest } from "./schema.js";

export const NiagaraPreviewProfile = Schema.Literals([
	"ground_impact",
	"projectile",
	"aura",
	"environment"
]);
export type NiagaraPreviewProfile = typeof NiagaraPreviewProfile.Type;

/** Reuse framing and simulation settings; plain variants add no floor or scene props. */
export function niagaraBackgroundVariant(
	manifest: NiagaraPreviewRunManifest,
	background: "dark" | "light"
): NiagaraPreviewSettings {
	if (manifest.camera.projection !== "perspective")
		throw new Error("Background variants require a perspective reference camera.");
	return Schema.decodeUnknownSync(NiagaraPreviewSettings)({
		...manifest.requestedSettings,
		...manifest.effectiveSettings,
		background,
		renderMode: "scene",
		captureMode: "full_scene",
		cameraMode: "saved",
		cameraOverride: {
			location: manifest.camera.location,
			rotation: manifest.camera.rotation,
			fieldOfViewDegrees: manifest.camera.fieldOfViewDegrees
		}
	});
}

/** All backgrounds share the reference's active window and poster time. */
export function selectNiagaraVariantPresentation(
	manifest: NiagaraPreviewRunManifest,
	reference: NiagaraPreviewRunManifest
) {
	if (
		manifest.systemObjectPath !== reference.systemObjectPath ||
		manifest.artifacts.length !== reference.artifacts.length ||
		manifest.effectiveSettings.playbackFramesPerSecond !==
			reference.effectiveSettings.playbackFramesPerSecond ||
		manifest.artifacts.some(
			(frame, index) =>
				Math.abs(frame.timeSeconds - reference.artifacts[index]!.timeSeconds) > 0.00001
		)
	) {
		throw new Error("Background variants require the same system and capture timeline.");
	}
	const selected = selectNiagaraPresentation(reference);
	return {
		...selectNiagaraPresentation(manifest),
		policy: "shared_activity_window_v1" as const,
		startFrame: selected.startFrame,
		endFrame: selected.endFrame,
		posterFrame: selected.posterFrame,
		frameCount: selected.frameCount
	};
}

/** Explicit profiles, never inferred from asset names. Per-job overrides win. */
export function niagaraPreviewProfile(
	profile: NiagaraPreviewProfile,
	overrides: NiagaraPreviewSettings = {}
): NiagaraPreviewSettings {
	const durations = { ground_impact: 3, projectile: 2, aura: 4, environment: 6 };
	const durationSeconds = durations[Schema.decodeUnknownSync(NiagaraPreviewProfile)(profile)];
	return Schema.decodeUnknownSync(NiagaraPreviewSettings)({
		renderMode: "scene",
		captureMode: "full_scene",
		cameraMode: "auto_fit",
		sceneProfile: profile,
		cameraPadding: 1.2,
		exposureCompensation: 1,
		width: 512,
		height: 512,
		startSeconds: 0,
		durationSeconds,
		frameCount: durationSeconds * 30,
		simulationFramesPerSecond: 60,
		...overrides
	});
}

/** Derivative selection only: never discards or changes immutable capture frames. */
export function selectNiagaraPresentation(manifest: NiagaraPreviewRunManifest) {
	const scores = manifest.artifacts.map((frame) => frame.activityScore ?? 0);
	const peak = Math.max(0, ...scores);
	const fps = manifest.effectiveSettings.playbackFramesPerSecond;
	const threshold = Math.max(0.0001, peak * 0.02);
	const active = scores.flatMap((score, index) => (score >= threshold ? [index] : []));
	const pad = Math.ceil(fps * 0.15);
	const trim =
		manifest.effectiveSettings.sceneProfile !== "aura" &&
		manifest.effectiveSettings.sceneProfile !== "environment";
	const startFrame = trim && active.length ? Math.max(0, active[0]! - pad) : 0;
	const endFrame =
		trim && active.length
			? Math.min(scores.length - 1, active[active.length - 1]! + pad)
			: scores.length - 1;
	// A short moving average avoids picking a single flash as the poster.
	const smooth = scores.map((_, index) => {
		const window = scores.slice(Math.max(0, index - 2), index + 3);
		return window.reduce((sum, score) => sum + score, 0) / window.length;
	});
	// A smoothing window may peak before a short flash; the poster itself must be active.
	const posterFrame = active.reduce(
		(best, index) => (smooth[index]! > smooth[best]! ? index : best),
		active[0] ?? 0
	);
	return {
		policy: "activity_window_v1" as const,
		startFrame,
		endFrame,
		posterFrame: Math.max(0, posterFrame),
		frameCount: endFrame - startFrame + 1,
		playbackFramesPerSecond: fps,
		peakActivity: peak,
		needsReview:
			manifest.diagnostics.length > 0 ||
			active.length === 0 ||
			manifest.artifacts.some((frame) => (frame.edgePixelFraction ?? 0) > 0.001)
	};
}
