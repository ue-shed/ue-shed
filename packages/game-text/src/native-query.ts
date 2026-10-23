import { mkdtemp, readFile, rm } from "node:fs/promises";
import { TextCorpusReportHeader } from "./corpus-summary.js";
import { join } from "node:path";
import { Clock, Effect, Exit, Fiber, Ref, Schema, Scope, Semaphore } from "effect";
import { MAX_PROTOCOL_PATH_BYTES, NativeGameTextEngineClient } from "@ue-shed/unreal-assets";
import type {
	GameTextContract,
	GameTextEngineOutcome,
	GameTextEngineRequest,
	GameTextIndexConfiguration
} from "@ue-shed/protocol";
import { GameTextIndexError } from "./index-contract.js";
import {
	TextCorpus,
	TextUnit,
	TextReviewSignal,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusQuerySummary,
	TextCorpusSearchPage,
	TextCorpusSearchRequest
} from "./schema.js";
import { LocalizationLine, type LocalizationLineId } from "./localization-schema.js";
import { LocalizationFocus, LocalizationFocusRequest } from "./localization-view.js";
import { TEXT_AUDIENCE_POLICY } from "./text-audience.js";
import {
	TextAggregate,
	TextAggregateRequest,
	TextCorpusHeader,
	localizationLineViews,
	type LocalizationLineField
} from "./index-reads.js";

import type { NativeTextQuery } from "./native-query-contract.js";
import { canonicalRuleDocument } from "./rules/translate.js";
import {
	annotateFindingsProfile,
	inflateFindingLines,
	inflateFindingUnits
} from "./native-findings.js";
export type { NativeTextQuery, NativeTextExport } from "./native-query-contract.js";

const NativeExportFile = Schema.Struct({
	...TextCorpus.fields,
	units: Schema.Array(
		Schema.Struct({ ...TextUnit.fields, reviewSignals: Schema.Array(TextReviewSignal) })
	)
});
interface NativeIndexReader extends NativeTextQuery {
	/** Internal row coordinates for a policy scan of this pinned native view. */
	readonly localizationRows: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => Effect.Effect<Uint32Array, GameTextIndexError>;
}

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

/** One native process and the reader of this model's snapshot pinned in it. */
interface Lane {
	readonly reader: string;
	readonly execute: (
		request: GameTextEngineRequest
	) => Effect.Effect<GameTextEngineOutcome, GameTextIndexError>;
}

/** Pin one native snapshot for the caller's scope, with no JavaScript query-engine fallback. */
export const openNativeTextQuery = Effect.fn("GameTextIndex.openNativeQuery")(function* (input: {
	readonly configuration: GameTextIndexConfiguration;
	readonly generation: string;
	readonly joinedKey: string;
	readonly audienceRules?: readonly string[];
	readonly onFailure?: Effect.Effect<void>;
	/**
	 * A second native process for bulk reads: corpus and localization dumps, exports and policy
	 * rows. Each native process answers one request at a time, so without it a dump holds every
	 * search, focus and summary until it finishes. The model opens this snapshot in it on the
	 * first bulk read and closes both with its scope. When the second process or its reader cannot
	 * open, bulk reads share the first process as before.
	 */
	readonly bulkEngine?: Effect.Effect<
		NativeGameTextEngineClient["Service"],
		unknown,
		Scope.Scope
	>;
}): Effect.fn.Return<
	NativeIndexReader,
	GameTextIndexError,
	NativeGameTextEngineClient | Scope.Scope
> {
	const engine = yield* NativeGameTextEngineClient;
	const modelScope = yield* Effect.scope;
	// Interactive reads and bulk reads queue separately, one at a time each.
	const reads = yield* Semaphore.make(1);
	const bulkReads = input.bulkEngine === undefined ? reads : yield* Semaphore.make(1);
	// An interrupted UI request must not abort the protocol process and discard this reader.
	// The model owns admitted reads and their staged files. Canceled queued work is skipped;
	// closing the model still interrupts its active read and terminates its native process.
	const scopedRead = <A>(lane: Semaphore.Semaphore, read: Effect.Effect<A, GameTextIndexError>) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				if (modelScope.state._tag === "Closed")
					return yield* Effect.fail(failed("read", "The native reader scope is closed."));
				const canceled = yield* Ref.make(false);
				const job = yield* lane
					.withPermits(1)(
						Effect.gen(function* () {
							if (yield* Ref.get(canceled)) return yield* Effect.interrupt;
							return yield* read;
						})
					)
					.pipe(
						Effect.forkIn(modelScope, {
							uninterruptible: false,
							startImmediately: false
						})
					);
				return yield* restore(Fiber.join(job)).pipe(
					Effect.onInterrupt(() => Ref.set(canceled, true))
				);
			})
		);
	const executeOn = (client: NativeGameTextEngineClient["Service"], invalidates = true) =>
		Effect.fn("GameTextIndex.nativeCall")((request: GameTextEngineRequest) =>
			client.execute(request).pipe(
				Effect.mapError((cause) => failed(request.action, cause)),
				Effect.tapError(() =>
					invalidates ? (input.onFailure ?? Effect.void) : Effect.void
				)
			)
		);
	/** Open this snapshot in one process, closing it with the model's scope. */
	const openReader = Effect.fn("GameTextIndex.nativeOpenReader")(function* (
		execute: Lane["execute"]
	) {
		const opened = yield* Effect.acquireRelease(
			execute({
				action: "open",
				configuration: input.configuration,
				expectedGeneration: input.generation,
				expectedJoined: input.joinedKey,
				policy: {
					audienceRules:
						input.audienceRules ?? TEXT_AUDIENCE_POLICY.map((rule) => rule.id)
				}
			}),
			(opened) =>
				opened.reader === null
					? Effect.void
					: execute({ action: "close", reader: opened.reader }).pipe(
							Effect.catch((cause) =>
								Effect.logDebug("Native Game Text reader cleanup failed", { cause })
							)
						),
			{ interruptible: true }
		);
		const reader = opened.reader;
		if (
			reader === null ||
			opened.generation !== input.generation ||
			opened.joinedKey !== input.joinedKey
		)
			return yield* Effect.fail(
				failed("open", "Native reader returned a different snapshot identity.")
			);
		return reader;
	});
	const execute = executeOn(engine);
	const interactive: Lane = { reader: yield* openReader(execute), execute };
	const bulkEngine = input.bulkEngine;
	// Opened once, on the first bulk read, inside the model's scope.
	const bulkLane: Effect.Effect<Lane> =
		bulkEngine === undefined
			? Effect.succeed(interactive)
			: yield* Effect.cached(
					Effect.gen(function* () {
						const laneScope = yield* Scope.fork(modelScope);
						return yield* Effect.gen(function* () {
							const client = yield* bulkEngine;
							// Failing to open here (a newer snapshot was published, no process) only
							// keeps bulk reads on the interactive reader; this model stays valid.
							const reader = yield* openReader(executeOn(client, false));
							return { reader, execute: executeOn(client) } satisfies Lane;
						}).pipe(
							Effect.provideService(Scope.Scope, laneScope),
							Effect.onExit((exit) =>
								Exit.isFailure(exit) ? Scope.close(laneScope, exit) : Effect.void
							)
						);
					}).pipe(
						Effect.provideService(Scope.Scope, modelScope),
						// oxlint-disable-next-line anti-slop/no-effect-catch-all -- Any failure to open a second lane leaves the first serving every read, as before.
						Effect.catch((cause) =>
							Effect.logWarning(
								"Native Game Text bulk reads share the interactive reader",
								{ cause }
							).pipe(Effect.as(interactive))
						)
					)
				);
	function response<S extends Schema.Codec<unknown, unknown>>(
		lane: Lane,
		request: GameTextEngineRequest,
		schema: S
	): Effect.Effect<S["Type"], GameTextIndexError> {
		return Effect.gen(function* () {
			const outcome = yield* lane.execute(request);
			const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
				outcome.payload
			);
			return yield* Schema.decodeUnknownEffect(schema)(parsed);
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
		(lane: Lane, request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">) =>
			withStage((directory) =>
				Effect.gen(function* () {
					const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)({
						...request,
						pageSize: 50
					}).pipe(Effect.mapError((cause) => failed("localization_export", cause)));
					const output = join(directory, "localization.json");
					yield* lane.execute({
						action: "localization_export",
						reader: lane.reader,
						payload: JSON.stringify(decoded),
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
		lane: Lane,
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
				yield* lane.execute(
					request === undefined
						? { action: "corpus", reader: lane.reader, output }
						: {
								action: "export",
								reader: lane.reader,
								payload: JSON.stringify(decoded),
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
				return {
					corpus: {
						...file,
						units: file.units.map(({ reviewSignals: _, ...unit }) => unit)
					},
					reviewSignals: new Map(file.units.map((unit) => [unit.id, unit.reviewSignals]))
				};
			})
		);
	});
	const fileRead = <A>(
		lane: Lane,
		operation: string,
		request: (output: string) => GameTextEngineRequest,
		schema: Schema.Codec<A, unknown>
	) =>
		withStage((directory) =>
			Effect.gen(function* () {
				const output = join(directory, `${operation}.json`);
				yield* lane.execute(request(output));
				const text = yield* Effect.tryPromise({
					try: (signal) => readFile(output, { encoding: "utf8", signal }),
					catch: (cause) => failed(`${operation}_read`, cause)
				});
				return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
					Effect.mapError((cause) => failed(`${operation}_decode`, cause))
				);
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
		lane: Lane,
		request: TextAggregateRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextAggregateRequest)(request).pipe(
			Effect.mapError((cause) => failed("aggregate", cause))
		);
		const native = yield* fileRead(
			lane,
			"aggregate",
			(output) => ({
				action: "aggregate",
				reader: lane.reader,
				payload: JSON.stringify(decoded),
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
		lane: Lane,
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">,
		fields: readonly F[]
	) =>
		Effect.gen(function* () {
			const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)({
				...request,
				pageSize: 50
			}).pipe(Effect.mapError((cause) => failed("localization_export", cause)));
			return yield* fileRead(
				lane,
				"localization_export",
				(output) => ({
					action: "localization_export",
					reader: lane.reader,
					payload: JSON.stringify({ ...decoded, fields: [...new Set(fields)] }),
					output
				}),
				localizationLineViews(fields)
			);
		});
	const readUnits = (lane: Lane, ids: readonly string[]) =>
		withStage((directory) =>
			Effect.gen(function* () {
				const output = join(directory, "units.json");
				yield* lane.execute({
					action: "export",
					reader: lane.reader,
					payload: JSON.stringify({
						query: "",
						capability: "all",
						pageSize: 50,
						units: ids
					}),
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
	const readCorpusHeader = (lane: Lane) =>
		fileRead(
			lane,
			"corpus_header",
			(output) => ({ action: "corpus_header", reader: lane.reader, output }),
			TextCorpusHeader
		);
	const readCorpusReportHeader = (lane: Lane) =>
		response(
			lane,
			{ action: "corpus_report_header", reader: lane.reader },
			TextCorpusReportHeader
		);
	const corpusFingerprint = (lane: Lane) =>
		response(
			lane,
			{ action: "corpus_fingerprint", reader: lane.reader },
			Schema.Struct({ sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)) })
		).pipe(Effect.map((result) => result.sha256));
	const readLocalizationLines = (lane: Lane) =>
		withStage((directory) =>
			Effect.gen(function* () {
				const output = join(directory, "localization.json");
				yield* lane.execute({ action: "localization_corpus", reader: lane.reader, output });
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
	const localizationRows = Effect.fn("GameTextIndex.nativePolicyRows")(
		(lane: Lane, request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">) =>
			withStage((directory) =>
				Effect.gen(function* () {
					const output = join(directory, "rows.u32");
					const result = yield* response(
						lane,
						{
							action: "rows",
							reader: lane.reader,
							output,
							payload: JSON.stringify({ ...request, pageSize: 50 })
						},
						Schema.Struct({
							count: Schema.Int.check(
								Schema.isGreaterThanOrEqualTo(0),
								Schema.isLessThanOrEqualTo(0xffffffff)
							)
						})
					);
					const bytes = yield* Effect.tryPromise({
						try: (signal) => readFile(output, { signal }),
						catch: (cause) => failed("policy_rows", cause)
					});
					if (bytes.length !== result.count * 4)
						return yield* Effect.fail(
							failed(
								"policy_rows",
								"Native row payload length differs from its declared count."
							)
						);
					const rows = new Uint32Array(result.count);
					for (let index = 0; index < rows.length; index++)
						rows[index] = bytes.readUInt32LE(index * 4);
					return rows;
				})
			)
	);
	const reader = interactive.reader;
	/**
	 * A findings reply as the contract's type. The session's handshake checked the engine's
	 * contract, so the reply is parsed, not decoded.
	 */
	const engineReply = <T>(lane: Lane, request: GameTextEngineRequest) =>
		Effect.gen(function* () {
			const { payload } = yield* lane.execute(request);
			if (payload === null)
				return yield* Effect.fail(failed(request.action, "The engine sent no reply."));
			return yield* parseReply<T>(request.action, payload);
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
	const findingResponse = <T extends object>(lane: Lane, request: GameTextEngineRequest) =>
		Effect.gen(function* () {
			const reply = yield* engineReply<T | GameTextContract.SpilledReply>(lane, request);
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
		response(interactive, { action: "summary", reader }, TextCorpusQuerySummary)
	);
	const search = Effect.fn("GameTextIndex.nativeSearch")(function* (
		request: TextCorpusSearchRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)(request).pipe(
			Effect.mapError((cause) => failed("search", cause))
		);
		return yield* response(
			interactive,
			{ action: "search", reader, payload: JSON.stringify(decoded) },
			TextCorpusSearchPage
		);
	});
	const focus = Effect.fn("GameTextIndex.nativeFocus")(function* (
		request: TextCorpusFocusRequest
	) {
		const decoded = yield* Schema.decodeUnknownEffect(TextCorpusFocusRequest)(request).pipe(
			Effect.mapError((cause) => failed("focus", cause))
		);
		const result = yield* response(
			interactive,
			{ action: "focus", reader, payload: JSON.stringify(decoded) },
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
					payload: JSON.stringify(id),
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
			interactive,
			{ action: "localization_detail", reader, payload: JSON.stringify(decoded) },
			Schema.NullOr(LocalizationFocus)
		);
		return result ?? undefined;
	});
	/** A read on the bulk lane, which opens on first use. */
	const bulk = <A>(read: (lane: Lane) => Effect.Effect<A, GameTextIndexError>) =>
		scopedRead(bulkReads, Effect.flatMap(bulkLane, read));
	const exported = (request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize"> | undefined) =>
		bulk((lane) => exportWithSignals(lane, request));
	const model: NativeIndexReader = {
		findingsEvaluate: Effect.fn("GameText.native.findingsEvaluate")((document) =>
			bulk((lane) =>
				Effect.gen(function* () {
					// The rule program travels inline, as JSON text the engine reads WTF-8-aware.
					const rules = canonicalRuleDocument(document);
					const bytes = Buffer.byteLength(JSON.stringify(rules), "utf8");
					if (bytes > MAX_PROTOCOL_PATH_BYTES)
						return yield* Effect.fail(
							failed(
								"findings_rules",
								`The rule policy encodes to ${bytes} bytes; one evaluation request carries at most ${MAX_PROTOCOL_PATH_BYTES}.`
							)
						);
					const requestStart = yield* Clock.currentTimeNanos;
					return yield* engineReply<GameTextContract.FindingsEvaluation>(lane, {
						action: "findings_evaluate",
						reader: lane.reader,
						rules,
						collationLocale: new Intl.Collator().resolvedOptions().locale
					}).pipe(
						Effect.tap((result) =>
							annotateFindingsProfile(result.profile, requestStart)
						)
					);
				})
			)
		),
		findingsLines: Effect.fn("GameText.native.findingsLines")((key, rows) =>
			bulk((lane) =>
				findingResponse<GameTextContract.FindingLines>(lane, {
					action: "findings_lines",
					reader: lane.reader,
					key,
					rows
				}).pipe(
					Effect.tap((result) => annotateFindingsProfile(result.profile)),
					Effect.flatMap(inflateFindingLines),
					Effect.mapError((cause) => failed("findings_lines", cause))
				)
			)
		),
		findingsUnits: Effect.fn("GameText.native.findingsUnits")((key, units) =>
			bulk((lane) =>
				findingResponse<GameTextContract.FindingUnits>(lane, {
					action: "findings_units",
					reader: lane.reader,
					key,
					units
				}).pipe(
					Effect.tap((result) => annotateFindingsProfile(result.profile)),
					Effect.flatMap(inflateFindingUnits),
					Effect.mapError((cause) => failed("findings_units", cause))
				)
			)
		),
		summary: () => scopedRead(reads, summary()),
		search: (request) => scopedRead(reads, search(request)),
		focus: (request) => scopedRead(reads, focus(request)),
		localizationFocus: (id) => scopedRead(reads, localizationFocus(id)),
		localizationDetail: (request) => scopedRead(reads, localizationDetail(request)),
		readCorpus: () => exported(undefined).pipe(Effect.map((result) => result.corpus)),
		readLocalizationLines: () => bulk(readLocalizationLines),
		localizationLines: (request) => bulk((lane) => localizationLines(lane, request)),
		localizationRows: (request) => bulk((lane) => localizationRows(lane, request)),
		exportWithSignals: exported,
		export: (request) => exported(request).pipe(Effect.map((result) => result.corpus)),
		aggregate: (request) => bulk((lane) => aggregate(lane, request)),
		selectLocalizationLines: (request, fields) =>
			bulk((lane) => selectLocalizationLines(lane, request, fields)),
		readCorpusHeader: () => bulk(readCorpusHeader),
		readCorpusReportHeader: () => bulk(readCorpusReportHeader),
		readUnits: (ids) =>
			ids.length === 0 ? Effect.succeed([]) : bulk((lane) => readUnits(lane, ids)),
		corpusFingerprint: () => bulk(corpusFingerprint)
	};
	return model;
});
