import { readFile, lstat } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { NiagaraPreviewProgress } from "./progress-schema.js";
import { NiagaraErrorGuidanceFields as ErrorGuidanceFields } from "./schema.js";
export * from "./progress-schema.js";
export class NiagaraProgressError extends Schema.TaggedError<NiagaraProgressError>()(
	"NiagaraProgressError",
	{ ...ErrorGuidanceFields, cause: Schema.optionalKey(Schema.Defect()) }
) {}
/** Progress is optional telemetry the producer rewrites; reading it again is always safe. */
const progressError = (
	message: string,
	nextStep: NiagaraProgressError["nextStep"],
	recovery: string,
	cause?: unknown
) =>
	new NiagaraProgressError({
		message,
		recovery,
		retrySafe: true,
		nextStep,
		...(cause === undefined ? undefined : { cause })
	});
/** Optional telemetry; a missing file is normal with an older producer or before initialization. */
export const readNiagaraPreviewProgress = Effect.fn("NiagaraPreview.readProgress")(function* (
	path: string,
	runId: string
) {
	const text = yield* Effect.tryPromise({
		try: async () => {
			try {
				const file = await lstat(path);
				if (!file.isFile() || file.isSymbolicLink() || file.size > 4096)
					throw new Error("Invalid progress file.");
				return await readFile(path, "utf8");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT")
					return undefined;
				throw error;
			}
		},
		catch: (cause) =>
			progressError(
				"Could not read bounded Niagara progress.",
				"retry",
				"Read progress again; the preview run does not depend on it.",
				cause
			)
	});
	if (text === undefined) return undefined;
	const progress = yield* Schema.decodeUnknownEffect(
		Schema.fromJsonString(NiagaraPreviewProgress)
	)(text).pipe(
		Effect.mapError((cause) =>
			progressError(
				"Invalid Niagara progress.",
				"retry",
				"Read progress again after the producer rewrites it.",
				cause
			)
		)
	);
	if (progress.runId !== runId)
		return yield* Effect.fail(
			progressError(
				"Niagara progress belongs to another run.",
				"reconcile",
				"Wait for the current run to write its own progress, then read it again."
			)
		);
	return progress;
});
