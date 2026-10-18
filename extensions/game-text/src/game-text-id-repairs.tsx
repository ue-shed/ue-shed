import * as stylex from "@stylexjs/stylex";
import {
	newTextIdKey,
	textIdConflictGroups,
	textIdNamespace,
	textIdRepairChanges,
	textIdRepairInstructions,
	textIdRepairSupport,
	textIdRepairEditLabel
} from "@ue-shed/game-text/checks";
import { LocalizationEdit, type LocalizationFocus } from "@ue-shed/game-text/corpus";
import type {
	LocalizationSelection,
	TextCorpusFocus,
	TextIdRepairChange,
	TextIdRepairPlan,
	TextIdRepairResult
} from "@ue-shed/game-text/schema";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect, Schema } from "effect";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import { failureText } from "./game-text-failure.js";
import { ShowInUnrealButton } from "./game-text-locate-button.js";
import { seenTranslation, type GameTextEdits } from "./game-text-translation-edits.js";
import { identityLabel } from "./game-text-view.js";

interface TranslationMove {
	readonly culture: string;
	readonly namespace: string;
	readonly key: string;
	readonly source: string;
	readonly translation: string;
	readonly seenTranslation: string | null;
}

interface PickedFix {
	readonly title: string;
	readonly changes: readonly TextIdRepairChange[];
	readonly translations: readonly TranslationMove[];
	readonly afterGather: boolean;
}

/** Conflict review and explicit repair approval, shared by every host of the Game Text extension. */
export function GameTextIdRepairs(props: {
	readonly focus: TextCorpusFocus;
	readonly detail: LocalizationFocus | undefined;
	readonly client: Pick<
		GameTextClientApi,
		"idRepairs" | "focus" | "search" | "localizationFocus" | "locateAsset"
	>;
	readonly projectKey: string | undefined;
	readonly target: LocalizationSelection["target"] | undefined;
	readonly nativeCulture: string | undefined;
	readonly edits: GameTextEdits;
	readonly busy: boolean;
	readonly onApplied: () => void;
}) {
	const action = createEffectAction();
	const relatedAction = createEffectAction();
	const [picked, setPicked] = createSignal<PickedFix>();
	const [plan, setPlan] = createSignal<TextIdRepairPlan>();
	const [receipt, setReceipt] =
		createSignal<Extract<TextIdRepairResult, { status: "finished" }>>();
	const [working, setWorking] = createSignal(false);
	const [message, setMessage] = createSignal<{
		readonly text: string;
		readonly failed: boolean;
	}>();
	const [locked, setLocked] = createSignal(false);
	const [related, setRelated] = createSignal<readonly TextCorpusFocus[]>();
	const [translations, setTranslations] = createSignal<readonly LocalizationFocus[]>([]);
	const [relatedLoading, setRelatedLoading] = createSignal(false);
	const [relatedError, setRelatedError] = createSignal<string>();
	const [choices, setChoices] = createSignal<Readonly<Record<string, string>>>({});
	const [survivor, setSurvivor] = createSignal<TextCorpusFocus>();
	let revision = 0;
	createEffect(
		() => [props.focus, props.target, props.projectKey] as const,
		() => {
			revision++;
			action.cancel();
			relatedAction.cancel();
			setPicked(undefined);
			setPlan(undefined);
			setReceipt(undefined);
			setWorking(false);
			setLocked(false);
			setRelated(undefined);
			setRelatedError(undefined);
			setRelatedLoading(false);
			setSurvivor(undefined);
			setMessage(undefined);
		}
	);
	const complete = () => props.focus.occurrences.length === props.focus.totalOccurrences;
	const translationsReady = () =>
		props.target === undefined ||
		(props.detail !== undefined && props.detail.nextCultureOffset === undefined);
	const groups = createMemo(() => textIdConflictGroups(props.focus));
	const isConflict = () => props.focus.unit.source.status === "conflicting";
	const duplicate = () => props.focus.unit.reviewSignals.includes("duplicate_source");
	const unsupported = () =>
		picked()?.changes.filter(
			(item) => textIdRepairSupport(item.occurrence, item.edit) !== undefined
		) ?? [];
	const choose = (fix: PickedFix) => {
		if (working() || locked()) return;
		setPicked(fix);
		setPlan(undefined);
		setMessage(undefined);
	};
	const split = (source: string, occurrences: TextCorpusFocus["occurrences"]) => {
		if (!translationsReady()) return;
		const key = newTextIdKey();
		const namespace = occurrences[0] ? textIdNamespace(occurrences[0]) : "";
		choose({
			title: `Give “${source}” its own key`,
			changes: textIdRepairChanges(props.focus.unit.id, occurrences, {
				kind: "change_key",
				namespace,
				key
			}),
			translations: (props.detail?.translations ?? []).flatMap((item) => {
				const translation = seenTranslation(item);
				return translation === null || item.culture === props.nativeCulture
					? []
					: [
							{
								culture: item.culture,
								namespace,
								key,
								source,
								translation,
								seenTranslation: null
							}
						];
			}),
			afterGather: true
		});
	};
	const useSource = (source: string) =>
		choose({
			title: `Use “${source}” at every place`,
			changes: textIdRepairChanges(
				props.focus.unit.id,
				props.focus.occurrences.filter((item) => item.source !== source),
				{ kind: "change_source", source }
			),
			translations: [],
			afterGather: false
		});
	const prepare = () => {
		const fix = picked();
		const client = props.client.idRepairs;
		const projectKey = props.projectKey;
		if (!fix || !client || !projectKey || working() || locked() || unsupported().length > 0)
			return;
		const generation = revision;
		setWorking(true);
		action.run(client.prepare({ projectKey, title: fix.title, changes: fix.changes }), {
			onSuccess: (result) => {
				if (generation !== revision) return;
				setWorking(false);
				if (result.status === "prepared") setPlan(result.plan);
				else if (result.status === "unavailable")
					setMessage({ text: `${result.message} ${result.recovery}`, failed: true });
			},
			onFailure: (cause) => {
				if (generation !== revision) return;
				setWorking(false);
				setMessage({
					text: failureText("Couldn’t preview this fix.", cause),
					failed: true
				});
			}
		});
	};
	const apply = () => {
		const current = plan();
		const fix = picked();
		const client = props.client.idRepairs;
		if (!current || !fix || !client || current.preview.status !== "ok" || working() || locked())
			return;
		const generation = revision;
		setWorking(true);
		setLocked(true);
		action.run(client.apply(current.id), {
			onSuccess: (result) => {
				if (generation !== revision) return;
				setWorking(false);
				if (result.status === "finished") {
					setReceipt(result);
					const ok = result.result.status === "ok" && result.verified;
					if (ok && fix.translations.length > 0) {
						props.edits.stageAll(
							fix.translations.map((item) => ({
								edit: Schema.decodeUnknownSync(LocalizationEdit)(item),
								source: item.source
							}))
						);
						props.edits.setOpen(true);
					}
					setMessage({
						failed: !ok,
						text: ok
							? `Unreal saved the fix and the saved files were verified.${fix.translations.length > 0 ? ` Staged ${fix.translations.length} translations${fix.afterGather ? "; run Gather and export before checking and writing them" : "; check and write them to the PO"}.` : " Run Gather and export to update localization."}`
							: [
									...result.result.errors.map(
										(error) => `${error.message} ${error.recovery}`
									),
									"Inspect the receipt, reconcile live and saved state, then rescan. This fix will not be replayed."
								].join(" ")
					});
					if (ok) setPlan(undefined);
				} else if (result.status === "unavailable")
					setMessage({ text: `${result.message} ${result.recovery}`, failed: true });
			},
			onFailure: (cause) => {
				if (generation !== revision) return;
				setWorking(false);
				setMessage({
					text: failureText(
						"The reply may have been lost. Inspect the editor and saved receipt before preparing another fix.",
						cause
					),
					failed: true
				});
			}
		});
	};
	const copy = () => {
		const fix = picked();
		if (!fix) return;
		action.run(
			Effect.tryPromise({
				try: () => navigator.clipboard.writeText(textIdRepairInstructions(fix.changes)),
				catch: String
			}),
			{
				onSuccess: () => setMessage({ text: "Instructions copied.", failed: false }),
				onFailure: () =>
					setMessage({ text: "Couldn’t copy the instructions.", failed: true })
			}
		);
	};
	const loadRelated = () => {
		const source = props.focus.unit.source;
		if (source.status !== "consistent" || relatedLoading()) return;
		const generation = revision;
		const target = props.target;
		setRelatedLoading(true);
		setRelatedError(undefined);
		relatedAction.run(
			Effect.gen(function* () {
				if (target && !props.client.localizationFocus)
					return {
						error: "This host cannot review translations. Open the target in a host with localization support before merging."
					};
				const result = yield* props.client.search({
					query: source.value.slice(0, 512),
					capability: "all",
					pageSize: 50
				});
				if (result.status !== "ready")
					return { error: "Matching keys are not available. Rescan and try again." };
				if (result.page.nextCursor)
					return {
						error: "Too many matches to review together. Narrow the text in Unreal or review the keys individually."
					};
				const units = result.page.units.filter(
					(unit) =>
						unit.source.status === "consistent" &&
						unit.source.value === source.value &&
						unit.identity.status === "resolved"
				);
				const focuses: TextCorpusFocus[] = [];
				const details: LocalizationFocus[] = [];
				for (const unit of units) {
					const found = yield* props.client.focus({ id: unit.id, pageSize: 50 });
					if (found.status !== "found" || found.focus.nextOccurrenceCursor)
						return {
							error: "Load every place before merging these keys. Review a smaller set in Unreal."
						};
					focuses.push(found.focus);
					if (target && props.client.localizationFocus) {
						const detail = yield* props.client.localizationFocus({
							target,
							selection: { kind: "unit", id: unit.id }
						});
						if (detail.status !== "found" || detail.focus.nextCultureOffset)
							return {
								error: "All translations must be available before merging. Open the target and retry."
							};
						details.push(detail.focus);
					}
				}
				return { focuses, details };
			}),
			{
				onSuccess: (result) => {
					if (generation !== revision) return;
					setRelatedLoading(false);
					if (result.error) setRelatedError(result.error);
					else {
						setRelated(result.focuses);
						setTranslations(result.details ?? []);
					}
				},
				onFailure: (cause) => {
					if (generation !== revision) return;
					setRelatedLoading(false);
					setRelatedError(failureText("Couldn’t compare these keys.", cause));
				}
			}
		);
	};
	const cultures = createMemo(() => {
		const values = new Map<string, Set<string>>();
		for (const detail of translations())
			for (const item of detail.translations) {
				const translation = seenTranslation(item);
				if (translation === null || item.culture === props.nativeCulture) continue;
				const options = values.get(item.culture) ?? new Set<string>();
				options.add(translation);
				values.set(item.culture, options);
			}
		return [...values].map(([culture, options]) => ({ culture, options: [...options] }));
	});
	const merge = () => {
		const keep = survivor();
		const identity = keep?.unit.identity;
		if (!keep || identity?.status !== "resolved") return;
		const detail = translations().find(
			(item) => item.origin.kind === "corpus" && item.origin.unitIds.includes(keep.unit.id)
		);
		const source = keep.unit.source;
		if (source.status !== "consistent") return;
		const namespace = keep.occurrences[0]
			? textIdNamespace(keep.occurrences[0])
			: identity.namespace;
		const changes = (related() ?? [])
			.filter((item) => item.unit.id !== keep.unit.id)
			.flatMap((item) =>
				textIdRepairChanges(item.unit.id, item.occurrences, {
					kind: "adopt_key",
					namespace,
					key: identity.key,
					source: source.value
				})
			);
		choose({
			title: `Merge into ${identityLabel(keep.unit)}`,
			changes,
			translations: cultures().flatMap(({ culture }) => {
				const translation = choices()[culture];
				const current = detail?.translations.find((item) => item.culture === culture);
				const seen = current ? seenTranslation(current) : null;
				return translation === undefined || translation === seen
					? []
					: [
							{
								culture,
								namespace,
								key: identity.key,
								source: source.value,
								translation,
								seenTranslation: seen
							}
						];
			}),
			afterGather: detail?.identity == null
		});
	};
	return (
		<Show when={isConflict() || duplicate()}>
			<section aria-label="Fix localization IDs" {...stylex.attrs(local.root)}>
				<Show when={isConflict()}>
					<h3 {...stylex.attrs(local.heading)}>Texts under this key</h3>
					<p {...stylex.attrs(local.muted)}>
						Choose the text to share, or give a text its own key. Compiled Blueprint
						copies stay with their authored place.
					</p>
					<Show when={!complete()}>
						<p role="note">Load the remaining places below before preparing a fix.</p>
					</Show>
					<Show when={!translationsReady()}>
						<p role="note">
							Load all cultures in the translations below before splitting this key,
							so every carried translation is included.
						</p>
					</Show>
					<For each={groups()}>
						{(group, index) => (
							<div
								role="group"
								aria-label={`Text ${String.fromCharCode(65 + index())}`}
								{...stylex.attrs(local.group)}
							>
								<div {...stylex.attrs(local.row)}>
									<strong>{String.fromCharCode(65 + index())}</strong>
									<p {...stylex.attrs(local.text)}>{group.source}</p>
								</div>
								<For each={group.occurrences}>
									{(place) => (
										<div {...stylex.attrs(local.place)}>
											<code>
												{place.packageFile} ·{" "}
												{place.location.kind === "string_table_entry"
													? place.location.entryKey
													: place.location.propertyPath}
											</code>
											<ShowInUnrealButton
												client={props.client}
												objectPath={place.location.objectPath}
											/>
											<Show when={textIdRepairSupport(place)}>
												{(reason) => <span>{reason()}</span>}
											</Show>
										</div>
									)}
								</For>
								<div {...stylex.attrs(local.row)}>
									<Button
										size="compact"
										disabled={
											!complete() || props.busy || working() || locked()
										}
										onClick={() => useSource(group.source)}
									>
										Use this text everywhere
									</Button>
									<Button
										size="compact"
										disabled={
											!complete() ||
											!translationsReady() ||
											props.busy ||
											working() ||
											locked()
										}
										onClick={() => split(group.source, group.occurrences)}
									>
										Give this text its own key
									</Button>
								</div>
							</div>
						)}
					</For>
				</Show>
				<Show when={duplicate() && !isConflict()}>
					<h3 {...stylex.attrs(local.heading)}>Keys holding this text</h3>
					<p {...stylex.attrs(local.muted)}>
						Compare places and translations, then choose which key to keep.
					</p>
					<Button
						size="compact"
						disabled={relatedLoading() || working() || props.busy || locked()}
						onClick={loadRelated}
					>
						{relatedLoading() ? "Comparing keys…" : "Compare matching keys"}
					</Button>
					<Show when={relatedError()}>{(error) => <p role="alert">{error()}</p>}</Show>
					<For each={related()}>
						{(key) => (
							<div {...stylex.attrs(local.group)}>
								<label>
									<input
										type="radio"
										name="surviving-text-key"
										checked={survivor()?.unit.id === key.unit.id}
										disabled={working() || locked()}
										onChange={() => {
											setSurvivor(key);
											setChoices({});
											setPicked(undefined);
											setPlan(undefined);
										}}
									/>{" "}
									Keep {identityLabel(key.unit)} · {key.totalOccurrences} places
								</label>
								<For each={key.occurrences}>
									{(place) => (
										<div {...stylex.attrs(local.place)}>
											<code>{place.packageFile}</code>
											<ShowInUnrealButton
												client={props.client}
												objectPath={place.location.objectPath}
											/>
										</div>
									)}
								</For>
							</div>
						)}
					</For>
					<Show when={survivor()}>
						<For each={cultures()}>
							{(culture) => (
								<label {...stylex.attrs(local.row)}>
									{culture.culture} translation
									<select
										aria-label={`${culture.culture} translation to keep`}
										value={choices()[culture.culture] ?? ""}
										disabled={working() || locked()}
										onChange={(event) => {
											setChoices({
												...choices(),
												[culture.culture]: event.currentTarget.value
											});
											setPicked(undefined);
											setPlan(undefined);
										}}
									>
										<option value="" disabled>
											Choose translation
										</option>
										<For each={culture.options}>
											{(option) => <option value={option}>{option}</option>}
										</For>
									</select>
								</label>
							)}
						</For>
						<Button
							size="compact"
							disabled={
								working() ||
								locked() ||
								(related()?.length ?? 0) < 2 ||
								cultures().some((item) => choices()[item.culture] === undefined)
							}
							onClick={merge}
						>
							Preview merge
						</Button>
					</Show>
				</Show>
				<Show when={picked()}>
					{(fix) => (
						<div
							role="group"
							aria-label="Picked ID fix"
							{...stylex.attrs(local.preview)}
						>
							<strong>{fix().title}</strong>
							<span>
								{fix().changes.length} places · {fix().translations.length}{" "}
								translations to stage
							</span>
							<Show when={fix().afterGather}>
								<p {...stylex.attrs(local.muted)}>
									The new key must be gathered before staged translations can be
									written. Review carried translations against the new text.
								</p>
							</Show>
							<For each={fix().changes}>
								{(change) => (
									<p {...stylex.attrs(local.mono)}>
										{change.occurrence.source} →{" "}
										{textIdRepairEditLabel(change.edit)}
									</p>
								)}
							</For>
							<Show when={unsupported().length > 0}>
								<p role="note">
									{unsupported().length} places need their own editor. Copy the
									steps to make this fix in Unreal.
								</p>
							</Show>
							<Show when={!props.client.idRepairs}>
								<p role="note">
									This host has not enabled ID repairs. Copy the steps to make the
									fix in Unreal.
								</p>
							</Show>
							<div {...stylex.attrs(local.row)}>
								<Button
									size="compact"
									disabled={
										working() ||
										locked() ||
										props.busy ||
										!props.client.idRepairs ||
										!props.projectKey ||
										unsupported().length > 0 ||
										fix().changes.length > 256
									}
									onClick={prepare}
								>
									Check in Unreal
								</Button>
								<Button size="compact" disabled={working()} onClick={copy}>
									Copy steps
								</Button>
								<Button
									size="compact"
									tone="quiet"
									disabled={working() || locked()}
									onClick={() => {
										setPicked(undefined);
										setPlan(undefined);
									}}
								>
									Cancel
								</Button>
							</div>
						</div>
					)}
				</Show>
				<Show when={plan()}>
					{(current) => (
						<div
							role="group"
							aria-label="Unreal ID fix preview"
							{...stylex.attrs(local.preview)}
						>
							<strong>Unreal preview: {current().preview.status}</strong>
							<For each={current().preview.errors}>
								{(error) => (
									<p role="alert">
										{error.message} {error.recovery}
									</p>
								)}
							</For>
							<For each={current().preview.packages}>
								{(item) => <code>{item.packageFile}</code>}
							</For>
							<p {...stylex.attrs(local.muted)}>
								Apply compiles the owning Blueprints and saves the listed packages.
								Proposal and receipt: {current().artifact}
							</p>
							<Button
								size="compact"
								tone="primary"
								disabled={
									current().preview.status !== "ok" ||
									working() ||
									locked() ||
									props.busy
								}
								onClick={apply}
							>
								{working() ? "Applying…" : "Apply and save in Unreal"}
							</Button>
						</div>
					)}
				</Show>
				<Show when={message()}>
					{(result) => <p role={result().failed ? "alert" : "status"}>{result().text}</p>}
				</Show>
				<Show when={receipt()}>
					{(saved) => (
						<div
							role="group"
							aria-label="Unreal ID repair receipt"
							{...stylex.attrs(local.preview)}
						>
							<strong>
								Saved-file verification:{" "}
								{saved().verified ? "passed" : "incomplete"}
							</strong>
							<For each={saved().result.packages}>
								{(item) => (
									<span>
										{item.persistence}: <code>{item.packageFile}</code>
									</span>
								)}
							</For>
							<For each={saved().result.blueprints}>
								{(item) => (
									<span>
										{item.compiled ? "Compiled" : "Not compiled"}:{" "}
										<code>{item.objectPath}</code>
									</span>
								)}
							</For>
							<code>{saved().plan.artifact}</code>
						</div>
					)}
				</Show>
				<Show when={locked() && !working()}>
					<Button size="compact" onClick={props.onApplied}>
						Rescan saved text
					</Button>
				</Show>
			</section>
		</Show>
	);
}

const local = stylex.create({
	root: { display: "flex", flexDirection: "column", gap: 10 },
	heading: { margin: 0, fontSize: 13, color: tokens.colorTextStrong },
	muted: { margin: 0, fontSize: 12, color: tokens.colorTextMuted },
	group: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		padding: 10,
		borderLeftWidth: 2,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorBorder,
		backgroundColor: tokens.colorSurfaceRaised,
		borderRadius: tokens.radiusControl
	},
	row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 },
	text: { margin: 0, flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
	place: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 6,
		color: tokens.colorTextMuted,
		fontSize: 11,
		overflowWrap: "anywhere"
	},
	preview: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		padding: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorAccent,
		borderRadius: tokens.radiusControl,
		overflowWrap: "anywhere"
	},
	mono: { margin: 0, fontFamily: tokens.fontMono, fontSize: 12, overflowWrap: "anywhere" }
});
