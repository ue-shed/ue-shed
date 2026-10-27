import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { NiagaraPreviewError, safeIo } from "./preview.js";
import { NiagaraSessionError } from "./session.js";

for (const nextStep of ["reconcile", "escalate"] as const) {
	it.effect(`keeps ${nextStep} session guidance through preview IO`, () =>
		Effect.gen(function* () {
			const cause = new NiagaraSessionError({
				message: "The capture may already be running.",
				recovery: "Inspect this run before submitting another capture.",
				retrySafe: false,
				nextStep
			});
			const fallback = new NiagaraPreviewError({
				code: "process_failed",
				message: "The preview process failed.",
				recovery: "Retry the capture.",
				retrySafe: true,
				nextStep: "retry",
				stage: "capture"
			});
			const error = yield* Effect.flip(safeIo(Effect.fail(cause), fallback));
			expect(error).toMatchObject({
				code: "process_failed",
				recovery: cause.recovery,
				retrySafe: false,
				nextStep,
				cause
			});
			const raw = new Error("Unguided failure");
			const unguided = yield* Effect.flip(safeIo(Effect.fail(raw), fallback));
			expect(unguided).toMatchObject({
				recovery: fallback.recovery,
				retrySafe: true,
				nextStep: "retry",
				cause: raw
			});
		})
	);
}
