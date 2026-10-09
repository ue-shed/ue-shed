import * as stylex from "@stylexjs/stylex";
import {
	TEXT_ORIGIN_LABELS,
	TEXT_PROBLEM_LABELS,
	manifestPathOrigin,
	textFileLabel,
	textFolderLabel,
	textLocationOrigin,
	textProblems,
	textCountLabel,
	textReviewSignalLabel,
	type LocalizationFocus,
	type TextCorpusFocus,
	type TextProblem
} from "@ue-shed/game-text/browser";
import { Button } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show } from "solid-js";
import { cultureSummary } from "./game-text-culture-state.js";

const SEVERE = new Set<TextProblem>(["key_changed", "conflicting_source"]);
const WAITING = new Set<TextProblem>(["not_gathered", "changed_since_gather", "translation"]);

/** Every problem the open line has, worst first, from its saved text and its translations. */
export function lineProblems(
	focus: TextCorpusFocus | undefined,
	detail: LocalizationFocus | undefined
): readonly TextProblem[] {
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
		case "finding":
		case "up_to_date":
			return undefined;
	}
}

/**
 * The open line's page header: back to the list, where the line sits in it, and the lines before
 * and after it.
 */
export function LinePageHeader(props: {
	readonly position: { readonly index: number; readonly total: number } | undefined;
	readonly onBack: () => void;
	readonly onMove: (step: -1 | 1) => void;
}) {
	return (
		<div {...stylex.attrs(styles.header)}>
			<Button type="button" size="compact" tone="quiet" onClick={() => props.onBack()}>
				‹ Lines
			</Button>
			<span {...stylex.attrs(styles.grow)} />
			<Show when={props.position}>
				{(position) => (
					<span {...stylex.attrs(styles.position)}>
						{(position().index + 1).toLocaleString()} of{" "}
						{position().total.toLocaleString()}
					</span>
				)}
			</Show>
			<Button
				type="button"
				size="compact"
				tone="quiet"
				aria-label="Previous line"
				disabled={!props.position || props.position.index === 0}
				onClick={() => props.onMove(-1)}
			>
				↑
			</Button>
			<Button
				type="button"
				size="compact"
				tone="quiet"
				aria-label="Next line"
				disabled={!props.position || props.position.index + 1 >= props.position.total}
				onClick={() => props.onMove(1)}
			>
				↓
			</Button>
		</div>
	);
}

/** The worst problem, said once at the top of the page, in its severity colour. */
export function LineProblem(props: {
	readonly focus: TextCorpusFocus | undefined;
	readonly detail: LocalizationFocus | undefined;
}) {
	const worst = () => lineProblems(props.focus, props.detail)[0] ?? "up_to_date";
	return (
		<Show when={problemSentence(worst(), props.detail)}>
			{(sentence) => (
				<p
					role="note"
					aria-label="What this line needs"
					{...stylex.attrs(
						styles.callout,
						SEVERE.has(worst()) ? styles.calloutSevere : styles.calloutWaiting
					)}
				>
					<strong {...stylex.attrs(SEVERE.has(worst()) ? styles.severe : styles.waiting)}>
						{TEXT_PROBLEM_LABELS[worst()]}
					</strong>{" "}
					{sentence()}
				</p>
			)}
		</Show>
	);
}

/** The line's properties beside its page: problems, key, origin, files, editing, notes, length. */
export function LineProperties(props: {
	readonly focus: TextCorpusFocus | undefined;
	readonly detail: LocalizationFocus | undefined;
}) {
	const problems = () => lineProblems(props.focus, props.detail);
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
	const findings = () =>
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
				<dt {...stylex.attrs(styles.term)}>Problem</dt>
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
				<Show when={key()}>
					{(identity) => (
						<>
							<dt {...stylex.attrs(styles.term)}>Namespace</dt>
							<dd {...stylex.attrs(styles.value, styles.mono)}>
								{identity().namespace === "" ? "(none)" : identity().namespace}
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
				<Show when={findings().length > 0}>
					<dt {...stylex.attrs(styles.term)}>Findings</dt>
					<dd {...stylex.attrs(styles.value)}>{findings().join(" · ")}</dd>
				</Show>
			</dl>
		</section>
	);
}

const styles = stylex.create({
	header: {
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
	calloutWaiting: {
		borderColor: "rgba(242, 153, 74, 0.35)",
		backgroundColor: "rgba(242, 153, 74, 0.06)"
	},
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
