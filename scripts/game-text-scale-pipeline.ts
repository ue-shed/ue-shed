import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { Effect, Schema, Stream } from "effect";
import {
	AssetReaderError,
	SavedAssetTextExtractionEvent,
	makeAssetReaderTestLayer
} from "../packages/unreal-assets/dist/index.js";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationFileAccessLive,
	readLocalizationReview,
	type LocalizationTargetEvidence
} from "../packages/localization/dist/index.js";
import {
	TextCorpusService,
	TextCorpusServiceLive,
	applyLocalizationReview,
	applyLocalizationKeyChanges,
	joinLocalizationTarget,
	localizationKeyChanges,
	textCorpusQuery,
	localizationStatusReport,
	type TextCorpus
} from "../packages/game-text/dist/index.js";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SavedAssetTextExtractionEvent));

export async function* replayGameTextEvents(root: string) {
	const input = createReadStream(resolve(root, "saved-text.ndjson"));
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			const event = decodeEvent(line);
			yield event.event === "text_summary"
				? { ...event, projectRoot: root, roots: [resolve(root, "Content")] }
				: { ...event, path: resolve(root, event.path) };
		}
	} finally {
		lines.close();
		input.destroy();
	}
}

export const readScaleEvidence = (root: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const reader = yield* LocalizationEvidence;
			const discovery = yield* reader.discover({ projectRoot: root });
			const target = discovery.targets.find((target) => target.name === "Generated");
			if (target === undefined) throw new Error("Generated target was not discovered.");
			const evidence = yield* reader.read({ projectRoot: root, target });
			// Evidence reads model parse and file-limit failures as values. Benchmark them as failures.
			const files = [
				evidence.manifest,
				...evidence.cultures.flatMap((culture) => [culture.archive, culture.po])
			];
			for (const file of files)
				if (file.status === "failed")
					throw new Error(
						`${file.relativePath}: ${file.error.code}: ${file.error.message}; ${file.error.recovery}`
					);
			return evidence;
		}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
	);

export function readScaleCorpus(root: string) {
	const unexpected = () =>
		Effect.die(new Error("Scale replay only supports extractProjectText."));
	const reader = makeAssetReaderTestLayer({
		discoverAssets: unexpected,
		discoverTables: unexpected,
		readAsset: unexpected,
		readTable: unexpected,
		source: () => Effect.succeed("configured"),
		extractProjectText: () =>
			Stream.fromAsyncIterable(
				replayGameTextEvents(root),
				(cause) =>
					new AssetReaderError({
						kind: "contract",
						operation: "scan",
						code: "reader_output_invalid",
						message: String(cause),
						retrySafe: false
					})
			)
	});
	return Effect.runPromise(
		Effect.flatMap(TextCorpusService, (service) => service.scan({ projectRoot: root })).pipe(
			Effect.provide(TextCorpusServiceLive),
			Effect.provide(reader)
		)
	);
}

/** Mirrors CLI joinProjectTarget, including persisted review and key-change pairing. */
export async function joinScaleTarget(
	root: string,
	corpus: TextCorpus,
	evidence: LocalizationTargetEvidence
) {
	const review = await Effect.runPromise(
		readLocalizationReview({ projectRoot: root, target: evidence.target.name }).pipe(
			Effect.provide(LocalizationFileAccessLive)
		)
	);
	const joined = applyLocalizationReview(
		joinLocalizationTarget(corpus, evidence, evidence.target),
		review.contentHash === null ? undefined : review.file
	);
	const keyChanges = localizationKeyChanges(joined, corpus);
	return { join: applyLocalizationKeyChanges(joined, keyChanges.pairs), keyChanges };
}

export function scaleStatus(
	corpus: TextCorpus,
	evidence: LocalizationTargetEvidence,
	join: Awaited<ReturnType<typeof joinScaleTarget>>["join"]
) {
	const page = textCorpusQuery(corpus, undefined, join).search({
		capability: "all",
		pageSize: 50,
		query: "",
		localization: { target: evidence.target.name, culture: evidence.target.cultures[1] }
	});
	return { page, report: localizationStatusReport(corpus, evidence, page) };
}
