import * as stylex from "@stylexjs/stylex";
import {
	localizationStates,
	type LocalizationFocus,
	type LocalizationLinePreview,
	type LocalizationState,
	type LocalizationTranslation,
	type LocalizationUnknownReason
} from "@ue-shed/game-text/browser";
import { Button, Chip } from "@ue-shed/ui";
import { For, Show } from "solid-js";
import { CopyButton } from "./game-text-copy-button.js";
import { LocalizationPicker } from "./game-text-localization-picker.js";
import type { GameTextLocalizationState } from "./game-text-localization-state.js";
import { styles } from "./game-text-styles.js";
import { TranslationEditor, type GameTextEdits } from "./game-text-translation-edits.js";
import { ReviewControls } from "./game-text-review.js";
import { KeyChangeDetail } from "./game-text-key-changes.js";
import type { GameTextClientApi } from "./game-text-client.js";
import type { JSX } from "@solidjs/web";

export const localizationLabels = {
	translated: "Translated",
	not_translated: "Not translated",
	needs_update: "Needs update",
	not_synced: "Not synced",
	not_gathered: "Not gathered yet",
	changed_since_gather: "Changed since gather",
	not_found: "Not found in the project",
	gathered_only: "Gathered only",
	outside_target: "Outside this target",
	unknown: "Unknown"
} satisfies Record<LocalizationState, string>;
export const unknownLabels = {
	missing_manifest: "The gathered text file could not be read.",
	missing_archive: "The game's translation file could not be read.",
	missing_po: "The PO file could not be read.",
	duplicate_manifest_identity: "Several gathered entries have this key.",
	duplicate_archive_identity: "Several game translations have this key.",
	duplicate_po_identity: "Several PO translations have this key.",
	package_partial: "The saved asset was only partly read.",
	package_failed: "The saved asset could not be read.",
	package_not_scanned: "The saved asset has not been scanned.",
	unresolved_identity: "This line has no usable localization key.",
	string_table_namespace_unavailable: "The String Table's localization namespace is unavailable.",
	conflicting_source: "Several places use different source text for this key.",
	gather_settings_unavailable: "This target's gather settings are unavailable.",
	class_hierarchy_unavailable: "The asset's class ancestry is unavailable.",
	asset_class_unavailable: "The asset's class is unavailable.",
	path_not_project_relative: "The asset could not be placed inside the project.",
	ambiguous_po_identity: "The PO entry could not be matched to a single key."
} satisfies Record<LocalizationUnknownReason, string>;

const sourceStates: ReadonlySet<LocalizationState> = new Set([
	"not_gathered",
	"changed_since_gather",
	"not_found"
]);

function needsAttention(state: LocalizationState): boolean {
	return state !== "translated" && state !== "outside_target" && state !== "gathered_only";
}

function displayedState(detail: LocalizationFocus, translation: LocalizationTranslation) {
	return detail.scopeSummary ? translation.cultureState : translation.state;
}

function visibleTranslations(detail: LocalizationFocus) {
	return detail.translations.filter(
		(translation) =>
			!detail.scopeSummary ||
			!!translation.archiveTranslation ||
			translation.poTranslation !== null ||
			translation.translatorComments.length > 0 ||
			translation.flags.length > 0 ||
			translation.cultureState === "unknown" ||
			translation.reducedSourceChecking ||
			(translation.translationSource !== null &&
				translation.facts.includes("needs_update")) ||
			translation.nextContextOffset !== undefined
	);
}

export function LocalizationControls(props: {
	readonly model: GameTextLocalizationState;
	readonly disabled?: boolean;
	readonly syncAction?: JSX.Element;
}) {
	return (
		<>
			<Show when={props.model.targets().length > 1}>
				<LocalizationPicker
					label="Localization target"
					value={props.model.target() ?? "Choose target"}
					values={props.model.targets().map((target) => target.name)}
					disabled={props.disabled || (!props.model.ready() && !props.model.error())}
					onSelect={(value) => {
						const target = props.model.targets().find((item) => item.name === value);
						if (target) props.model.selectTarget(target.name);
					}}
				/>
			</Show>
			<Show when={props.model.active()}>
				{(active) => (
					<>
						<LocalizationPicker
							label="Culture"
							disabled={props.disabled === true}
							value={props.model.culture() ?? "All cultures"}
							values={["All cultures", ...active().target.cultures]}
							onSelect={(value) =>
								props.model.selectCulture(value === "All cultures" ? "" : value)
							}
						/>
						<Show when={active().notSynced > 0}>
							<span
								role="status"
								title="Translations saved in PO files that Unreal has not imported yet"
								{...stylex.attrs(styles.muted, styles.warning)}
							>
								{active().notSynced.toLocaleString()} not synced
							</span>
						</Show>
						{props.syncAction}
					</>
				)}
			</Show>
		</>
	);
}

export function LocalizationChips(props: {
	readonly model: GameTextLocalizationState;
	readonly counts: Readonly<Record<LocalizationState, number>> | undefined;
	readonly searching: boolean;
}) {
	return (
		<Show when={props.model.active()}>
			<For
				each={localizationStates.filter(
					(state) =>
						state !== "translated" &&
						(state === props.model.state() || (props.counts?.[state] ?? 0) > 0)
				)}
			>
				{(state) => (
					<Chip
						label={localizationLabels[state]}
						selected={props.model.state() === state}
						count={props.searching ? undefined : props.counts?.[state]}
						onClick={() =>
							props.model.setState(props.model.state() === state ? undefined : state)
						}
					/>
				)}
			</For>
		</Show>
	);
}

export function LocalizationRow(props: {
	readonly line: LocalizationLinePreview;
	readonly culture: string | undefined;
}) {
	const selected = () => props.line.cultures.find((mark) => mark.culture === props.culture);
	const attention = () => {
		const marks = props.line.cultures.filter(
			(mark) => needsAttention(mark.state) || mark.facts.includes("not_synced")
		);
		const shared = marks[0]?.state;
		// Gather and project states describe the line, not a culture: say them once.
		if (
			shared &&
			sourceStates.has(shared) &&
			marks.length === props.line.cultures.length &&
			marks.every((mark) => mark.state === shared && !mark.facts.includes("not_synced"))
		)
			return localizationLabels[shared].toLocaleLowerCase();
		return marks
			.map(
				(mark) =>
					mark.culture +
					" · " +
					(mark.facts.includes("not_synced")
						? "not synced"
						: localizationLabels[mark.state].toLocaleLowerCase())
			)
			.join(" · ");
	};
	return (
		<Show
			when={selected()}
			fallback={
				<Show when={!props.culture && attention()}>
					<span {...stylex.attrs(styles.context, styles.warning)}>{attention()}</span>
				</Show>
			}
		>
			{(mark) => (
				<Show
					when={
						mark().translation?.trim() ||
						needsAttention(mark().state) ||
						mark().facts.includes("not_synced")
					}
				>
					<span {...stylex.attrs(styles.context)}>
						<Show
							when={mark().translation?.trim()}
							fallback={
								<span
									{...stylex.attrs(
										styles.muted,
										needsAttention(mark().state) && styles.warning
									)}
								>
									{localizationLabels[mark().state]}
								</span>
							}
						>
							{mark().translation}
						</Show>
						<Show when={mark().facts.includes("not_synced")}>
							<span {...stylex.attrs(styles.warning)}> · Not synced</span>
						</Show>
						<Show
							when={
								mark().translation?.trim() &&
								mark().state !== "translated" &&
								mark().state !== "not_synced"
							}
						>
							<span
								{...stylex.attrs(
									styles.muted,
									needsAttention(mark().state) && styles.warning
								)}
							>
								{" "}
								· {localizationLabels[mark().state]}
							</span>
						</Show>
					</span>
				</Show>
			)}
		</Show>
	);
}

export { ReviewChips } from "./game-text-review.js";

export function TranslationsDetail(props: {
	readonly model: GameTextLocalizationState;
	readonly focus?: LocalizationFocus | undefined;
	readonly onMore?: (cultureOffset?: number, locationOffset?: number) => void;
	readonly onMoreContext?: (culture: LocalizationTranslation["culture"]) => void;
	readonly edits?: GameTextEdits;
	readonly review?: {
		readonly client: GameTextClientApi;
		readonly busy: boolean;
		readonly onChanged: () => void;
	};
}) {
	return (
		<Show when={props.model.active()}>
			<section aria-label="Translations" {...stylex.attrs(styles.detailSection)}>
				<h3 {...stylex.attrs(styles.section)}>Translations</h3>
				<Show
					when={props.focus || !props.model.detailLoading()}
					fallback={
						<span role="status" {...stylex.attrs(styles.muted)}>
							Loading translations…
						</span>
					}
				>
					<Show when={props.focus ?? props.model.detail()}>
						{(detail) => (
							<>
								<Show when={detail().scopeSummary}>
									{(summary) => (
										<p
											{...stylex.attrs(
												styles.muted,
												needsAttention(summary().state) && styles.warning
											)}
										>
											{summary().message}
										</p>
									)}
								</Show>
								<KeyChangeDetail detail={detail()} edits={props.edits} />
								<For each={visibleTranslations(detail())}>
									{(translation) => (
										<article
											aria-label={"Translation " + translation.culture}
											{...stylex.attrs(styles.card)}
										>
											<div {...stylex.attrs(styles.bar)}>
												<strong>{translation.culture}</strong>
												<Show when={displayedState(detail(), translation)}>
													{(state) => (
														<span
															{...stylex.attrs(
																styles.muted,
																needsAttention(state()) &&
																	styles.warning
															)}
														>
															{localizationLabels[state()]}
														</span>
													)}
												</Show>
												<Show
													when={
														displayedState(detail(), translation) !==
															"not_synced" &&
														translation.poTranslation !== null
													}
												>
													<span {...stylex.attrs(styles.warning)}>
														Not synced
													</span>
												</Show>
											</div>
											<Show when={translation.gameTextKind !== "unavailable"}>
												<span {...stylex.attrs(styles.muted)}>
													In the game
												</span>
												<p {...stylex.attrs(styles.notes)}>
													{translation.gameTranslation}
													{translation.gameTextKind === "source_outdated"
														? " (source text — the translation is out of date)"
														: translation.gameTextKind ===
															  "source_untranslated"
															? " (source text — not translated)"
															: ""}
												</p>
											</Show>
											<Show
												when={
													translation.archiveTranslation &&
													(translation.gameTextKind === "unavailable" ||
														translation.gameTextKind ===
															"source_outdated")
												}
											>
												<span {...stylex.attrs(styles.muted)}>
													{translation.facts.includes("needs_update")
														? "Translation (out of date)"
														: "Translation"}
												</span>
												<p {...stylex.attrs(styles.notes)}>
													{translation.archiveTranslation}
												</p>
											</Show>
											<Show when={translation.poTranslation !== null}>
												<span {...stylex.attrs(styles.warning)}>
													In PO, not synced
												</span>
												<p {...stylex.attrs(styles.notes)}>
													{translation.poTranslation}
												</p>
											</Show>
											<Show
												when={
													translation.translationSource &&
													(translation.translationSource !==
														detail().source ||
														translation.facts.includes("needs_update"))
												}
											>
												<span {...stylex.attrs(styles.muted)}>
													Written for this source
												</span>
												<p {...stylex.attrs(styles.notes)}>
													{translation.translationSource}
												</p>
											</Show>
											<For each={translation.translatorComments}>
												{(comment) => (
													<p {...stylex.attrs(styles.notes)}>{comment}</p>
												)}
											</For>
											<Show when={translation.flags.length}>
												<span {...stylex.attrs(styles.muted)}>
													PO flags: {translation.flags.join(", ")}
												</span>
											</Show>
											<Show
												when={translation.nextContextOffset !== undefined}
											>
												<Button
													size="compact"
													tone="quiet"
													onClick={() =>
														(
															props.onMoreContext ??
															props.model.moreContext
														)(translation.culture)
													}
												>
													Show more PO comments and flags
												</Button>
											</Show>
											<For each={translation.unknownReasons}>
												{(reason) => (
													<span {...stylex.attrs(styles.warning)}>
														{unknownLabels[reason]}
													</span>
												)}
											</For>
											<Show when={translation.reducedSourceChecking}>
												<span {...stylex.attrs(styles.muted)}>
													This PO format stores less source information.
												</span>
											</Show>
											<Show when={props.review}>
												{(review) => (
													<ReviewControls
														client={review().client}
														target={props.model.target()}
														detail={detail()}
														translation={translation}
														busy={review().busy}
														onChanged={review().onChanged}
													/>
												)}
											</Show>
											<Show when={props.edits}>
												{(edits) => (
													<TranslationEditor
														model={edits()}
														detail={detail()}
														translation={translation}
													/>
												)}
											</Show>
										</article>
									)}
								</For>
								<Show when={detail().nextCultureOffset !== undefined}>
									<Button
										size="compact"
										tone="quiet"
										onClick={() =>
											(props.onMore ?? props.model.more)(
												detail().nextCultureOffset
											)
										}
									>
										Show more cultures
									</Button>
								</Show>
								<Show when={detail().locations.length}>
									<span {...stylex.attrs(styles.muted)}>Manifest key path</span>
									<For each={detail().locations}>
										{(path) => (
											<code {...stylex.attrs(styles.mono)}>{path}</code>
										)}
									</For>
								</Show>
								<Show when={detail().nextLocationOffset !== undefined}>
									<Button
										size="compact"
										tone="quiet"
										onClick={() =>
											(props.onMore ?? props.model.more)(
												undefined,
												detail().nextLocationOffset
											)
										}
									>
										Show more gathered locations
									</Button>
								</Show>
							</>
						)}
					</Show>
				</Show>
			</section>
		</Show>
	);
}

export function GatheredDetail(props: { readonly focus: LocalizationFocus }) {
	return (
		<>
			<div {...stylex.attrs(styles.bar)}>
				<h2 {...stylex.attrs(styles.title)}>{props.focus.source}</h2>
				<CopyButton label="Copy text" value={props.focus.source} />
			</div>
			<Show when={props.focus.identity}>
				{(identity) => (
					<div {...stylex.attrs(styles.bar)}>
						<code {...stylex.attrs(styles.mono)}>
							{identity().namespace || "global"} · {identity().key}
						</code>
						<CopyButton
							label="Copy key"
							value={(identity().namespace || "global") + " · " + identity().key}
						/>
					</div>
				)}
			</Show>
			<h3 {...stylex.attrs(styles.section)}>Where it appears</h3>
			<span {...stylex.attrs(styles.muted)}>
				Gathered from source code or another non-asset file.
			</span>
			<For each={props.focus.locations}>
				{(path) => <code {...stylex.attrs(styles.mono)}>{path}</code>}
			</For>
			<Show
				when={props.focus.translatorNotes.length}
				fallback={<span {...stylex.attrs(styles.muted)}>No translator notes</span>}
			>
				<For each={props.focus.translatorNotes}>
					{(notes) => <p {...stylex.attrs(styles.notes)}>{notes}</p>}
				</For>
			</Show>
		</>
	);
}
