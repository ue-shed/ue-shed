import { channel } from "node:diagnostics_channel";
import { Clock, Effect, Schema, type Scope } from "effect";
import {
	answerJson,
	answerRows,
	type EngineAnswer,
	type EngineProgressObserver,
	NativeGameTextEngineClient
} from "@ue-shed/unreal-assets";
import type { GameTextContract, GameTextIndexConfiguration } from "@ue-shed/protocol";
import { GameTextIndexError } from "./index-contract.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { TextCorpusReportHeader } from "./corpus-summary.js";
import {
	TextCorpus,
	TextUnit,
	TextReviewSignal,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusQuerySummary,
	TextCorpusRowsPage,
	TextCorpusSearchPage,
	TextCorpusSearchRequest
} from "./schema.js";
import { LocalizationLine, type LocalizationLineId } from "./localization-schema.js";
import { LocalizationFocus, LocalizationFocusRequest } from "./localization-view.js";
import { TEXT_AUDIENCE_POLICY } from "./text-audience.js";
import { TextRuleId, textRowFindingFields } from "./text-problem-schema.js";
import {
	TextAggregate,
	TextAggregateRequest,
	TextCorpusHeader,
	localizationLineViews,
	type LocalizationLineField
} from "./index-reads.js";

import type { NativeTextQuery } from "./native-query-contract.js";
import { RelatedLines, RelatedLinesRequest } from "./related-lines.js";
import { enabledRuleDocument } from "./rules/effective.js";
import { annotateFindingsProfile, inflateFindingsPage } from "./native-findings.js";
export type { NativeTextQuery, NativeTextExport } from "./native-query-contract.js";

const benchmark = channel("ue-shed.game-text-benchmark");

const NativeExportFile = Schema.Struct({
	...TextCorpus.fields,
	findingRules: Schema.optionalKey(
		Schema.Array(Schema.Struct({ id: TextRuleId, label: Schema.String }))
	),
	units: Schema.Array(
		Schema.Struct({
			...TextUnit.fields,
			reviewSignals: Schema.Array(TextReviewSignal),
			...textRowFindingFields
		})
	)
});

type Row = { readonly [key: string]: GameTextContract.JsonValue };

/** Parent rows, each with the child rows that name it under `field`; children lose `parent`. */
const withChildren = (parents: readonly Row[], children: readonly Row[], field: string): Row[] => {
	const owned = parents.map((): Row[] => []);
	for (const { parent, ...child } of children) owned[Number(parent)]?.push(child);
	return parents.map((row, index) => ({ ...row, [field]: owned[index]! }));
};

/** A corpus read's document: its head, then its units with their places and its package lists. */
const corpusDocument = (answer: EngineAnswer) => ({
	...answerJson<Row>(answer),
	units: withChildren(answerRows(answer, "units"), answerRows(answer, "places"), "occurrences"),
	packageCoverage: answerRows(answer, "packages"),
	diagnostics: answerRows(answer, "diagnostics")
});

/** A line read's lines, each with its `places` when the read named them. */
const lineRows = (answer: EngineAnswer, places: boolean) =>
	places
		? withChildren(answerRows(answer, "lines"), answerRows(answer, "places"), "places")
		: answerRows(answer, "lines");

const failed = (operation: string, cause: unknown) =>
	new GameTextIndexError({
		code: "index_failed",
		operation,
		nextStep: "reconcile",
		retrySafe: false,
		message: `The native Game Text ${operation} could not complete.`,
		recovery:
			"Refresh the selected Game Text snapshot. If the contract is incompatible, install the native reader from the same UE Shed version.",
		cause
	});

/** This model's snapshot, pinned in the host's engine. */
interface Pinned {
	readonly reader: string;
	readonly execute: (
		request: GameTextContract.EngineRequest,
		progress?: EngineProgressObserver
	) => Effect.Effect<EngineAnswer, GameTextIndexError>;
}

/**
 * Pin one native snapshot for the caller's scope, with no JavaScript query-engine fallback. Reads
 * run concurrently in the host's engine; interrupting one cancels it there.
 */
export const openNativeTextQuery = Effect.fn("GameTextIndex.openNativeQuery")(function* (input: {
	readonly configuration: GameTextIndexConfiguration;
	readonly generation: string;
	readonly joinedKey: string;
	readonly audienceRules?: readonly string[];
	readonly onFailure?: Effect.Effect<void>;
}): Effect.fn.Return<
	NativeTextQuery,
	GameTextIndexError,
	NativeGameTextEngineClient | Scope.Scope
> {
	const engine = yield* NativeGameTextEngineClient;
	const execute = Effect.fn("GameTextIndex.nativeCall")(
		(request: GameTextContract.EngineRequest, progress?: EngineProgressObserver) =>
			engine.execute(request, progress).pipe(
				Effect.mapError((cause) => failed(request.action, cause)),
				Effect.tapError(() => input.onFailure ?? Effect.void)
			)
	);
	const reportProgress = yield* GameTextIndexProgressReporter;
	// The reader closes with the model's scope.
	const opened = yield* Effect.acquireRelease(
		execute(
			{
				action: "open",
				configuration: input.configuration,
				expectedGeneration: input.generation,
				expectedJoined: input.joinedKey,
				policy: {
					audienceRules:
						input.audienceRules ?? TEXT_AUDIENCE_POLICY.map((rule) => rule.id)
				}
			},
			({ completed, total }) =>
				reportProgress({ phase: "opening", completed, total: total ?? 0 })
		).pipe(Effect.map(answerJson<GameTextContract.OpenReply>)),
		(opened) =>
			opened === undefined
				? Effect.void
				: execute({ action: "close", reader: opened.reader }).pipe(
						Effect.catch((cause) =>
							Effect.logDebug("Native Game Text reader cleanup failed", { cause })
						)
					),
		{ interruptible: true }
	);
	if (
		opened === undefined ||
		opened.generation !== input.generation ||
		opened.joinedKey !== input.joinedKey
	)
		return yield* Effect.fail(
			failed("open", "Native reader returned a different snapshot identity.")
		);
	const pinned: Pinned = { reader: opened.reader, execute };
	function response<S extends Schema.Codec<unknown, unknown>>(
		pinned: Pinned,
		request: GameTextContract.EngineRequest,
		schema: S
	): Effect.Effect<S["Type"], GameTextIndexError> {
		return Effect.gen(function* () {
			const answer = yield* pinned.execute(request);
			const decodeStarted = benchmark.hasSubscribers ? performance.now() : undefined;
			const value = yield* Schema.decodeUnknownEffect(schema)(answerJson<unknown>(answer));
			if (decodeStarted !== undefined)
				benchmark.publish({
					stage: "tsPayloadDecode",
					action: request.action,
					ms: performance.now() - decodeStarted
				});
			return value;
		}).pipe(
			Effect.mapError((cause) =>
				Schema.is(GameTextIndexError)(cause) ? cause : failed(request.action, cause)
			)
		);
	}
	/** Decodes a read's rows into the domain type, timed as building row objects. */
	const decodeRows = <A>(
		operation: string,
		schema: Schema.Codec<A, unknown>,
		rows: GameTextContract.JsonValue
	) =>
		Effect.gen(function* () {
			const started = benchmark.hasSubscribers ? performance.now() : undefined;
			const value = yield* Schema.decodeUnknownEffect(schema)(rows).pipe(
				Effect.mapError((cause) => failed(`${operation}_decode`, cause))
			);
			if (started !== undefined)
				benchmark.publish({
					stage: "tsRowObjects",
					action: operation,
					ms: performance.now() - started
				});
			return value;
		});
	const localizationLines = Effect.fn("GameTextIndex.nativeLocalizationExport")(function* (
		pinned: Pinned,
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)({
			...request,
			pageSize: 50
		}).pipe(Effect.mapError((cause) => failed("localization_export", cause)));
		const answer = yield* pinned.execute({
			action: "localization_export",
			reader: pinned.reader,
			request: decoded
		});
		return yield* decodeRows(
			"localization_export",
			Schema.Array(LocalizationLine),
			lineRows(answer, false)
		);
	});
	const exportWithSignals = Effect.fn("GameTextIndex.nativeExport")(function* (
		pinned: Pinned,
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize"> | undefined
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)({
			query: "",
			capability: "all",
			...request,
			pageSize: 50
		}).pipe(Effect.mapError((cause) => failed("export", cause)));
		const answer = yield* pinned.execute(
			request === undefined
				? { action: "corpus", reader: pinned.reader }
				: { action: "export", reader: pinned.reader, request: decoded }
		);
		const file = yield* decodeRows("export", NativeExportFile, corpusDocument(answer));
		const { findingRules, ...corpus } = file;
		return {
			corpus: {
				...corpus,
				units: file.units.map(
					({
						reviewSignals: _signals,
						findings: _findings,
						findingsOmitted: _omitted,
						...unit
					}) => unit
				)
			},
			reviewSignals: new Map(file.units.map((unit) => [unit.id, unit.reviewSignals])),
			...(findingRules
				? {
						findings: {
							labels: new Map(findingRules.map((rule) => [rule.id, rule.label])),
							units: new Map(file.units.map((unit) => [unit.id, unit.findings ?? []]))
						}
					}
				: undefined)
		};
	});
	const aggregate = Effect.fn("GameTextIndex.nativeAggregate")(function* (
		pinned: Pinned,
		request: TextAggregateRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextAggregateRequest)(request).pipe(
			Effect.mapError((cause) => failed("aggregate", cause))
		);
		const answer = yield* pinned.execute({
			action: "aggregate",
			reader: pinned.reader,
			request: decoded
		});
		// The engine writes each key component as text: a translation key as its JSON.
		return yield* decodeRows("aggregate", TextAggregate, {
			...answerJson<Row>(answer),
			groups: answerRows(answer, "groups")
		});
	});
	const selectLocalizationLines = <F extends LocalizationLineField>(
		pinned: Pinned,
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">,
		fields: readonly F[]
	) =>
		Effect.gen(function* () {
			const encodeStarted = benchmark.hasSubscribers ? performance.now() : undefined;
			const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)({
				...request,
				pageSize: 50
			}).pipe(Effect.mapError((cause) => failed("localization_export", cause)));
			const selection = { ...decoded, fields: [...new Set(fields)] };
			if (encodeStarted !== undefined)
				benchmark.publish({
					stage: "tsDomainEncode",
					action: "localization_export",
					ms: performance.now() - encodeStarted
				});
			const answer = yield* pinned.execute({
				action: "localization_export",
				reader: pinned.reader,
				request: selection
			});
			return yield* decodeRows(
				"localization_export",
				localizationLineViews(fields),
				lineRows(
					answer,
					fields.some((field) => field === "places")
				)
			);
		});
	const readUnits = Effect.fn("GameTextIndex.nativeUnits")(function* (
		pinned: Pinned,
		ids: readonly string[]
	) {
		const answer = yield* pinned.execute({
			action: "export",
			reader: pinned.reader,
			request: { query: "", capability: "all", pageSize: 50, units: ids }
		});
		const file = yield* decodeRows("units", NativeExportFile, corpusDocument(answer));
		return file.units.map(({ reviewSignals: _, ...unit }) => unit);
	});
	const readCorpusHeader = Effect.fn("GameTextIndex.nativeCorpusHeader")(function* (
		pinned: Pinned
	) {
		const answer = yield* pinned.execute({ action: "corpus_header", reader: pinned.reader });
		return yield* decodeRows("corpus_header", TextCorpusHeader, {
			...answerJson<Row>(answer),
			units: [],
			packageCoverage: answerRows(answer, "packages"),
			diagnostics: answerRows(answer, "diagnostics")
		});
	});
	const readCorpusReportHeader = (pinned: Pinned) =>
		response(
			pinned,
			{ action: "corpus_report_header", reader: pinned.reader },
			TextCorpusReportHeader
		);
	const corpusFingerprint = (pinned: Pinned) =>
		response(
			pinned,
			{ action: "corpus_fingerprint", reader: pinned.reader },
			Schema.Struct({ sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)) })
		).pipe(Effect.map((result) => result.sha256));
	const readLocalizationLines = Effect.fn("GameTextIndex.nativeLocalizationCorpus")(function* (
		pinned: Pinned
	) {
		const answer = yield* pinned.execute({
			action: "localization_corpus",
			reader: pinned.reader
		});
		return yield* decodeRows(
			"localization_corpus",
			Schema.Array(LocalizationLine),
			lineRows(answer, false)
		);
	});
	const reader = pinned.reader;
	/**
	 * A findings reply as the contract's type. The session's handshake checked the engine's
	 * contract, so the reply is parsed, not decoded.
	 */
	const engineReply = <T>(
		pinned: Pinned,
		request: GameTextContract.EngineRequest,
		progress?: EngineProgressObserver
	) =>
		Effect.gen(function* () {
			const reply = answerJson<T>(yield* pinned.execute(request, progress));
			if (reply === undefined)
				return yield* Effect.fail(failed(request.action, "The engine sent no reply."));
			return reply;
		});
	/**
	 * A findings page: its part, its findings, and the place sets they name. The handshake checked
	 * the engine's contract, so the reply is read, not decoded.
	 */
	const findingsPage = (pinned: Pinned, request: GameTextContract.FindingsQueryRequest) =>
		Effect.gen(function* () {
			const answer = yield* pinned.execute({ action: "findings_query", reader, request });
			const page = answerJson<GameTextContract.FindingsPage>(answer);
			if (page === undefined)
				return yield* Effect.fail(failed("findings_query", "The engine sent no reply."));
			const sets = new Map<number, Row[]>();
			for (const { parent, ...place } of answerRows(answer, "places")) {
				const set = Number(parent);
				const places = sets.get(set);
				if (places === undefined) sets.set(set, [place]);
				else places.push(place);
			}
			const findings = answerRows(answer, "findings").map(({ finding }) => finding);
			return { page, sets, findings };
		});
	const summary = Effect.fn("GameTextIndex.nativeSummary")(() =>
		response(pinned, { action: "summary", reader }, TextCorpusQuerySummary)
	);
	const search = Effect.fn("GameTextIndex.nativeSearch")(function* (
		request: TextCorpusSearchRequest
	) {
		const encodeStarted = benchmark.hasSubscribers ? performance.now() : undefined;
		const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)(request).pipe(
			Effect.mapError((cause) => failed("search", cause))
		);
		if (encodeStarted !== undefined)
			benchmark.publish({
				stage: "tsDomainEncode",
				action: "search",
				ms: performance.now() - encodeStarted
			});
		return yield* response(
			pinned,
			{ action: "search", reader, request: decoded },
			TextCorpusSearchPage
		);
	});
	const searchRows = Effect.fn("GameTextIndex.nativeSearchRows")(function* (
		request: TextCorpusSearchRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)(request).pipe(
			Effect.mapError((cause) => failed("search", cause))
		);
		return yield* response(
			pinned,
			{ action: "search", reader, request: { ...decoded, parts: ["rows"] } },
			TextCorpusRowsPage
		);
	});
	const focus = Effect.fn("GameTextIndex.nativeFocus")(function* (
		request: TextCorpusFocusRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextCorpusFocusRequest)(request).pipe(
			Effect.mapError((cause) => failed("focus", cause))
		);
		const result = yield* response(
			pinned,
			{ action: "focus", reader, request: decoded },
			Schema.NullOr(TextCorpusFocus)
		);
		return result ?? undefined;
	});
	const localizationFocus = Effect.fn("GameTextIndex.nativeLocalizationFocus")(function* (
		id: LocalizationLineId
	) {
		const answer = yield* execute({ action: "localization_focus_export", reader, line: id });
		const [line] = yield* decodeRows(
			"localization_focus",
			Schema.Array(LocalizationLine),
			lineRows(answer, false)
		);
		return line;
	});
	const localizationDetail = Effect.fn("GameTextIndex.nativeLocalizationDetail")(function* (
		request: LocalizationFocusRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(LocalizationFocusRequest)(request).pipe(
			Effect.mapError((cause) => failed("localization_detail", cause))
		);
		const result = yield* response(
			pinned,
			{ action: "localization_detail", reader, request: decoded },
			Schema.NullOr(LocalizationFocus)
		);
		return result ?? undefined;
	});
	const related = Effect.fn("GameTextIndex.nativeRelated")(function* (
		request: RelatedLinesRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(RelatedLinesRequest)(request).pipe(
			Effect.mapError((cause) => failed("related", cause))
		);
		const result = yield* response(
			pinned,
			{ action: "related", reader, request: decoded },
			Schema.NullOr(RelatedLines)
		);
		if (result)
			yield* Effect.annotateCurrentSpan({
				"game_text.related.same_key": result.sameKey.members.length,
				"game_text.related.same_text": result.sameText.members.length,
				"game_text.related.conflict": result.conflict?.members.length ?? 0,
				"game_text.related.key_change": result.keyChange?.members.length ?? 0
			});
		return result ?? undefined;
	});
	const exported = (request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize"> | undefined) =>
		exportWithSignals(pinned, request);
	const model: NativeTextQuery = {
		findingsEvaluate: Effect.fn("GameText.native.findingsEvaluate")(
			function* (document, progress) {
				const requestStart = yield* Clock.currentTimeNanos;
				return yield* engineReply<GameTextContract.FindingsEvaluation>(
					pinned,
					{
						action: "findings_evaluate",
						reader,
						// The rule program travels inline; the engine reads it WTF-8-aware.
						rules: enabledRuleDocument(document),
						collationLocale: new Intl.Collator().resolvedOptions().locale
					},
					progress
				).pipe(
					Effect.tap((result) => annotateFindingsProfile(result.profile, requestStart))
				);
			}
		),
		findingsAccept: Effect.fn("GameText.native.findingsAccept")(function* (key, accepted) {
			// Larger reviews go in chunks, each naming the set it adds to.
			let previous: string | undefined;
			for (let start = 0; start === 0 || start < accepted.length; start += 5000) {
				const reply = yield* engineReply<{ readonly acceptance: string }>(pinned, {
					action: "findings_accept",
					reader,
					request: {
						key,
						...(previous === undefined ? undefined : { previous }),
						accepted: accepted.slice(start, start + 5000)
					}
				}).pipe(Effect.mapError((cause) => failed("findings_accept", cause)));
				previous = reply.acceptance;
			}
			return previous!;
		}),
		rulesCheck: Effect.fn("GameText.native.rulesCheck")((document) =>
			engineReply<GameTextContract.RulesCheck>(pinned, {
				action: "rules_check",
				rules: enabledRuleDocument(document)
			}).pipe(Effect.mapError((cause) => failed("rules_check", cause)))
		),
		findingsQuery: Effect.fn("GameText.native.findingsQuery")((request) =>
			findingsPage(pinned, request).pipe(
				Effect.tap(({ page }) =>
					Effect.annotateCurrentSpan(
						Object.fromEntries(
							Object.entries(page.stages).map(([stage, ms]) => [
								`game_text.findings.query.stage_ms.${stage}`,
								ms
							])
						)
					)
				),
				Effect.tap(({ page }) => annotateFindingsProfile(page.profile)),
				Effect.flatMap(inflateFindingsPage),
				Effect.mapError((cause) => failed("findings_query", cause))
			)
		),
		summary,
		search,
		searchRows,
		focus,
		localizationFocus,
		localizationDetail,
		related,
		readCorpus: () => exported(undefined).pipe(Effect.map((result) => result.corpus)),
		readLocalizationLines: () => readLocalizationLines(pinned),
		localizationLines: (request) => localizationLines(pinned, request),
		exportWithSignals: exported,
		export: (request) => exported(request).pipe(Effect.map((result) => result.corpus)),
		aggregate: (request) => aggregate(pinned, request),
		selectLocalizationLines: (request, fields) =>
			selectLocalizationLines(pinned, request, fields),
		readCorpusHeader: () => readCorpusHeader(pinned),
		readCorpusReportHeader: () => readCorpusReportHeader(pinned),
		readUnits: (ids) => (ids.length === 0 ? Effect.succeed([]) : readUnits(pinned, ids)),
		corpusFingerprint: () => corpusFingerprint(pinned)
	};
	return model;
});
