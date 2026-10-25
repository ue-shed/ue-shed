import { channel } from "node:diagnostics_channel";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Effect, Schema, type Scope } from "effect";
import { answerJson, type EngineAnswer, NativeGameTextEngineClient } from "@ue-shed/unreal-assets";
import type { GameTextContract, GameTextIndexConfiguration } from "@ue-shed/protocol";
import { GameTextIndexError } from "./index-contract.js";
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
		request: GameTextContract.EngineRequest
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
		(request: GameTextContract.EngineRequest) =>
			engine.execute(request).pipe(
				Effect.mapError((cause) => failed(request.action, cause)),
				Effect.tapError(() => input.onFailure ?? Effect.void)
			)
	);
	// The reader closes with the model's scope.
	const opened = yield* Effect.acquireRelease(
		execute({
			action: "open",
			configuration: input.configuration,
			expectedGeneration: input.generation,
			expectedJoined: input.joinedKey,
			policy: {
				audienceRules: input.audienceRules ?? TEXT_AUDIENCE_POLICY.map((rule) => rule.id)
			}
		}).pipe(Effect.map(answerJson<GameTextContract.OpenReply>)),
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
	const withStage = <A>(use: (directory: string) => Effect.Effect<A, GameTextIndexError>) =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* Effect.acquireRelease(
					Effect.tryPromise({
						try: () => mkdtemp(join(input.configuration.cacheRoot, "native-read-")),
						catch: (cause) => failed("staging", cause)
					}),
					(directory) =>
						Effect.tryPromise({
							try: () => rm(directory, { recursive: true, force: true }),
							catch: (cause) => failed("staging_cleanup", cause)
						}).pipe(
							Effect.catch((cause) =>
								Effect.logWarning("Native read staging cleanup failed", { cause })
							)
						)
				);
				return yield* use(directory);
			})
		);
	const localizationLines = Effect.fn("GameTextIndex.nativeLocalizationExport")(
		(pinned: Pinned, request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">) =>
			withStage((directory) =>
				Effect.gen(function* () {
					const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)({
						...request,
						pageSize: 50
					}).pipe(Effect.mapError((cause) => failed("localization_export", cause)));
					const output = join(directory, "localization.json");
					yield* pinned.execute({
						action: "localization_export",
						reader: pinned.reader,
						request: decoded,
						output
					});
					const text = yield* Effect.tryPromise({
						try: (signal) => readFile(output, { encoding: "utf8", signal }),
						catch: (cause) => failed("localization_export_read", cause)
					});
					return yield* Schema.decodeUnknownEffect(
						Schema.fromJsonString(Schema.Array(LocalizationLine))
					)(text).pipe(
						Effect.mapError((cause) => failed("localization_export_decode", cause))
					);
				})
			)
	);
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
		return yield* withStage((directory) =>
			Effect.gen(function* () {
				const output = join(directory, "corpus.json");
				yield* pinned.execute(
					request === undefined
						? { action: "corpus", reader: pinned.reader, output }
						: {
								action: "export",
								reader: pinned.reader,
								request: decoded,
								output
							}
				);
				const text = yield* Effect.tryPromise({
					try: (signal) => readFile(output, { encoding: "utf8", signal }),
					catch: (cause) => failed("export_read", cause)
				});
				const file = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(NativeExportFile)
				)(text).pipe(Effect.mapError((cause) => failed("export_decode", cause)));
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
									labels: new Map(
										findingRules.map((rule) => [rule.id, rule.label])
									),
									units: new Map(
										file.units.map((unit) => [unit.id, unit.findings ?? []])
									)
								}
							}
						: undefined)
				};
			})
		);
	});
	const fileRead = <A>(
		pinned: Pinned,
		operation: string,
		request: (output: string) => GameTextContract.EngineRequest,
		schema: Schema.Codec<A, unknown>
	) =>
		withStage((directory) =>
			Effect.gen(function* () {
				const output = join(directory, `${operation}.json`);
				yield* pinned.execute(request(output));
				const readStarted = benchmark.hasSubscribers ? performance.now() : undefined;
				const text = yield* Effect.tryPromise({
					try: (signal) => readFile(output, { encoding: "utf8", signal }),
					catch: (cause) => {
						if (readStarted !== undefined)
							benchmark.publish({
								stage: "tsBulkRead",
								action: operation,
								ms: performance.now() - readStarted
							});
						return failed(`${operation}_read`, cause);
					}
				});
				if (readStarted !== undefined)
					benchmark.publish({
						stage: "tsBulkRead",
						action: operation,
						ms: performance.now() - readStarted
					});
				const decodeStarted = benchmark.hasSubscribers ? performance.now() : undefined;
				const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
					text
				).pipe(
					Effect.mapError((cause) => {
						if (decodeStarted !== undefined)
							benchmark.publish({
								stage: "tsPayloadDecode",
								action: operation,
								ms: performance.now() - decodeStarted
							});
						return failed(`${operation}_decode`, cause);
					})
				);
				if (decodeStarted !== undefined)
					benchmark.publish({
						stage: "tsPayloadDecode",
						action: operation,
						ms: performance.now() - decodeStarted
					});
				return value;
			})
		);
	const NativeAggregate = Schema.Struct({
		lines: Schema.Number,
		groups: Schema.Array(
			Schema.Struct({
				key: Schema.Array(
					Schema.Union([
						Schema.String,
						Schema.Boolean,
						Schema.Null,
						Schema.Tuple([Schema.String, Schema.String])
					])
				),
				lines: Schema.Number,
				sourceWords: Schema.optionalKey(Schema.Number),
				lineBreakWords: Schema.optionalKey(Schema.Number),
				unknownWords: Schema.optionalKey(Schema.Number)
			})
		)
	});
	const aggregate = Effect.fn("GameTextIndex.nativeAggregate")(function* (
		pinned: Pinned,
		request: TextAggregateRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextAggregateRequest)(request).pipe(
			Effect.mapError((cause) => failed("aggregate", cause))
		);
		const native = yield* fileRead(
			pinned,
			"aggregate",
			(output) => ({
				action: "aggregate",
				reader: pinned.reader,
				request: decoded,
				output
			}),
			NativeAggregate
		);
		// Key components read as strings: a translation key as JSON.stringify([namespace, key]).
		return yield* Schema.decodeUnknownEffect(TextAggregate)({
			lines: native.lines,
			groups: native.groups.map((group) => ({
				...group,
				key: group.key.map((value) =>
					value === null
						? ""
						: value === true || value === false
							? String(value)
							: Array.isArray(value)
								? JSON.stringify(value)
								: value
				)
			}))
		}).pipe(Effect.mapError((cause) => failed("aggregate_decode", cause)));
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
			return yield* fileRead(
				pinned,
				"localization_export",
				(output) => ({
					action: "localization_export",
					reader: pinned.reader,
					request: selection,
					output
				}),
				localizationLineViews(fields)
			);
		});
	const readUnits = (pinned: Pinned, ids: readonly string[]) =>
		withStage((directory) =>
			Effect.gen(function* () {
				const output = join(directory, "units.json");
				yield* pinned.execute({
					action: "export",
					reader: pinned.reader,
					request: { query: "", capability: "all", pageSize: 50, units: ids },
					output
				});
				const text = yield* Effect.tryPromise({
					try: (signal) => readFile(output, { encoding: "utf8", signal }),
					catch: (cause) => failed("units_read", cause)
				});
				const file = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(NativeExportFile)
				)(text).pipe(Effect.mapError((cause) => failed("units_decode", cause)));
				return file.units.map(({ reviewSignals: _, ...unit }) => unit);
			})
		);
	const readCorpusHeader = (pinned: Pinned) =>
		fileRead(
			pinned,
			"corpus_header",
			(output) => ({ action: "corpus_header", reader: pinned.reader, output }),
			TextCorpusHeader
		);
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
	const readLocalizationLines = (pinned: Pinned) =>
		withStage((directory) =>
			Effect.gen(function* () {
				const output = join(directory, "localization.json");
				yield* pinned.execute({
					action: "localization_corpus",
					reader: pinned.reader,
					output
				});
				const text = yield* Effect.tryPromise({
					try: (signal) => readFile(output, { encoding: "utf8", signal }),
					catch: (cause) => failed("localization_corpus_read", cause)
				});
				return yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Array(LocalizationLine))
				)(text).pipe(
					Effect.mapError((cause) => failed("localization_corpus_decode", cause))
				);
			})
		);
	const reader = pinned.reader;
	/**
	 * A findings reply as the contract's type. The session's handshake checked the engine's
	 * contract, so the reply is parsed, not decoded.
	 */
	const engineReply = <T>(pinned: Pinned, request: GameTextContract.EngineRequest) =>
		Effect.gen(function* () {
			const reply = answerJson<T>(yield* pinned.execute(request));
			if (reply === undefined)
				return yield* Effect.fail(failed(request.action, "The engine sent no reply."));
			return reply;
		});
	const parseReply = <T>(operation: string, text: string) =>
		Effect.try({
			// SAFETY: the engine serializes this reply from the contract type T; the handshake
			// checked that host and engine were built against the same contract.
			// Verified by: the Rust contract test regenerates these types from the reply structs.
			try: (): T => JSON.parse(text),
			catch: (cause) => failed(operation, cause)
		});
	/** A bounded findings read, which the engine spills to a file past one frame. */
	const findingResponse = <T extends object>(
		pinned: Pinned,
		request: GameTextContract.EngineRequest
	) =>
		Effect.gen(function* () {
			const reply = yield* engineReply<T | GameTextContract.SpilledReply>(pinned, request);
			if (!("file" in reply)) return reply;
			return yield* Effect.acquireUseRelease(
				Effect.succeed(reply.file),
				(file) =>
					Effect.tryPromise({
						try: (signal) => readFile(file, { encoding: "utf8", signal }),
						catch: (cause) => failed("findings_read", cause)
					}).pipe(Effect.flatMap((text) => parseReply<T>("findings_decode", text))),
				(file) =>
					Effect.tryPromise({
						try: () => rm(file, { force: true }),
						catch: (cause) => failed("findings_cleanup", cause)
					}).pipe(
						Effect.catch((cause) =>
							Effect.logWarning("Native finding file cleanup failed", { cause })
						)
					)
			);
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
		return yield* withStage((directory) =>
			Effect.gen(function* () {
				const output = join(directory, "line.json");
				yield* execute({
					action: "localization_focus_export",
					reader,
					line: id,
					output
				});
				const text = yield* Effect.tryPromise({
					try: (signal) => readFile(output, { encoding: "utf8", signal }),
					catch: (cause) => failed("localization_focus_read", cause)
				});
				const line = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.NullOr(LocalizationLine))
				)(text).pipe(
					Effect.mapError((cause) => failed("localization_focus_decode", cause))
				);
				return line ?? undefined;
			})
		);
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
		findingsEvaluate: Effect.fn("GameText.native.findingsEvaluate")(function* (document) {
			const requestStart = yield* Clock.currentTimeNanos;
			return yield* engineReply<GameTextContract.FindingsEvaluation>(pinned, {
				action: "findings_evaluate",
				reader,
				// The rule program travels inline; the engine reads it WTF-8-aware.
				rules: enabledRuleDocument(document),
				collationLocale: new Intl.Collator().resolvedOptions().locale
			}).pipe(Effect.tap((result) => annotateFindingsProfile(result.profile, requestStart)));
		}),
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
			findingResponse<GameTextContract.FindingsPage>(pinned, {
				action: "findings_query",
				reader,
				request
			}).pipe(
				Effect.tap((result) =>
					Effect.annotateCurrentSpan(
						Object.fromEntries(
							Object.entries(result.stages).map(([stage, ms]) => [
								`game_text.findings.query.stage_ms.${stage}`,
								ms
							])
						)
					)
				),
				Effect.tap((result) => annotateFindingsProfile(result.profile)),
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
