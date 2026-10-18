import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, type Scope } from "effect";
import { NativeGameTextEngineClient } from "@ue-shed/unreal-assets";
import type { GameTextEngineRequest, GameTextIndexConfiguration } from "@ue-shed/protocol";
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
import { LocalizationLine } from "./localization-schema.js";
import { LocalizationFocus, LocalizationFocusRequest } from "./localization-view.js";
import { TEXT_AUDIENCE_POLICY } from "./text-audience.js";

import type { NativeTextQuery } from "./native-query-contract.js";
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

/** Pin one native snapshot for the caller's scope, with no JavaScript query-engine fallback. */
export const openNativeTextQuery = Effect.fn("GameTextIndex.openNativeQuery")(function* (input: {
	readonly configuration: GameTextIndexConfiguration;
	readonly generation: string;
	readonly joinedKey: string;
}): Effect.fn.Return<
	NativeIndexReader,
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
		(request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">) =>
			withStage((directory) =>
				Effect.gen(function* () {
					const decoded = yield* Schema.decodeUnknownEffect(TextCorpusSearchRequest)({
						...request,
						pageSize: 50
					}).pipe(Effect.mapError((cause) => failed("localization_export", cause)));
					const output = join(directory, "localization.json");
					yield* execute({
						action: "localization_export",
						reader,
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
				yield* execute(
					request === undefined
						? { action: "corpus", reader, output }
						: {
								action: "export",
								reader,
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

	return {
		readCorpus: () => exportWithSignals(undefined).pipe(Effect.map((result) => result.corpus)),
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
		}),
		localizationDetail: Effect.fn("GameTextIndex.nativeLocalizationDetail")(
			function* (request) {
				const decoded = yield* Schema.decodeUnknownEffect(LocalizationFocusRequest)(
					request
				).pipe(Effect.mapError((cause) => failed("localization_detail", cause)));
				const result = yield* response(
					{ action: "localization_detail", reader, payload: JSON.stringify(decoded) },
					Schema.NullOr(LocalizationFocus)
				);
				return result ?? undefined;
			}
		),
		localizationLines,
		localizationRows: Effect.fn("GameTextIndex.nativePolicyRows")((request) =>
			withStage((directory) =>
				Effect.gen(function* () {
					const output = join(directory, "rows.u32");
					const result = yield* response(
						{
							action: "rows",
							reader,
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
		),
		exportWithSignals,
		export: (request) => exportWithSignals(request).pipe(Effect.map((result) => result.corpus))
	};
});
