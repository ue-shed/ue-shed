import { Schema } from "effect";
/**
 * What a caller can do after an expected failure, as a stable code beside the prose `recovery`:
 * `fix_input` (change the request, configuration or project and try again), `retry` (may succeed
 * later unchanged; only when `retrySafe` is true), `reconcile` (state changed underneath: re-read,
 * then decide) and `escalate` (the caller cannot fix it; report it with the error's context).
 */
export const ErrorNextStep = Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]);
/**
 * Guidance fields every UE Shed tagged error carries. Spread into a `Schema.TaggedError` field
 * struct. `retrySafe` states whether repeating the same operation is idempotent; it must be true
 * whenever `nextStep` is `retry`.
 */
export const ErrorGuidanceFields = {
    message: Schema.String,
    recovery: Schema.String,
    retrySafe: Schema.Boolean,
    nextStep: ErrorNextStep
};
/**
 * The original failure behind a classified error. Keep it here instead of stringifying it into
 * `message`; it is diagnostic evidence, not text to branch on.
 */
export const ErrorCauseFields = { cause: Schema.optionalKey(Schema.Defect()) };
