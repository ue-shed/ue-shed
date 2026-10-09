import type {
	LocalizationFocus,
	LocalizationFocusRequest,
	LocalizationSelection,
	LocalizationTargetPreview,
	LocalizationTargetResult,
	TextCorpusQuerySummary,
	TextUnitId
} from "@ue-shed/game-text/browser";
type CultureCode = NonNullable<LocalizationSelection["culture"]>;
import { createEffectAction } from "@ue-shed/ui";
import { createEffect, createSignal, latest, untrack } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import type { GameTextPreferences } from "./game-text-preferences.js";

export function createGameTextLocalizationState(props: {
	readonly client: GameTextClientApi;
	readonly initial: GameTextPreferences | undefined;
	readonly summary: () => TextCorpusQuerySummary | undefined;
	readonly selectedUnit: () => TextUnitId | undefined;
	readonly onPending: () => void;
}) {
	const supported = !!(
		props.client.localizationTargets &&
		props.client.localizationTarget &&
		props.client.localizationFocus
	);
	const [target, setTarget] = createSignal(props.initial?.localizationTarget);
	// The picked cultures; none means every culture. One picked culture also shows its
	// translations on each line and in the detail first.
	const [picked, setPicked] = createSignal<readonly CultureCode[]>(
		props.initial?.localizationCultures ??
			(props.initial?.localizationCulture ? [props.initial.localizationCulture] : [])
	);
	const [state, setState] = createSignal(props.initial?.localizationState);
	const [review, setReview] = createSignal(props.initial?.localizationReview);
	const [keyChanged, setKeyChanged] = createSignal(
		props.initial?.localizationKeyChanged ?? false
	);
	const [searchTranslations, setSearchTranslations] = createSignal(
		props.initial?.searchTranslations ?? false
	);
	const [selectedId, setSelectedId] = createSignal(props.initial?.selectedLocalizationId);
	const [targets, setTargets] = createSignal<readonly LocalizationTargetPreview[]>([]);
	const [active, setActive] =
		createSignal<Extract<LocalizationTargetResult, { status: "ready" }>>();
	const [ready, setReady] = createSignal(!supported);
	const [error, setError] = createSignal<string>();
	const [detail, setDetail] = createSignal<LocalizationFocus>();
	const [detailLoading, setDetailLoading] = createSignal(false);
	const listAction = createEffectAction();
	const targetAction = createEffectAction();
	const focusAction = createEffectAction();
	let generation = 0;
	let focusGeneration = 0;
	// A restore, such as opening a preset, can run in the same update as the load that follows it,
	// before the restored target commits; the load picks this target instead of the one before.
	let restoredTarget: { readonly name: LocalizationSelection["target"] | undefined } | undefined;
	// Restored cultures can outlive the target; only cultures it still has count, in its order, and
	// picking every culture is the same as picking none.
	const cultures = (): readonly CultureCode[] => {
		const available = active()?.target.cultures;
		const chosen = picked();
		if (!available) return chosen;
		const kept = available.filter((item) => chosen.includes(item));
		return kept.length === available.length ? [] : kept;
	};
	const culture = (): CultureCode | undefined => {
		const chosen = cultures();
		return chosen.length === 1 ? chosen[0] : undefined;
	};

	const selectTarget = (name: LocalizationSelection["target"]) => {
		const operation = props.client.localizationTarget?.(name);
		if (!operation) return;
		const version = ++generation;
		props.onPending();
		setReady(false);
		setActive(undefined);
		setDetail(undefined);
		setError(undefined);
		if (name !== untrack(() => latest(target))) setSelectedId(undefined);
		restoredTarget = undefined;
		setTarget(name);
		targetAction.run(operation, {
			onFailure: () => {
				if (version !== generation) return;
				setError("Translations could not be loaded. Rescan to try again.");
			},
			onSuccess: (result) => {
				if (version !== generation) return;
				if (result.status === "ready") {
					setActive(result);
					setPicked((remembered) =>
						remembered.filter((item) => result.target.cultures.includes(item))
					);
					setReady(true);
				} else if (result.status === "failed")
					setError(result.message + " " + result.recovery);
				else setError("Saved assets changed. Rescan to load translations.");
			}
		});
	};
	const load = () => {
		if (!supported) return;
		const operation = props.client.localizationTargets?.();
		if (!operation) return;
		const version = ++generation;
		props.onPending();
		setReady(false);
		setActive(undefined);
		setDetail(undefined);
		setError(undefined);
		targetAction.cancel();
		listAction.run(operation, {
			onFailure: () => {
				if (version === generation)
					setError("Localization targets could not be loaded. Rescan to try again.");
			},
			onSuccess: (result) => {
				if (version !== generation) return;
				if (result.status !== "ready") {
					setError(
						result.status === "failed"
							? result.message + " " + result.recovery
							: "Saved assets changed. Rescan to load translations."
					);
					return;
				}
				setTargets(result.targets);
				const rememberedTarget = restoredTarget
					? restoredTarget.name
					: untrack(() => latest(target));
				const chosen =
					result.targets.find((item) => item.name === rememberedTarget) ??
					result.targets[0];
				if (chosen) selectTarget(chosen.name);
				else {
					setTarget(undefined);
					setPicked([]);
					setState(undefined);
					setSelectedId(undefined);
					setReady(true);
				}
			}
		});
	};
	const selection = (): LocalizationSelection | undefined => {
		const current = active();
		// Restored signals can still be pending when target loading finishes; `cultures` keeps only
		// cultures the loaded target has, regardless of when the persisted value is cleared.
		const chosen = cultures();
		const selectedState = state();
		const selectedReview = review();
		if (!ready() || !current) return undefined;
		return {
			target: current.target.name,
			...(chosen.length === 1 ? { culture: chosen[0] } : undefined),
			...(chosen.length > 1 ? { cultures: chosen } : undefined),
			...(selectedState ? { state: selectedState } : undefined),
			...(selectedReview ? { review: selectedReview } : undefined),
			...(keyChanged() ? { keyChanged: true } : undefined),
			searchTranslations: chosen.length > 0 && searchTranslations()
		};
	};

	const requestFocus = (request: LocalizationFocusRequest) => {
		const operation = props.client.localizationFocus?.(request);
		if (!operation) return;
		const version = ++focusGeneration;
		setDetailLoading(true);
		focusAction.run(operation, {
			onFailure: () => {
				if (version !== focusGeneration) return;
				setDetailLoading(false);
				setError("Translations for this line could not be loaded. Rescan to try again.");
			},
			onSuccess: (result) => {
				if (version !== focusGeneration) return;
				setDetailLoading(false);
				if (result.status === "found")
					setDetail((previous) => {
						if (
							request.poContextOffset !== undefined &&
							previous?.id === result.focus.id
						) {
							const marks = new Map(
								result.focus.translations.map((mark) => [mark.culture, mark])
							);
							return {
								...previous,
								translations: previous.translations.map((mark) => {
									const update = marks.get(mark.culture);
									return update
										? {
												...update,
												translatorComments: [
													...mark.translatorComments,
													...update.translatorComments
												],
												flags: [...mark.flags, ...update.flags]
											}
										: mark;
								})
							};
						}
						const previousPage =
							previous?.id === result.focus.id &&
							(request.cultureOffset || request.locationOffset)
								? previous
								: undefined;
						const {
							nextCultureOffset: cultures,
							nextLocationOffset: locations,
							...rest
						} = result.focus;
						const nextCultureOffset =
							previousPage && request.locationOffset
								? previousPage.nextCultureOffset
								: cultures;
						const nextLocationOffset =
							previousPage && request.cultureOffset
								? previousPage.nextLocationOffset
								: locations;
						return {
							...rest,
							...(nextCultureOffset !== undefined
								? { nextCultureOffset }
								: undefined),
							...(nextLocationOffset !== undefined
								? { nextLocationOffset }
								: undefined),
							translations: previousPage
								? request.cultureOffset
									? [...previousPage.translations, ...result.focus.translations]
									: previousPage.translations
								: result.focus.translations,
							locations: previousPage
								? request.locationOffset
									? [...previousPage.locations, ...result.focus.locations]
									: previousPage.locations
								: result.focus.locations,
							translatorNotes:
								previousPage && request.locationOffset
									? [
											...new Set([
												...previousPage.translatorNotes,
												...result.focus.translatorNotes
											])
										]
									: previousPage
										? previousPage.translatorNotes
										: result.focus.translatorNotes
						};
					});
				else {
					setDetail(undefined);
					if (result.status === "not_found") setSelectedId(undefined);
				}
			}
		});
	};
	createEffect(
		() => ({
			ready: ready(),
			summary: props.summary(),
			target: active()?.target.name,
			id: selectedId(),
			unit: props.selectedUnit()
		}),
		({ ready: loaded, summary, target: name, id, unit }) => {
			focusGeneration++;
			focusAction.cancel();
			setDetail(undefined);
			setDetailLoading(false);
			if (!loaded || !summary || !name || (!id && !unit)) return;
			const selection: LocalizationFocusRequest["selection"] | undefined = id
				? { kind: "line", id }
				: unit
					? { kind: "unit", id: unit }
					: undefined;
			if (selection) requestFocus({ target: name, selection });
		}
	);
	return {
		target,
		culture,
		cultures,
		state,
		review,
		keyChanged,
		searchTranslations,
		selectedId,
		targets,
		active,
		ready,
		error,
		detail,
		detailLoading,
		selectTarget,
		setState,
		setReview,
		setKeyChanged,
		setSearchTranslations,
		setSelectedId,
		/** Picks only this culture; an unknown value, such as "All cultures", picks every culture. */
		selectCulture: (value: string) => {
			const found = untrack(active)?.target.cultures.find((item) => item === value);
			setPicked(found === undefined ? [] : [found]);
		},
		/** Adds or removes one culture from the picked cultures. */
		toggleCulture: (value: string) => {
			const found = untrack(active)?.target.cultures.find((item) => item === value);
			if (found === undefined) return;
			const current = untrack(cultures);
			setPicked(
				current.includes(found)
					? current.filter((item) => item !== found)
					: [...current, found]
			);
		},
		load,
		selection,
		more: (cultureOffset?: number, locationOffset?: number) => {
			const current = untrack(detail);
			const name = untrack(target);
			if (current && name)
				requestFocus({
					target: name,
					selection: { kind: "line", id: current.id },
					...(cultureOffset !== undefined ? { cultureOffset } : undefined),
					...(locationOffset !== undefined ? { locationOffset } : undefined)
				});
		},
		moreContext: (culture: LocalizationFocus["translations"][number]["culture"]) => {
			const current = untrack(detail);
			const name = untrack(target);
			const index = current?.translations.findIndex((mark) => mark.culture === culture) ?? -1;
			const offset = current?.translations[index]?.nextContextOffset;
			if (current && name && index >= 0 && offset !== undefined)
				requestFocus({
					target: name,
					selection: { kind: "line", id: current.id },
					cultureOffset: Math.floor(index / 50) * 50,
					poContextOffset: offset
				});
		},
		restore: (preferences: GameTextPreferences) => {
			restoredTarget = { name: preferences.localizationTarget };
			setTarget(preferences.localizationTarget);
			setPicked(
				preferences.localizationCultures ??
					(preferences.localizationCulture ? [preferences.localizationCulture] : [])
			);
			setState(preferences.localizationState);
			setReview(preferences.localizationReview);
			setKeyChanged(preferences.localizationKeyChanged ?? false);
			setSearchTranslations(preferences.searchTranslations ?? false);
			setSelectedId(preferences.selectedLocalizationId);
		}
	};
}

export type GameTextLocalizationState = ReturnType<typeof createGameTextLocalizationState>;
