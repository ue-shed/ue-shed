import * as stylex from "@stylexjs/stylex";
import {
	explainLocalizationFile,
	type LocalizationFileProblem,
	type LocalizationFocus,
	type LocalizationTranslation
} from "@ue-shed/game-text/corpus";
import {
	localizationStates,
	type LocalizationLinePreview,
	type LocalizationState,
	type LocalizationUnknownReason,
	type TextCultureFacet
} from "@ue-shed/game-text/schema";
import { Button, Chip } from "@ue-shed/ui";
import { For, Show } from "solid-js";
import { CopyButton } from "./game-text-copy-button.js";
import { LocalizationPicker } from "./game-text-localization-picker.js";
import { CulturePicker } from "./game-text-culture-picker.js";
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
	missing_manifest: "The gathered text file is unavailable.",
	missing_archive: "The game's translation file is unavailable.",
	missing_po: "The PO file is unavailable.",
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
	ambiguous_po_identity: "The PO entry could not be matched to a single key.",
	string_table_entry_missing: "The referenced entry is missing from the String Table."
} satisfies Record<LocalizationUnknownReason, string>;

function reasonFileKind(
	reason: LocalizationUnknownReason
): LocalizationFileProblem["kind"] | undefined {
	if (reason === "missing_manifest") return "manifest";
	if (reason === "missing_archive") return "archive";
	return reason === "missing_po" ? "po" : undefined;
}

/** Names the missing or unreadable file behind a reason when the host reported the target's files. */
export function unknownReasonText(
	reason: LocalizationUnknownReason,
	culture: string,
	problems: readonly LocalizationFileProblem[] | undefined
): { readonly message: string; readonly recovery?: string } {
	const kind = reasonFileKind(reason);
	const file =
		kind === undefined
			? undefined
			: problems?.find(
					(item) =>
						item.kind === kind && (kind === "manifest" || item.culture === culture)
				);
	return file ? explainLocalizationFile(file) : { message: unknownLabels[reason] };
}

const sourceStates: ReadonlySet<LocalizationState> = new Set([
	"not_gathered",
	"changed_since_gather",
	"not_found"
]);

function needsAttention(state: LocalizationState): boolean {
	return state !== "translated" && state !== "outside_target" && state !== "gathered_only";
}

function localizationTone(state: LocalizationState) {
	if (state === "not_synced") return styles.accent;
	if (state === "not_translated") return styles.danger;
	if (["needs_update", "not_gathered", "changed_since_gather"].includes(state))
		return styles.warning;
	return styles.muted;
}

function displayedState(detail: LocalizationFocus, translation: LocalizationTranslation) {
	return detail.scopeSummary ? translation.cultureState : translation.state;
}

function visibleTranslations(detail: LocalizationFocus, culture: string | undefined) {
	return detail.translations
		.filter(
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
		)
		.toSorted(
			(left, right) => Number(right.culture === culture) - Number(left.culture === culture)
		);
}

const TARGET_TOOLTIP =
	"The localization target in this project: it decides which translations, PO files and Unreal steps are used.";

/** Which translations the workspace shows: the target, and the cultures picked within it. */
export function LocalizationControls(props: {
	readonly model: GameTextLocalizationState;
	readonly disabled?: boolean;
	/** Each culture's work over the current filters, for the culture picker. */
	readonly cultureWork?: readonly TextCultureFacet[] | undefined;
}) {
	return (
		<>
			<Show
				when={props.model.targets().length > 1}
				fallback={
					// A project with one target has nothing to choose, but still says which it is.
					<Show when={props.model.targets()[0]}>
						{(target) => (
							<span title={TARGET_TOOLTIP} {...stylex.attrs(styles.contextLabel)}>
								<span {...stylex.attrs(styles.muted)}>Target </span>
								{target().name}
							</span>
						)}
					</Show>
				}
			>
				<LocalizationPicker
					label="Localization target"
					prefix="Target"
					tooltip={TARGET_TOOLTIP}
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
					<CulturePicker
						disabled={props.disabled === true}
						cultures={active().target.cultures}
						picked={props.model.cultures()}
						work={props.cultureWork}
						onToggle={props.model.toggleCulture}
						onAll={() => props.model.selectCulture("")}
					/>
				)}
			</Show>
		</>
	);
}

/** Translations in PO files that Unreal has not imported yet, beside the action that syncs them. */
export function LocalizationSync(props: {
	readonly model: GameTextLocalizationState;
	readonly action?: JSX.Element;
}) {
	return (
		<Show when={props.model.active()}>
			{(active) => (
				<>
					<Show when={active().notSynced > 0}>
						<span
							role="status"
							title="Translations saved in PO files that Unreal has not imported yet"
							{...stylex.attrs(styles.muted, styles.accent)}
						>
							{active().notSynced.toLocaleString()} not synced
						</span>
					</Show>
					{props.action}
				</>
			)}
		</Show>
	);
}

export function LocalizationChips(props: {
	readonly model: GameTextLocalizationState;
	readonly counts: Readonly<Record<LocalizationState, number>> | undefined;
	readonly searching: boolean;
	/** Only these states; every state but translated when absent. */
	readonly states?: readonly LocalizationState[];
}) {
	return (
		<Show when={props.model.active()}>
			<For
				each={(props.states ?? localizationStates).filter(
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
	// Without a picked culture the row's culture strip shows every culture's state.
	void attention;
	return (
		<Show when={selected()}>
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
									{...stylex.attrs(styles.muted, localizationTone(mark().state))}
								>
									{localizationLabels[mark().state]}
								</span>
							}
						>
							{mark().translation}
						</Show>
						<Show when={mark().facts.includes("not_synced")}>
							<span {...stylex.attrs(styles.accent)}> · Not synced</span>
						</Show>
						<Show
							when={
								mark().translation?.trim() &&
								mark().state !== "translated" &&
								mark().state !== "not_synced"
							}
						>
							<span {...stylex.attrs(styles.muted, localizationTone(mark().state))}>
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
	// A line Unreal has not gathered has nothing here yet; its problem already says so above.
	const nothingYet = () => {
		const detail = props.focus ?? props.model.detail();
		return (
			detail !== undefined &&
			!props.focus &&
			["not_gathered", "changed_since_gather"].includes(detail.scopeSummary?.state ?? "") &&
			detail.keyChange === undefined &&
			detail.locations.length === 0 &&
			detail.nextCultureOffset === undefined &&
			visibleTranslations(detail, props.model.culture()).length === 0
		);
	};
	return (
		<Show when={props.model.active() && !nothingYet()}>
			<section aria-label="Translations" {...stylex.attrs(styles.detailSection)}>
				<h3 {...stylex.attrs(styles.section)}>Translations</h3>
				<Show
					when={props.focus || props.model.detail() || !props.model.detailLoading()}
					fallback={
						<span role="status" {...stylex.attrs(styles.muted)}>
							Loading translations…
						</span>
					}
				>
					<Show when={props.focus ?? props.model.detail()}>
						{(detail) => (
							<>
								<Show
									when={
										props.focus ||
										!["not_gathered", "changed_since_gather"].includes(
											detail().scopeSummary?.state ?? ""
										)
											? detail().scopeSummary
											: undefined
									}
								>
									{(summary) => (
										<p
											{...stylex.attrs(
												styles.muted,
												localizationTone(summary().state)
											)}
										>
											{summary().message}
										</p>
									)}
								</Show>
								<KeyChangeDetail detail={detail()} edits={props.edits} />
								<For
									each={visibleTranslations(detail(), props.model.culture())}
									keyed={(translation) => translation.culture}
								>
									{(translation) => (
										<article
											dir="auto"
											lang={translation().culture}
											aria-label={"Translation " + translation().culture}
											{...stylex.attrs(styles.card)}
										>
											<div {...stylex.attrs(styles.bar)}>
												<strong>{translation().culture}</strong>
												<Show
													when={displayedState(detail(), translation())}
												>
													{(state) => (
														<span
															{...stylex.attrs(
																styles.muted,
																localizationTone(state())
															)}
														>
															{localizationLabels[state()]}
														</span>
													)}
												</Show>
												<Show
													when={
														displayedState(detail(), translation()) !==
															"not_synced" &&
														translation().poTranslation !== null
													}
												>
													<span {...stylex.attrs(styles.accent)}>
														Not synced
													</span>
												</Show>
											</div>
											<Show
												when={translation().gameTextKind !== "unavailable"}
											>
												<span {...stylex.attrs(styles.muted)}>
													In the game
												</span>
												<p {...stylex.attrs(styles.notes)}>
													{translation().gameTranslation}
													{translation().gameTextKind ===
													"source_outdated"
														? " (source text — the translation is out of date)"
														: translation().gameTextKind ===
															  "source_untranslated"
															? " (source text — not translated)"
															: ""}
												</p>
											</Show>
											<Show
												when={
													translation().archiveTranslation &&
													(translation().gameTextKind === "unavailable" ||
														translation().gameTextKind ===
															"source_outdated")
												}
											>
												<span {...stylex.attrs(styles.muted)}>
													{translation().facts.includes("needs_update")
														? "Translation (out of date)"
														: "Translation"}
												</span>
												<p {...stylex.attrs(styles.notes)}>
													{translation().archiveTranslation}
												</p>
											</Show>
											<Show when={translation().poTranslation !== null}>
												<span {...stylex.attrs(styles.accent)}>
													In PO, not synced
												</span>
												<p {...stylex.attrs(styles.notes)}>
													{translation().poTranslation}
												</p>
											</Show>
											<Show
												when={
													translation().translationSource &&
													(translation().translationSource !==
														detail().source ||
														translation().facts.includes(
															"needs_update"
														))
												}
											>
												<span {...stylex.attrs(styles.muted)}>
													Written for this source
												</span>
												<p {...stylex.attrs(styles.notes)}>
													{translation().translationSource}
												</p>
											</Show>
											<For each={translation().translatorComments}>
												{(comment) => (
													<p {...stylex.attrs(styles.notes)}>{comment}</p>
												)}
											</For>
											<Show when={translation().flags.length}>
												<span {...stylex.attrs(styles.muted)}>
													PO flags: {translation().flags.join(", ")}
												</span>
											</Show>
											<Show
												when={translation().nextContextOffset !== undefined}
											>
												<Button
													size="compact"
													tone="quiet"
													onClick={() =>
														(
															props.onMoreContext ??
															props.model.moreContext
														)(translation().culture)
													}
												>
													Show more PO comments and flags
												</Button>
											</Show>
											<For each={translation().unknownReasons}>
												{(reason) => {
													const text = unknownReasonText(
														reason,
														translation().culture,
														props.model.active()?.fileProblems
													);
													return (
														<span {...stylex.attrs(styles.muted)}>
															{text.message}
															{text.recovery
																? ` ${text.recovery}`
																: ""}
														</span>
													);
												}}
											</For>
											<Show when={translation().reducedSourceChecking}>
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
														translation={translation()}
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
														translation={translation()}
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
