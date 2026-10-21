import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { assetReaderLayer, extractProjectTextPackages } from "@ue-shed/unreal-assets";
import { scanTextCorpus, textCorpusFromExtractionEvents } from "./corpus.js";
import { TextCorpus } from "./schema.js";

/** Only the identical copies made by useSavedFixtureProject may share this invocation's corpus.
 * Generated engine fixtures must use their own extraction. The current reader protocol retains
 * Blueprint classes, gather evidence and package names; the benchmark's legacy protocol does not.
 */
export const savedFixtureCorpus = Effect.fn("Test.GameText.savedFixtureCorpus")(function* (
	projectRoot: string,
	executable: string,
	packages = false
) {
	const directory = process.env.UE_SHED_PACKAGE_TEXT_FIXTURE_CACHE;
	const key = createHash("sha256")
		.update(JSON.stringify([executable, packages]))
		.digest("hex");
	const file = directory ? join(directory, `saved-corpus-${key}.json`) : undefined;
	if (file) {
		const cached = yield* Effect.promise(async () => {
			try {
				return Schema.decodeUnknownSync(Schema.fromJsonString(TextCorpus))(
					await readFile(file, "utf8")
				);
			} catch (cause) {
				if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
					return undefined;
				throw cause;
			}
		});
		if (cached) return cached;
	}
	const corpus = yield* Effect.gen(function* () {
		if (packages) {
			const events = yield* Stream.runCollect(extractProjectTextPackages({ projectRoot }));
			return textCorpusFromExtractionEvents({ projectRoot, events });
		}
		return yield* scanTextCorpus({ projectRoot });
	}).pipe(Effect.provide(assetReaderLayer({ executable })));
	if (file)
		yield* Effect.promise(async () => {
			// Each worker publishes complete evidence; readers receive independent decoded values.
			const temporary = `${file}.${randomUUID()}.tmp`;
			await writeFile(temporary, JSON.stringify(corpus));
			await rename(temporary, file);
		});
	return corpus;
});
