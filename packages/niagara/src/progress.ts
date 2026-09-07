import { readFile, lstat } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { NiagaraPreviewProgress } from "./progress-schema.js";
export * from "./progress-schema.js";
export class NiagaraProgressError extends Schema.TaggedErrorClass<NiagaraProgressError>()(
	"NiagaraProgressError",
	{ message: Schema.String }
) {}
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
		catch: () =>
			new NiagaraProgressError({ message: "Could not read bounded Niagara progress." })
	});
	if (text === undefined) return undefined;
	const progress = yield* Schema.decodeUnknownEffect(
		Schema.fromJsonString(NiagaraPreviewProgress)
	)(text).pipe(
		Effect.mapError(() => new NiagaraProgressError({ message: "Invalid Niagara progress." }))
	);
	if (progress.runId !== runId)
		return yield* Effect.fail(
			new NiagaraProgressError({ message: "Niagara progress belongs to another run." })
		);
	return progress;
});
