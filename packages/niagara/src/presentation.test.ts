import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	niagaraPreviewProfile,
	selectNiagaraPresentation,
	niagaraBackgroundVariant,
	selectNiagaraVariantPresentation
} from "./presentation.js";
import {
	NiagaraPreviewRunManifest,
	NiagaraPreviewSettings,
	NiagaraPreviewProducerRequest,
	NiagaraPreviewProducerReceipt
} from "./schema.js";
import { validateReceipt } from "./preview.js";

const fixture = Schema.decodeUnknownSync(NiagaraPreviewRunManifest)(
	JSON.parse(
		readFileSync(
			new URL(
				"../../protocol/contracts/niagara/preview/v1/fixtures/manifest.json",
				import.meta.url
			),
			"utf8"
		)
	)
);
function sequence(scores: number[], profile: "projectile" | "aura" = "projectile") {
	return {
		...fixture,
		effectiveSettings: {
			...fixture.effectiveSettings,
			sceneProfile: profile,
			frameCount: scores.length,
			playbackFramesPerSecond: 30
		},
		artifacts: scores.map((activityScore, index) => ({
			...fixture.artifacts[0]!,
			index,
			activityScore
		}))
	};
}

describe("preview presentation", () => {
	it("selects a visible poster for a single-frame flash", () => {
		const selected = selectNiagaraPresentation(sequence([0, 0, 0, 0.3, 0, 0, 0]));
		expect(selected.posterFrame).toBe(3);
	});
	it("rejects ignored backgrounds and a camera that differs from the requested reference", () => {
		const read = (name: string) =>
			JSON.parse(
				readFileSync(
					new URL(
						`../../protocol/contracts/niagara/preview/v1/fixtures/background-${name}.json`,
						import.meta.url
					),
					"utf8"
				)
			);
		const request = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)(read("request"));
		const receipt = Schema.decodeUnknownSync(NiagaraPreviewProducerReceipt)(read("receipt"));
		Effect.runSync(validateReceipt(receipt, request));
		const fractionalCamera = { ...request.settings.cameraOverride!, fieldOfViewDegrees: 45.1 };
		const fractionalSettings = { ...request.settings, cameraOverride: fractionalCamera };
		Effect.runSync(
			validateReceipt(
				{
					...receipt,
					requestedSettings: fractionalSettings,
					effectiveSettings: {
						...receipt.effectiveSettings,
						cameraOverride: fractionalCamera
					},
					camera: { ...receipt.camera, fieldOfViewDegrees: Math.fround(45.1) }
				},
				{ ...request, settings: fractionalSettings }
			)
		);
		const ignored = {
			...receipt,
			effectiveSettings: { ...receipt.effectiveSettings, background: "default" as const }
		};
		expect(Effect.runSync(Effect.flip(validateReceipt(ignored, request))).code).toBe(
			"receipt_invalid"
		);
		const moved = {
			...receipt,
			camera: {
				...receipt.camera,
				location: { ...receipt.camera.location, x: receipt.camera.location.x + 1 }
			}
		};
		expect(Effect.runSync(Effect.flip(validateReceipt(moved, request))).code).toBe(
			"receipt_invalid"
		);
	});
	it("keeps background variants on the reference camera and active timeline", () => {
		const reference = sequence([0, 0.3, 0.1, 0]);
		const light = niagaraBackgroundVariant(reference, "light");
		expect(light.background).toBe("light");
		expect(light.cameraOverride?.location).toEqual(reference.camera.location);
		expect(light.cameraOverride?.rotation).toEqual(reference.camera.rotation);
		expect(light.exposureCompensation).toBe(reference.effectiveSettings.exposureCompensation);
		const dark = sequence([0, 0, 0.3, 0]);
		const selected = selectNiagaraVariantPresentation(dark, reference);
		expect(selected.posterFrame).toBe(selectNiagaraPresentation(reference).posterFrame);
		expect(selected.frameCount).toBe(selectNiagaraPresentation(reference).frameCount);
		expect(() => selectNiagaraVariantPresentation(sequence([0.1]), reference)).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(NiagaraPreviewSettings)({
				cameraOverride: { ...light.cameraOverride, location: { x: Infinity, y: 0, z: 0 } }
			})
		).toThrow();
	});
	it("keeps material diagnostics visible even when rendered cards have activity", () => {
		const input = sequence([0.1, 0.2]);
		input.diagnostics = [{ code: "missing_material", message: "Two unbound material slots." }];
		expect(selectNiagaraPresentation(input).needsReview).toBe(true);
	});
	it("rejects an old producer ignoring scene settings and inconsistent alpha", () => {
		const load = (name: string) =>
			JSON.parse(
				readFileSync(
					new URL(
						`../../protocol/contracts/niagara/preview/v1/fixtures/${name}.json`,
						import.meta.url
					),
					"utf8"
				)
			);
		const settings = {
			renderMode: "scene" as const,
			cameraMode: "auto_fit" as const,
			captureMode: "full_scene" as const
		};
		const request = Schema.decodeUnknownSync(NiagaraPreviewProducerRequest)({
			...load("request"),
			settings
		});
		const receipt = Schema.decodeUnknownSync(NiagaraPreviewProducerReceipt)({
			...load("receipt"),
			requestedSettings: settings
		});
		expect(Effect.runSync(Effect.flip(validateReceipt(receipt, request))).code).toBe(
			"receipt_invalid"
		);
		const ignoredAlpha = {
			...receipt,
			effectiveSettings: { ...receipt.effectiveSettings, ...settings }
		};
		expect(Effect.runSync(Effect.flip(validateReceipt(ignoredAlpha, request))).code).toBe(
			"receipt_invalid"
		);
		Effect.runSync(
			validateReceipt({ ...ignoredAlpha, alphaPolicy: "opaque_scene_v1" }, request)
		);
	});
	it("preserves authored camera and exposure overrides over a profile", () => {
		const settings = niagaraPreviewProfile("ground_impact", {
			cameraMode: "saved",
			exposureCompensation: -1
		});
		expect(settings.cameraMode).toBe("saved");
		expect(settings.exposureCompensation).toBe(-1);
		expect(settings.renderMode).toBe("scene");
		expect(() => niagaraPreviewProfile("aura", { cameraPadding: 0 })).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(NiagaraPreviewSettings)({ exposureCompensation: Infinity })
		).toThrow();
	});
	it("trims blank tails with padding and chooses a sustained visible poster", () => {
		const scores = [...Array(20).fill(0), ...Array(10).fill(0.2), ...Array(30).fill(0)];
		const input = sequence(scores);
		const selected = selectNiagaraPresentation(input);
		expect(selected.startFrame).toBe(15);
		expect(selected.endFrame).toBe(34);
		expect(selected.posterFrame).toBeGreaterThanOrEqual(20);
		expect(selected.posterFrame).toBeLessThan(30);
		expect(selected.needsReview).toBe(false);
		expect(input.artifacts).toHaveLength(60);
	});
	it("retains the full interval for loops and flags invisible output", () => {
		const loop = selectNiagaraPresentation(sequence([0, 0.2, 0, 0], "aura"));
		expect(loop.startFrame).toBe(0);
		expect(loop.endFrame).toBe(3);
		const blank = selectNiagaraPresentation(sequence(Array(30).fill(0)));
		expect(blank.frameCount).toBe(30);
		expect(blank.needsReview).toBe(true);
	});
	it("flags visible content at the border for review", () => {
		const input = sequence([0.1, 0.2]);
		input.artifacts[0] = { ...input.artifacts[0]!, edgePixelFraction: 0.01 };
		expect(selectNiagaraPresentation(input).needsReview).toBe(true);
	});
});
