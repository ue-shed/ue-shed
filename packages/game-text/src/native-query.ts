import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, type Scope } from "effect";
import { NativeGameTextEngineClient } from "@ue-shed/unreal-assets";
import type { GameTextEngineRequest, GameTextIndexConfiguration } from "@ue-shed/protocol";
import { GameTextIndexError } from "./index-contract.js";
import {
	TextCorpus,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusQuerySummary,
	TextCorpusSearchPage,
	TextCorpusSearchRequest
} from "./schema.js";
import { LocalizationLine, LocalizationLineId } from "./localization-schema.js";
import { TEXT_AUDIENCE_POLICY } from "./text-audience.js";

/** Native queries are asynchronous process calls; this interface owns no query or column data. */
export interface NativeTextQuery {
	readonly summary: () => Effect.Effect<TextCorpusQuerySummary, GameTextIndexError>;
	readonly search: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusSearchPage, GameTextIndexError>;
	readonly focus: (
		request: TextCorpusFocusRequest
	) => Effect.Effect<TextCorpusFocus | undefined, GameTextIndexError>;
	readonly localizationFocus: (
		id: LocalizationLineId
	) => Effect.Effect<LocalizationLine | undefined, GameTextIndexError>;
	/** Explicit bulk read; interactive consumers use search and focus pages. */
	readonly localizationLines: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => Effect.Effect<readonly LocalizationLine[], GameTextIndexError>;
	/** Explicit bulk export, assembled and serialized by Rust before the host decodes it. */
	readonly export: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => Effect.Effect<TextCorpus, GameTextIndexError>;
}

const NativeLinePage = Schema.Struct({
	lines: Schema.Array(LocalizationLine).check(Schema.isMaxLength(50)),
	total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	nextCursor: Schema.optionalKey(LocalizationLineId)
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

/** Pin one native snapshot for the caller's scope, with no JavaScript query-engine fallback. */
export const openNativeTextQuery = Effect.fn("GameTextIndex.openNativeQuery")(function* (input: {
	readonly configuration: GameTextIndexConfiguration;
	readonly generation: string;
	readonly joinedKey: string;
}): Effect.fn.Return<
	NativeTextQuery,
	GameTextIndexError,
	NativeGameTextEngineClient | Scope.Scope
> {
	const engine = yield* NativeGameTextEngineClient;
	const execute = Effect.fn("GameTextIndex.nativeCall")((request: GameTextEngineRequest) =>
		engine.execute(request).pipe(Effect.mapError((cause) => failed(request.action, cause)))
	);
	const opened = yield* Effect.acquireRelease(
		execute({
			action: "open",
			configuration: input.configuration,
			expectedGeneration: input.generation,
			expectedJoined: input.joinedKey,
			policy: { audienceRules: TEXT_AUDIENCE_POLICY.map((rule) => rule.id) }
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
	function response<S extends Schema.Codec<unknown, unknown>>(
		request: GameTextEngineRequest,
		schema: S
	): Effect.Effect<S["Type"], GameTextIndexError> {
		return Effect.gen(function* () {
			const outcome = yield* execute(request);
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
	return {
		summary: Effect.fn("GameTextIndex.nativeSummary")(() =>
			response({ action: "summary", reader }, TextCorpusQuerySummary)
		),
		search: Effect.fn("GameTextIndex.nativeSearch")(function* (request) {
			const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)(
				request
			).pipe(Effect.mapError((cause) => failed("search", cause)));
			return yield* response(
				{ action: "search", reader, payload: JSON.stringify(decoded) },
				TextCorpusSearchPage
			);
		}),
		focus: Effect.fn("GameTextIndex.nativeFocus")(function* (request) {
			const decoded = yield* Schema.decodeUnknownEffect(TextCorpusFocusRequest)(request).pipe(
				Effect.mapError((cause) => failed("focus", cause))
			);
			const result = yield* response(
				{ action: "focus", reader, payload: JSON.stringify(decoded) },
				Schema.NullOr(TextCorpusFocus)
			);
			return result ?? undefined;
		}),
		localizationFocus: Effect.fn("GameTextIndex.nativeLocalizationFocus")(function* (id) {
			const result = yield* response(
				{ action: "localization_focus", reader, payload: JSON.stringify(id) },
				Schema.NullOr(LocalizationLine)
			);
			return result ?? undefined;
		}),
		localizationLines: Effect.fn("GameTextIndex.nativeLocalizationLines")(function* (request) {
			const lines: LocalizationLine[] = [];
			let cursor: LocalizationLineId | undefined;
			while (true) {
				const page = yield* response(
					{
						action: "localization_page",
						reader,
						payload: JSON.stringify({
							...request,
							pageSize: 50,
							localizationCursor: cursor
						})
					},
					NativeLinePage
				);
				lines.push(...page.lines);
				if (page.nextCursor === undefined) return lines;
				if (page.nextCursor === cursor)
					return yield* Effect.fail(
						failed("localization_page", "Native evidence pagination did not advance.")
					);
				cursor = page.nextCursor;
			}
		}),
		export: Effect.fn("GameTextIndex.nativeExport")(function* (request) {
			const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)({
				...request,
				pageSize: 50
			}).pipe(Effect.mapError((cause) => failed("export", cause)));
			return yield* Effect.scoped(
				Effect.gen(function* () {
					const stage = yield* Effect.acquireRelease(
						Effect.tryPromise({
							try: () =>
								mkdtemp(join(input.configuration.cacheRoot, "native-export-")),
							catch: (cause) => failed("export", cause)
						}),
						(stage) =>
							Effect.tryPromise({
								try: () => rm(stage, { recursive: true, force: true }),
								catch: (cause) => failed("export_cleanup", cause)
							}).pipe(
								Effect.catch((cause) =>
									Effect.logWarning("Native export cleanup failed", { cause })
								)
							)
					);
					const output = join(stage, "corpus.json");
					yield* execute({
						action: "export",
						reader,
						payload: JSON.stringify(decoded),
						output
					});
					const text = yield* Effect.tryPromise({
						try: (signal) => readFile(output, { encoding: "utf8", signal }),
						catch: (cause) => failed("export_read", cause)
					});
					return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TextCorpus))(
						text
					).pipe(Effect.mapError((cause) => failed("export_decode", cause)));
				})
			);
		})
	};
});
