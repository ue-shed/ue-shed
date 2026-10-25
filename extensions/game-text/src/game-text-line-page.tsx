import * as stylex from "@stylexjs/stylex";
import { textProblems } from "@ue-shed/game-text/checks";
import { type LocalizationFocus } from "@ue-shed/game-text/corpus";
import {
	TEXT_ORIGIN_LABELS,
	TEXT_PROBLEM_LABELS,
	textFileLabel,
	textFolderLabel,
	textCountLabel,
	textReviewSignalLabel
} from "@ue-shed/game-text/labels";
import { manifestPathOrigin, textLocationOrigin } from "@ue-shed/game-text/rules";
import { type TextCorpusFocus, type TextProblem } from "@ue-shed/game-text/schema";
import { Button } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo } from "solid-js";
import { cultureSummary } from "./game-text-culture-state.js";
import { rowFindings } from "./game-text-result-rows.js";

const SEVERE = new Set<TextProblem>(["key_changed", "conflicting_source"]);
const WAITING = new Set<TextProblem>(["not_gathered", "changed_since_gather", "translation"]);

/**
 * Every problem the open line has, worst first: the engine's, in the list's culture scope, when
 * the line has translations; otherwise from its saved text.
 */
export function lineProblems(
	focus: TextCorpusFocus | undefined,
	detail: LocalizationFocus | undefined
): readonly TextProblem[] {
	if (detail?.problems) return detail.problems;
	if (focus?.unit.problems) return focus.unit.problems;
	return textProblems({
		signals: focus?.unit.reviewSignals ?? [],
		keyChanged: detail?.keyChange?.direction === "to",
		...(detail === undefined ? undefined : { marks: detail.translations })
	});
}

/** What the worst problem means and what resolves it, in a sentence. */
function problemSentence(
	problem: TextProblem,
	detail: LocalizationFocus | undefined
): string | undefined {
	switch (problem) {
		case "key_changed":
			return "The key changed since the last gather. Unreal drops the earlier key's translations at the next gather; carry them below first.";
		case "conflicting_source":
			return "This key holds different text in different places, so translators see only one of them. Give each text its own key.";
		case "not_gathered":
			return "Unreal has not gathered this line yet. Run Gather and export from Unreal steps to add it to the target.";
		case "changed_since_gather":
			return "The text changed since the last gather; translations still follow the earlier text until the next gather.";
		case "translation": {
			const summary = detail === undefined ? "" : cultureSummary(detail.translations);
			return summary === ""
				? "Some cultures still need translation work."
				: `Translation work: ${summary}.`;
		}
		case "unchecked":
			return "Game Text couldn't check this line in some cultures: the evidence, such as a package it read only partly, does not prove its state.";
		case "finding":
		case "up_to_date":
			return undefined;
	}
}

/**
 * The open line's page header: back to the list, where the line sits in it, and the lines before
 * and after it.
 */
export interface LinePosition {
	/** The line's place among the lines counted by `total`, from zero. */
	readonly index: number;
	readonly total: number;
	/** The group counted, when grouping can list one line in several groups. */
	readonly group?: string | undefined;
	readonly first: boolean;
	readonly last: boolean;
}

export function LinePageHeader(props: {
	readonly position: LinePosition | undefined;
	readonly onBack: () => void;
	readonly onMove: (step: -1 | 1) => void;
}) {
	return (
		<div {...stylex.attrs(styles.header)}>
			<Button type="button" size="compact" tone="quiet" onClick={() => props.onBack()}>
				‹ Lines
			</Button>
			<span {...stylex.attrs(styles.grow)} />
			<Show
				when={props.position}
				fallback={
					<span
						title="Filters or a rescan removed this line from the list. Go back to the lines to pick another."
						{...stylex.attrs(styles.position)}
					>
						Not in the current list
					</span>
				}
			>
				{(position) => (
					<span title={position().group} {...stylex.attrs(styles.position)}>
						{(position().index + 1).toLocaleString()} of{" "}
						{position().total.toLocaleString()}
						{position().group === undefined ? "" : " in " + position().group}
					</span>
				)}
			</Show>
			<Button
				type="button"
				size="compact"
				tone="quiet"
				aria-label="Previous line"
				title="Previous line (Alt ↑)"
				aria-keyshortcuts="Alt+ArrowUp"
				disabled={!props.position || props.position.first}
				onClick={() => props.onMove(-1)}
			>
				↑
			</Button>
			<Button
				type="button"
				size="compact"
				tone="quiet"
				aria-label="Next line"
				title="Next line (Alt ↓)"
				aria-keyshortcuts="Alt+ArrowDown"
				disabled={!props.position || props.position.last}
				onClick={() => props.onMove(1)}
			>
				↓
			</Button>
		</div>
	);
}

/**
 * What the open line needs, at the top of its page: its worst problem in a sentence, then the
 * project's rules with a finding on it.
 */
export function LineProblem(props: {
	readonly focus: TextCorpusFocus | undefined;
	readonly detail: LocalizationFocus | undefined;
	/** Rule labels by ID, for the line's findings. */
	readonly rules?: ReadonlyMap<string, string> | undefined;
}) {
	const onlyUnsynced = createMemo(
		() =>
			props.detail?.translations.some((mark) => mark.facts.includes("not_synced")) &&
			!props.detail?.translations.some(
				(mark) => mark.state === "not_translated" || mark.facts.includes("needs_update")
			)
	);
	const worst = () => lineProblems(props.focus, props.detail)[0] ?? "up_to_date";
	const sentence = () => problemSentence(worst(), props.detail);
	// The project's rules with a finding on the line, in the list's culture scope with a target.
	const findings = () => rowFindings(props.detail ?? props.focus?.unit ?? {}, props.rules);
	// A finding alone is no translation work, so it takes the neutral tone.
	const tone = createMemo(() =>
		sentence() === undefined
			? "finding"
			: SEVERE.has(worst())
				? "severe"
				: onlyUnsynced() && worst() === "translation"
					? "sync"
					: "waiting"
	);
	return (
		<Show when={sentence() !== undefined || findings().length > 0}>
			<div
				role="note"
				aria-label="What this line needs"
				{...stylex.attrs(
					styles.callout,
					tone() === "severe" && styles.calloutSevere,
					tone() === "sync" && styles.calloutSync,
					tone() === "waiting" && styles.calloutWaiting,
					tone() === "finding" && styles.calloutFinding
				)}
			>
				<Show when={sentence()}>
					{(text) => (
						<p {...stylex.attrs(styles.calloutLine)}>
							<strong
								{...stylex.attrs(
									tone() === "severe" && styles.severe,
									tone() === "sync" && styles.sync,
									tone() === "waiting" && styles.waiting
								)}
							>
								{TEXT_PROBLEM_LABELS[worst()]}
							</strong>{" "}
							{text()}
						</p>
					)}
				</Show>
				<Show when={findings().length > 0}>
					<p {...stylex.attrs(styles.calloutLine)}>
						<strong {...stylex.attrs(styles.findingLabel)}>Findings</strong>{" "}
						{findings().join(" · ")}
					</p>
				</Show>
			</div>
		</Show>
	);
}

/** The line's properties beside its page: problems, key, origin, files, editing, notes, length. */
export function LineProperties(props: {
	readonly focus: TextCorpusFocus | undefined;
	readonly detail: LocalizationFocus | undefined;
}) {
	const problems = () => lineProblems(props.focus, props.detail).slice(1);
	const key = () => {
		const identity = props.detail?.identity ?? undefined;
		if (identity) return { namespace: identity.namespace, key: identity.key };
		const unit = props.focus?.unit.identity;
		if (unit?.status === "resolved") return { namespace: unit.namespace, key: unit.key };
		if (unit?.status === "string_table") return { namespace: unit.tableId, key: unit.key };
		return undefined;
	};
	const files = (): readonly string[] => {
		const saved = props.focus?.occurrences.map((occurrence) =>
			textFileLabel(occurrence.packageFile)
		);
		const gathered = props.detail?.locations.map((path) => textFileLabel(path));
		return [...new Set(saved && saved.length > 0 ? saved : (gathered ?? []))];
	};
	const origins = () => {
		const saved = props.focus?.occurrences.map((occurrence) =>
			textLocationOrigin(occurrence.location)
		);
		const gathered = props.detail?.locations.map(manifestPathOrigin);
		return [...new Set(saved && saved.length > 0 ? saved : (gathered ?? []))].map(
			(origin) => TEXT_ORIGIN_LABELS[origin]
		);
	};
	const editing = () => {
		const occurrences = props.focus?.occurrences;
		if (!occurrences || occurrences.length === 0) return "Read only";
		const editable = occurrences.filter(
			(occurrence) => occurrence.editCapability === "source_editable"
		).length;
		return editable === occurrences.length
			? "Editable"
			: editable === 0
				? "Read only"
				: `Editable in ${editable.toLocaleString()} of ${occurrences.length.toLocaleString()}`;
	};
	const notes = () => {
		const saved = props.focus?.occurrences
			.map((occurrence) => occurrence.devNotes.trim())
			.filter((note) => note !== "");
		const gathered = props.detail?.translatorNotes;
		return [...new Set([...(saved ?? []), ...(gathered ?? [])])];
	};
	const facts = () =>
		(props.focus?.unit.reviewSignals ?? [])
			.filter((signal) => signal !== "evidence_only")
			.map(textReviewSignalLabel);
	const length = () => {
		const unit = props.focus?.unit;
		if (unit)
			return `${textCountLabel(unit.characterCount, "character")} · ${textCountLabel(unit.wordCount, "word")}`;
		const source = props.detail?.source;
		return source === undefined ? undefined : textCountLabel(source.length, "character");
	};
	return (
		<section aria-label="Properties" {...stylex.attrs(styles.properties)}>
			<h3 {...stylex.attrs(styles.heading)}>Properties</h3>
			<dl {...stylex.attrs(styles.list)}>
				<Show when={problems().length > 0}>
					<dt {...stylex.attrs(styles.term)}>Other problems</dt>
					<dd {...stylex.attrs(styles.value)}>
						<For each={problems()}>
							{(problem) => (
								<span
									{...stylex.attrs(
										styles.problem,
										SEVERE.has(problem) && styles.severe,
										WAITING.has(problem) && styles.waiting
									)}
								>
									{TEXT_PROBLEM_LABELS[problem]}
								</span>
							)}
						</For>
					</dd>
				</Show>
				<Show when={key()}>
					{(identity) => (
						<>
							<dt {...stylex.attrs(styles.term)}>Namespace</dt>
							<dd {...stylex.attrs(styles.value, styles.mono)}>
								{identity().namespace || "global"}
							</dd>
							<dt {...stylex.attrs(styles.term)}>Key</dt>
							<dd {...stylex.attrs(styles.value, styles.mono)}>{identity().key}</dd>
						</>
					)}
				</Show>
				<Show when={origins().length > 0}>
					<dt {...stylex.attrs(styles.term)}>Origin</dt>
					<dd {...stylex.attrs(styles.value)}>{origins().join(", ")}</dd>
				</Show>
				<Show when={files()[0]}>
					{(first) => (
						<>
							<dt {...stylex.attrs(styles.term)}>Asset</dt>
							<dd
								{...stylex.attrs(styles.value, styles.mono)}
								title={files().join("\n")}
							>
								{first().split("/").at(-1)}
								<Show when={files().length > 1}>
									<span {...stylex.attrs(styles.muted)}>
										{" "}
										+{(files().length - 1).toLocaleString()}
									</span>
								</Show>
							</dd>
							<dt {...stylex.attrs(styles.term)}>Folder</dt>
							<dd {...stylex.attrs(styles.value, styles.mono)}>
								{textFolderLabel(first()) || "(project root)"}
							</dd>
						</>
					)}
				</Show>
				<dt {...stylex.attrs(styles.term)}>Editing</dt>
				<dd {...stylex.attrs(styles.value)}>{editing()}</dd>
				<dt {...stylex.attrs(styles.term)}>Translator notes</dt>
				<dd {...stylex.attrs(styles.value, notes().length === 0 && styles.muted)}>
					{notes().length === 0 ? "None" : notes().join(" · ")}
				</dd>
				<Show when={length()}>
					{(text) => (
						<>
							<dt {...stylex.attrs(styles.term)}>Length</dt>
							<dd {...stylex.attrs(styles.value)}>{text()}</dd>
						</>
					)}
				</Show>
				<Show when={facts().length > 0}>
					<dt {...stylex.attrs(styles.term)}>Facts</dt>
					<dd {...stylex.attrs(styles.value)}>{facts().join(" · ")}</dd>
				</Show>
			</dl>
		</section>
	);
}

const styles = stylex.create({
	header: {
		position: "sticky",
		top: 0,
		zIndex: 3,
		backgroundColor: tokens.colorSurface,
		display: "flex",
		alignItems: "center",
		gap: 4,
		paddingBlock: 6,
		paddingInline: 8,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	grow: { flex: 1 },
	position: { color: tokens.colorTextMuted, fontSize: 12, fontVariantNumeric: "tabular-nums" },
	callout: {
		display: "grid",
		gap: 6,
		margin: 0,
		paddingBlock: 10,
		paddingInline: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderRadius: 8,
		color: tokens.colorText,
		fontSize: 13,
		lineHeight: 1.5
	},
	calloutSevere: {
		borderColor: "rgba(235, 87, 87, 0.35)",
		backgroundColor: "rgba(235, 87, 87, 0.06)"
	},
	calloutSync: { borderColor: tokens.colorAccent, backgroundColor: tokens.colorAccentWash },
	sync: { color: tokens.colorAccent },
	calloutWaiting: {
		borderColor: "rgba(242, 153, 74, 0.35)",
		backgroundColor: "rgba(242, 153, 74, 0.06)"
	},
	calloutFinding: {
		borderColor: tokens.colorBorderStrong,
		backgroundColor: tokens.colorSurfaceInset
	},
	calloutLine: { margin: 0 },
	findingLabel: { color: tokens.colorTextStrong },
	severe: { color: tokens.colorDanger },
	waiting: { color: tokens.colorWarning },
	properties: { display: "grid", gap: 8, alignContent: "start", padding: tokens.space4 },
	heading: { margin: 0, color: tokens.colorTextMuted, fontSize: 12, fontWeight: 500 },
	list: {
		display: "grid",
		gridTemplateColumns: "110px minmax(0, 1fr)",
		columnGap: 10,
		rowGap: 8,
		margin: 0,
		fontSize: 12.5
	},
	term: { color: tokens.colorTextFaint },
	value: {
		margin: 0,
		minWidth: 0,
		display: "flex",
		flexWrap: "wrap",
		gap: 6,
		color: tokens.colorTextStrong,
		overflowWrap: "anywhere"
	},
	problem: { color: tokens.colorTextMuted },
	mono: { fontFamily: tokens.fontMono, fontSize: 12 },
	muted: { color: tokens.colorTextMuted }
});
