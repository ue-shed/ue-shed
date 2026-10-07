import {
	MAX_LOCALIZATION_CULTURES,
	joinLocalizationTarget,
	localizationFocusPage,
	textCorpusQuery,
	type LocalizationFocusRequest,
	type LocalizationFocusResult,
	type LocalizationJoin,
	type LocalizationTargetResult,
	type LocalizationTargetsResult,
	type TextCorpus,
	type TextCorpusQuery,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult
} from "@ue-shed/game-text";
import { LocalizationEvidence, type LocalizationTarget } from "@ue-shed/localization";
import { Effect, Ref, Result } from "effect";

function failure(code: string) {
	return {
		status: "failed" as const,
		code,
		message: "Localization files could not be loaded.",
		recovery: "Check the project's localization settings and files, then rescan."
	};
}

/** The retained corpus reference is also the scan revision: stale readers cannot publish results. */
export const makeGameTextLocalization = Effect.fn("Workbench.GameText.localization")(function* (
	currentCorpus: () => Effect.Effect<TextCorpus | undefined>,
	currentRoot: () => Effect.Effect<string | undefined>
) {
	const reader = yield* LocalizationEvidence;
	const discovery = yield* Ref.make<
		| {
				readonly corpus: TextCorpus;
				readonly targets: readonly LocalizationTarget[];
				readonly result: LocalizationTargetsResult;
		  }
		| undefined
	>(undefined);
	const selected = yield* Ref.make<
		| {
				readonly corpus: TextCorpus;
				readonly join: LocalizationJoin;
				readonly model: TextCorpusQuery;
				readonly result: LocalizationTargetResult;
		  }
		| undefined
	>(undefined);
	const revision = yield* Ref.make(0);

	const reset = Effect.fn("Workbench.GameText.localization.reset")(function* () {
		yield* Ref.update(revision, (value) => value + 1);
		yield* Ref.set(discovery, undefined);
		yield* Ref.set(selected, undefined);
	});
	const targets = Effect.fn("Workbench.GameText.localization.targets")(function* () {
		const corpus = yield* currentCorpus();
		const root = yield* currentRoot();
		if (!corpus || !root) return { status: "not_ready" as const };
		const cached = yield* Ref.get(discovery);
		if (cached?.corpus === corpus) return cached.result;
		const version = yield* Ref.get(revision);
		const discovered = yield* reader.discover({ projectRoot: root }).pipe(Effect.result);
		if ((yield* currentCorpus()) !== corpus || (yield* Ref.get(revision)) !== version)
			return { status: "not_ready" as const };
		if (Result.isFailure(discovered)) return failure(discovered.failure.code);
		const available = discovered.success.targets;
		if (
			available.length > 50 ||
			available.some((target) => target.cultures.length > MAX_LOCALIZATION_CULTURES)
		)
			return failure("bounds_exceeded");
		if (!available.length && discovered.success.diagnostics.length)
			return failure("discovery_incomplete");
		const result: LocalizationTargetsResult = {
			status: "ready",
			targets: available.map(({ name, nativeCulture, cultures }) => ({
				name,
				nativeCulture,
				cultures
			}))
		};
		yield* Ref.set(discovery, { corpus, targets: available, result });
		yield* Effect.annotateCurrentSpan({ targetCount: available.length });
		return result;
	});
	const select = Effect.fn("Workbench.GameText.localization.select")(function* (
		name: LocalizationJoin["target"]
	) {
		const corpus = yield* currentCorpus();
		const root = yield* currentRoot();
		if (!corpus || !root) return { status: "not_ready" as const };
		const cached = yield* Ref.get(selected);
		if (cached?.corpus === corpus && cached.join.target === name) return cached.result;
		const listed = yield* targets();
		if (listed.status !== "ready") return listed;
		const target = (yield* Ref.get(discovery))?.targets.find((item) => item.name === name);
		if (!target) return failure("target_not_found");
		const version = yield* Ref.updateAndGet(revision, (value) => value + 1);
		yield* Ref.set(selected, undefined);
		const evidence = yield* reader.read({ projectRoot: root, target }).pipe(Effect.result);
		if ((yield* currentCorpus()) !== corpus || (yield* Ref.get(revision)) !== version)
			return { status: "not_ready" as const };
		if (Result.isFailure(evidence)) return failure(evidence.failure.code);
		const join = joinLocalizationTarget(corpus, evidence.success);
		const model = textCorpusQuery(corpus, undefined, join);
		const baseline = model.search({
			query: "",
			capability: "all",
			lens: "all",
			withoutNotes: false,
			pageSize: 1,
			localization: { target: name }
		});
		const result: LocalizationTargetResult = {
			status: "ready",
			target: {
				name: target.name,
				nativeCulture: target.nativeCulture,
				cultures: target.cultures
			},
			lines: baseline.total,
			notSynced: baseline.localization?.notSynced ?? 0
		};
		yield* Ref.set(selected, { corpus, join, model, result });
		yield* Effect.annotateCurrentSpan({
			lineCount: baseline.total,
			notSyncedCount: result.notSynced
		});
		return result;
	});
	const current = Effect.fn("Workbench.GameText.localization.current")(function* (
		target: LocalizationJoin["target"]
	) {
		const cached = yield* Ref.get(selected);
		return cached && cached.corpus === (yield* currentCorpus()) && cached.join.target === target
			? cached
			: undefined;
	});
	const search = Effect.fn("Workbench.GameText.localization.search")(function* (
		request: TextCorpusSearchRequest
	): Effect.fn.Return<TextCorpusSearchResult> {
		if (!request.localization) return { status: "not_ready" };
		const cached = yield* current(request.localization.target);
		if (
			!cached ||
			(request.localization.culture &&
				!cached.join.cultures.includes(request.localization.culture))
		)
			return { status: "not_ready" };
		return { status: "ready", page: cached.model.search(request) };
	});
	const focus = Effect.fn("Workbench.GameText.localization.focus")(function* (
		request: LocalizationFocusRequest
	): Effect.fn.Return<LocalizationFocusResult> {
		const cached = yield* current(request.target);
		if (!cached) return { status: "not_ready" };
		const id =
			request.selection.kind === "line"
				? request.selection.id
				: cached.model.focus({ id: request.selection.id, pageSize: 1 })?.localization?.id;
		const line = id ? cached.model.localizationFocus(id) : undefined;
		return line
			? { status: "found", focus: localizationFocusPage(cached.join, line, request) }
			: { status: "not_found" };
	});
	return { reset, targets, select, search, focus };
});
