import { JoinedQueryData } from "./joined-query-data.test-support.js";
import { textCorpusReportHeader } from "./corpus-summary.js";
import { Effect, Layer } from "effect";
import {
	AssetReader,
	AssetReaderLive,
	nativeGameTextEngineClientLayer
} from "@ue-shed/unreal-assets";
import { openNativeTextQuery } from "./native-query.js";
import { nativeIndexConfiguration } from "./native-index-configuration.js";
import { typeScriptIndexBuilderLayer as builder } from "./index-builder-reference.test-support.js";
import { GameTextIndexQuery } from "./index-query-native.js";
import { openJoinedTarget } from "./joined-target-reader.js";
import { sharedIndexNodeLayer } from "./shared-index.js";
import { columnarTextCorpusQuery } from "./columnar-query.test-support.js";
import { GameTextIndexError } from "./index-contract.js";
import { referenceSearchRows } from "./query.test-support.js";
import {
	derivedAggregate,
	derivedCorpusFingerprint,
	derivedCorpusHeader,
	derivedLineViews,
	type DerivedReadsBase
} from "./index-derived-reads.test-support.js";

/** Explicit in-process oracle for portable workflow tests; never imported by production. */
export const typeScriptIndexBuilderLayer = Layer.merge(
	builder,
	Layer.succeed(
		GameTextIndexQuery,
		GameTextIndexQuery.of({
			open: Effect.fn("Test.GameTextIndexQuery.open")(function* (input) {
				const joined = yield* openJoinedTarget().pipe(
					Effect.provide(sharedIndexNodeLayer(input.configuration)),
					Effect.mapError(
						(cause) =>
							new GameTextIndexError({
								code: "index_failed",
								operation: "test_query",
								nextStep: "reconcile",
								retrySafe: false,
								message: "The test snapshot could not open.",
								recovery: "Repair the test fixture.",
								cause
							})
					)
				);
				const reference = columnarTextCorpusQuery(joined);
				const configuration = yield* Effect.flatMap(AssetReader, (reader) =>
					reader.configuration()
				).pipe(Effect.provide(AssetReaderLive), Effect.orDie);
				const services = yield* Layer.build(nativeGameTextEngineClientLayer(configuration));
				const findings = yield* openNativeTextQuery({
					configuration: nativeIndexConfiguration(input.configuration),
					generation: input.generation,
					joinedKey: input.joinedKey
				}).pipe(Effect.provide(services));
				const readCorpus = () => {
					const data = new JoinedQueryData(joined),
						summary = reference.summary();
					return {
						...data.exportMetadata(),
						status: summary.status,
						coverage: summary.coverage,
						units: Array.from(data.column("query.raw.order"), (row) =>
							data.unit("raw", row)
						)
					};
				};
				const base: DerivedReadsBase = {
					lines: (request) => reference.localizationLines(request),
					search: (request) => reference.search(request),
					corpus: readCorpus,
					cultures: joined.meta.input.target.cultures
				};
				const reader: Effect.Success<ReturnType<typeof openNativeTextQuery>> = {
					findingsEvaluate: findings.findingsEvaluate,
					findingsLines: findings.findingsLines,
					findingsUnits: findings.findingsUnits,
					readLocalizationLines: () =>
						Effect.sync(() => reference.readLocalizationLines()),
					readCorpus: () => Effect.sync(readCorpus),
					aggregate: (request) => Effect.sync(() => derivedAggregate(base, request)),
					selectLocalizationLines: (request, fields) =>
						Effect.sync(() => derivedLineViews(base, request, fields)),
					readCorpusHeader: () => Effect.sync(() => derivedCorpusHeader(readCorpus())),
					readCorpusReportHeader: () =>
						Effect.sync(() =>
							textCorpusReportHeader(derivedCorpusHeader(readCorpus()))
						),
					readUnits: (ids) =>
						Effect.sync(() =>
							readCorpus().units.filter((unit) => ids.includes(unit.id))
						),
					corpusFingerprint: () =>
						Effect.sync(() => derivedCorpusFingerprint(readCorpus())),
					summary: () => Effect.sync(reference.summary),
					search: (request) => Effect.sync(() => reference.search(request)),
					searchRows: (request) =>
						Effect.sync(() => referenceSearchRows(reference.search, request)),
					focus: (request) => Effect.sync(() => reference.focus(request)),
					localizationFocus: (id) => Effect.sync(() => reference.localizationFocus(id)),
					localizationDetail: (request) =>
						Effect.sync(() => reference.localizationDetail(request)),
					localizationLines: (request) =>
						Effect.sync(() => reference.localizationLines(request)),
					localizationRows: (request) =>
						Effect.sync(() => reference.localizationRows(request)),
					exportWithSignals: (request) =>
						Effect.sync(() => {
							const corpus = reference.export(request);
							return {
								corpus,
								reviewSignals: new Map(
									corpus.units.map((unit) => [
										unit.id,
										reference.focus({ id: unit.id, pageSize: 1 })!.unit
											.reviewSignals
									])
								)
							};
						}),
					export: (request) => Effect.sync(() => reference.export(request))
				};
				return reader;
			})
		})
	)
);
