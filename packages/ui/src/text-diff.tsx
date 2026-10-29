import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo, createSignal } from "solid-js";
import {
	TEXT_DIFF_KINDS,
	TEXT_DIFF_KIND_LABELS,
	TEXT_DIFF_KIND_TONES,
	diffField,
	fieldChanged,
	filterEntries,
	groupByFile,
	textDiffFileName,
	type DiffSegment,
	type TextDiffEntry,
	type TextDiffFilter,
	type TextDiffGroup,
	type TextDiffKind,
	type TextDiffTone
} from "./text-diff-model.js";

/**
 * Keyed text on two sides, as a diff: each entry its key and where it is, and each changed field
 * as a removed line over an added one, the words that differ marked. Knows nothing of where the
 * text came from: a changelist's game text, two `.po` files or two `.archive` files all pass
 * `TextDiffEntry`s.
 *
 * Entries list by file, or with `groups` in sections, one per group in the groups' order. The
 * toolbar filters by kind (or group) and text. With `onFilter` the host filters every entry, not
 * only those given, and passes the page back; without it the diff filters what it has.
 *
 * `entries` may be a page of more: give `total` and the counts for the whole, and `onMore` to ask
 * for the next page. With `overview`, a section unfiltered holds a few of its entries and offers to
 * show all of them, which filters to it.
 */
export function TextDiff(props: {
	readonly entries: readonly TextDiffEntry[];
	/** Accessible name of the whole diff. */
	readonly label: string;
	/** Sections to list entries in, and to filter by; kinds otherwise. */
	readonly groups?: readonly TextDiffGroup[];
	/** Whole counts per kind when `entries` is a page; counted from `entries` otherwise. */
	readonly counts?: Readonly<Record<TextDiffKind, number>>;
	/** Keys both sides have alike, shown as a muted figure. */
	readonly unchanged?: number;
	/** Entries the filter lists in all, when `entries` is a page. */
	readonly total?: number;
	readonly loadingMore?: boolean;
	readonly onMore?: () => void;
	/** The host's filter, when the host filters; the diff then shows it and reports changes. */
	readonly filter?: TextDiffFilter;
	readonly onFilter?: (filter: TextDiffFilter) => void;
	/** Unfiltered, sections hold a few entries each, as the host passed them. */
	readonly overview?: boolean;
	/** Above a section's entries, such as the assets most of them come from. */
	readonly sectionLead?: (group: TextDiffGroup) => JSX.Element;
	/** Actions on a file's header, such as showing its diff or opening it. */
	readonly fileActions?: (file: string) => JSX.Element;
}) {
	const [ownFilter, setOwnFilter] = createSignal<TextDiffFilter>({ query: "" });
	const filter = () => props.filter ?? ownFilter();
	const setFilter = (next: TextDiffFilter) => {
		if (props.onFilter) props.onFilter(next);
		else setOwnFilter(next);
	};
	const chips = createMemo(
		(): readonly TextDiffGroup[] =>
			props.groups ??
			TEXT_DIFF_KINDS.map((kind) => ({
				id: kind,
				label: TEXT_DIFF_KIND_LABELS[kind],
				tone: TEXT_DIFF_KIND_TONES[kind],
				count:
					props.counts?.[kind] ??
					props.entries.filter((entry) => entry.kind === kind).length
			}))
	);
	const all = () => chips().reduce((sum, chip) => sum + chip.count, 0);
	const shown = createMemo(() => {
		if (props.onFilter) return props.entries;
		const selected = filter().kind;
		const ofKind =
			selected === undefined
				? props.entries
				: props.entries.filter(
						(entry) => (props.groups ? entry.group : entry.kind) === selected
					);
		return filterEntries(ofKind, filter().query);
	});
	const filtering = () => filter().kind !== undefined || filter().query.trim() !== "";
	const partial = () => (props.total ?? props.entries.length) > props.entries.length;
	const empty = () =>
		props.entries.length === 0 && !filtering() ? "No text changed." : "Nothing matches.";
	return (
		<section aria-label={props.label} {...stylex.attrs(styles.diff)}>
			<div {...stylex.attrs(styles.toolbar)}>
				<input
					type="search"
					value={filter().query}
					onInput={(event) =>
						setFilter({ ...filter(), query: event.currentTarget.value })
					}
					aria-label="Filter by text or key"
					placeholder="Filter by text or key"
					{...stylex.attrs(styles.search)}
				/>
				<div role="group" aria-label="Show" {...stylex.attrs(styles.kinds)}>
					<KindButton
						label="All"
						count={all()}
						pressed={filter().kind === undefined}
						onClick={() => setFilter({ query: filter().query })}
					/>
					<For each={chips()}>
						{(chip) => (
							<KindButton
								label={chip.label}
								count={chip.count}
								{...(chip.listed === undefined
									? undefined
									: { listed: chip.listed })}
								tone={chip.tone}
								pressed={filter().kind === chip.id}
								onClick={() =>
									setFilter(
										filter().kind === chip.id
											? { query: filter().query }
											: { kind: chip.id, query: filter().query }
									)
								}
							/>
						)}
					</For>
					<Show when={props.unchanged !== undefined}>
						<span {...stylex.attrs(styles.unchanged)}>
							{(props.unchanged ?? 0).toLocaleString()} unchanged
						</span>
					</Show>
				</div>
			</div>
			<Show when={!props.onFilter && partial() && filtering()}>
				<p {...stylex.attrs(styles.note)}>
					Filtering the first {props.entries.length.toLocaleString()} of{" "}
					{(props.total ?? 0).toLocaleString()}.
				</p>
			</Show>
			<Show
				when={shown().length > 0}
				fallback={<p {...stylex.attrs(styles.note, styles.empty)}>{empty()}</p>}
			>
				<Show
					when={props.groups}
					fallback={
						<FileList
							entries={shown()}
							{...(props.fileActions
								? { fileActions: props.fileActions }
								: undefined)}
						/>
					}
				>
					{(groups) => (
						<GroupList
							entries={shown()}
							groups={groups()}
							open={filter().kind !== undefined}
							overview={props.overview === true && filter().kind === undefined}
							onShowAll={(group) => setFilter({ kind: group, query: filter().query })}
							{...(props.sectionLead ? { lead: props.sectionLead } : undefined)}
						/>
					)}
				</Show>
			</Show>
			<Show when={partial()}>
				<div {...stylex.attrs(styles.more)}>
					<span {...stylex.attrs(styles.note)}>
						{props.entries.length.toLocaleString()} of{" "}
						{(props.total ?? 0).toLocaleString()} shown.
					</span>
					<Show when={props.onMore}>
						{(more) => (
							<button
								type="button"
								disabled={props.loadingMore === true}
								onClick={() => more()()}
								{...stylex.attrs(styles.moreButton)}
							>
								{props.loadingMore === true ? "Loading…" : "Load more"}
							</button>
						)}
					</Show>
				</div>
			</Show>
		</section>
	);
}

/** Entries by file, each file under a header with its actions. */
function FileList(props: {
	readonly entries: readonly TextDiffEntry[];
	readonly fileActions?: (file: string) => JSX.Element;
}) {
	const files = createMemo(() => groupByFile(props.entries));
	return (
		<ul aria-label="Files" {...stylex.attrs(styles.plainList, styles.files)}>
			<For each={files()}>
				{(group) => (
					<li {...stylex.attrs(styles.file)}>
						<header {...stylex.attrs(styles.fileHeader)}>
							<span {...stylex.attrs(styles.fileName)} title={group.file}>
								{textDiffFileName(group.file).name}
							</span>
							<span {...stylex.attrs(styles.folder)} title={group.file}>
								{textDiffFileName(group.file).folder}
							</span>
							<span {...stylex.attrs(styles.fileCount)}>
								{group.entries.length.toLocaleString()}
							</span>
							<Show when={props.fileActions}>
								{(actions) => (
									<span {...stylex.attrs(styles.fileActions)}>
										{actions()(group.file)}
									</span>
								)}
							</Show>
						</header>
						<ul
							aria-label={`Changes in ${group.file}`}
							{...stylex.attrs(styles.plainList)}
						>
							<For each={group.entries}>{(entry) => <Entry entry={entry} />}</For>
						</ul>
					</li>
				)}
			</For>
		</ul>
	);
}

/** Entries in sections, one per group that has any, in the groups' order. */
function GroupList(props: {
	readonly entries: readonly TextDiffEntry[];
	readonly groups: readonly TextDiffGroup[];
	/** A filter picked one group: show it unfolded. */
	readonly open: boolean;
	/** Each section holds a few of its entries; offer the rest. */
	readonly overview: boolean;
	readonly onShowAll: (group: string) => void;
	readonly lead?: (group: TextDiffGroup) => JSX.Element;
}) {
	const sections = createMemo(() =>
		props.groups
			.map((group) => ({
				group,
				entries: props.entries.filter((entry) => entry.group === group.id)
			}))
			.filter((section) => section.entries.length > 0)
	);
	return (
		<div {...stylex.attrs(styles.sections)}>
			<For each={sections()} keyed={(section) => section.group.id}>
				{(section) => (
					<Section
						group={section().group}
						entries={section().entries}
						open={props.open}
						overview={props.overview}
						onShowAll={() => props.onShowAll(section().group.id)}
						{...(props.lead ? { lead: props.lead } : undefined)}
					/>
				)}
			</For>
		</div>
	);
}

function Section(props: {
	readonly group: TextDiffGroup;
	readonly entries: readonly TextDiffEntry[];
	readonly open: boolean;
	readonly overview: boolean;
	readonly onShowAll: () => void;
	readonly lead?: (group: TextDiffGroup) => JSX.Element;
}) {
	const [unfolded, setUnfolded] = createSignal(false);
	const shown = () => props.group.listed ?? props.group.count;
	const folded = () => props.group.folded === true && !props.open && !unfolded();
	const heading = () => `section-${props.group.id}`;
	return (
		<section aria-labelledby={heading()} {...stylex.attrs(styles.section)}>
			<header {...stylex.attrs(styles.sectionHeader)}>
				<span
					aria-hidden="true"
					{...stylex.attrs(styles.swatch, SWATCH[props.group.tone])}
				/>
				<h4 id={heading()} {...stylex.attrs(styles.sectionTitle)}>
					{props.group.label}
				</h4>
				<span {...stylex.attrs(styles.sectionCount)}>
					{countLabel(props.group.count, props.group.listed)}
				</span>
				<Show when={props.group.description}>
					{(description) => (
						<span {...stylex.attrs(styles.sectionDescription)}>{description()}</span>
					)}
				</Show>
				<Show when={props.group.folded === true && !props.open}>
					<button
						type="button"
						aria-expanded={folded() ? "false" : "true"}
						onClick={() => setUnfolded(!unfolded())}
						{...stylex.attrs(styles.moreButton, styles.sectionToggle)}
					>
						{folded() ? "Show" : "Hide"}
					</button>
				</Show>
			</header>
			<Show when={!folded()}>
				<Show when={props.lead}>{(lead) => lead()(props.group)}</Show>
				<ul aria-label={props.group.label} {...stylex.attrs(styles.plainList, styles.file)}>
					<For each={props.entries}>
						{(entry) => <Entry entry={entry} tone={props.group.tone} />}
					</For>
				</ul>
				<Show when={props.overview && shown() > props.entries.length}>
					<button
						type="button"
						onClick={() => props.onShowAll()}
						{...stylex.attrs(styles.moreButton, styles.showAll)}
					>
						Show all {shown().toLocaleString()} {props.group.label.toLocaleLowerCase()}
					</button>
				</Show>
			</Show>
		</section>
	);
}

/** "435", or "4 of 435" when a text filter lists only some. */
function countLabel(count: number, listed: number | undefined): string {
	return listed === undefined || listed === count
		? count.toLocaleString()
		: `${listed.toLocaleString()} of ${count.toLocaleString()}`;
}

function KindButton(props: {
	readonly label: string;
	readonly count: number;
	readonly listed?: number;
	readonly tone?: TextDiffTone;
	readonly pressed: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={props.pressed ? "true" : "false"}
			aria-label={`${props.label}, ${countLabel(props.count, props.listed)}`}
			disabled={(props.listed ?? props.count) === 0 && !props.pressed}
			onClick={() => props.onClick()}
			{...stylex.attrs(styles.kind, props.pressed && styles.kindPressed)}
		>
			<Show when={props.tone}>
				{(tone) => <span {...stylex.attrs(styles.swatch, SWATCH[tone()])} />}
			</Show>
			<span>{props.label}</span>
			<b {...stylex.attrs(styles.kindCount)}>{countLabel(props.count, props.listed)}</b>
		</button>
	);
}

/** One line of an entry: a field's side, signed and toned. */
export interface TextDiffRow {
	/** The field's label, on the first line of the field only. */
	readonly field?: string;
	/** What the field's state means, beside its label. */
	readonly note?: string;
	readonly code?: boolean;
	readonly sign: string;
	readonly tone: "removed" | "added" | "moved" | "same" | "context";
	readonly segments: readonly DiffSegment[];
}

/**
 * An entry's lines. A field both sides have alike is one plain line: the first field always, and
 * later fields only when they are context. A changed one is its old line over its new, words
 * marked only when both sides have text. The first field is labelled once the entry has more than
 * one line. An added or removed entry folds its secondary fields unless `details` is set.
 */
export function entryRows(entry: TextDiffEntry, details = false): TextDiffRow[] {
	const fields = entry.fields.filter(
		(field, index) =>
			index === 0 ||
			details ||
			field.secondary !== true ||
			(entry.kind !== "added" && entry.kind !== "removed")
	);
	const rows = fields.flatMap((field, index): TextDiffRow[] => {
		const label = {
			field: field.label,
			...(field.note === undefined ? undefined : { note: field.note }),
			...(field.code === true ? { code: true } : undefined)
		};
		if (!fieldChanged(field)) {
			if (index === 0)
				return [
					{
						...label,
						sign: entry.kind === "rekeyed" ? "~" : " ",
						tone: entry.kind === "rekeyed" ? "moved" : "same",
						segments: plain(field.after ?? "")
					}
				];
			return field.context === true
				? [{ ...label, sign: " ", tone: "context", segments: plain(field.after ?? "") }]
				: [];
		}
		const both = (field.before ?? "") !== "" && (field.after ?? "") !== "";
		const diff = both ? diffField(field.before ?? "", field.after ?? "") : undefined;
		const lines: TextDiffRow[] = [];
		if (field.before !== undefined)
			lines.push({
				...label,
				sign: "−",
				tone: "removed",
				segments: diff?.before ?? plain(field.before)
			});
		if (field.after !== undefined)
			lines.push({
				...(lines.length === 0 ? label : field.code === true ? { code: true } : undefined),
				sign: "+",
				tone: "added",
				segments: diff?.after ?? plain(field.after)
			});
		return lines;
	});
	// One line needs no label: the key and place say what it is.
	// An entry whose text is empty on both sides still shows, as its key.
	if (rows.length === 0)
		return [
			{
				sign: entry.kind === "added" ? "+" : entry.kind === "removed" ? "−" : "~",
				tone:
					entry.kind === "added"
						? "added"
						: entry.kind === "removed"
							? "removed"
							: "moved",
				segments: []
			}
		];
	const [only] = rows;
	if (rows.length === 1 && only !== undefined)
		return [
			{
				sign: only.sign,
				tone: only.tone,
				segments: only.segments,
				...(only.code === true ? { code: true } : undefined),
				...(only.note === undefined ? undefined : { note: only.note })
			}
		];
	return rows;
}

const plain = (text: string): DiffSegment[] => (text === "" ? [] : [{ text, op: "same" }]);

/**
 * One entry as diff lines: the sign and the line's colour say what happened, and a stripe in the
 * kind's colour holds the entry together. The first line carries the key (old → new for a new
 * key) and where the text is.
 */
function Entry(props: { readonly entry: TextDiffEntry; readonly tone?: TextDiffTone }) {
	const [details, setDetails] = createSignal(false);
	const rows = createMemo(() => entryRows(props.entry, details()));
	const folded = () =>
		(props.entry.kind === "added" || props.entry.kind === "removed") &&
		props.entry.fields.some((field, index) => index > 0 && field.secondary === true);
	return (
		<li
			aria-label={`${TEXT_DIFF_KIND_LABELS[props.entry.kind]}: ${(props.entry.after ?? props.entry.before)?.full ?? ""}`}
			{...stylex.attrs(
				styles.entry,
				STRIPE[props.tone ?? TEXT_DIFF_KIND_TONES[props.entry.kind]]
			)}
		>
			<For each={rows()}>
				{(row, index) => (
					<div {...stylex.attrs(styles.row, TONE[row.tone])}>
						<span aria-hidden="true" {...stylex.attrs(styles.sign, SIGN[row.tone])}>
							{row.sign}
						</span>
						<span {...stylex.attrs(styles.fieldLabel)}>{row.field ?? ""}</span>
						<span
							{...stylex.attrs(
								styles.text,
								row.code === true && styles.code,
								row.tone === "context" && styles.contextText
							)}
						>
							<Segments segments={row.segments} />
							<Show when={row.note}>
								{(note) => (
									<span {...stylex.attrs(styles.fieldNote)}>{note()}</span>
								)}
							</Show>
						</span>
						<Show when={index() === 0}>
							<Meta entry={props.entry} />
						</Show>
					</div>
				)}
			</For>
			<Show when={props.entry.note}>
				{(note) => <p {...stylex.attrs(styles.entryNote)}>{note()}</p>}
			</Show>
			<Show when={folded()}>
				<button
					type="button"
					aria-expanded={details() ? "true" : "false"}
					onClick={() => setDetails(!details())}
					{...stylex.attrs(styles.detailsButton)}
				>
					{details() ? "Fewer details" : "More details"}
				</button>
			</Show>
		</li>
	);
}

/** Where the entry is, and its key: old → new for a new key. */
function Meta(props: { readonly entry: TextDiffEntry }) {
	const before = () => props.entry.before;
	const after = () => props.entry.after;
	const moved = () => {
		const old = before();
		const next = after();
		return old !== undefined && next !== undefined && old.full !== next.full;
	};
	const title = () =>
		[props.entry.placeTitle ?? props.entry.place, before()?.full, moved() ? after()?.full : ""]
			.filter((part) => part !== undefined && part !== "")
			.join("\n");
	return (
		<span {...stylex.attrs(styles.meta)} title={title()}>
			<Show when={props.entry.place}>
				{(place) => <span {...stylex.attrs(styles.place)}>{place()}</span>}
			</Show>
			<Show
				when={moved()}
				fallback={
					<span {...stylex.attrs(styles.key)}>{(after() ?? before())?.label ?? ""}</span>
				}
			>
				<span {...stylex.attrs(styles.key)}>{before()?.label ?? ""}</span>
				<span aria-hidden="true" {...stylex.attrs(styles.arrow)}>
					→
				</span>
				<span {...stylex.attrs(styles.key, styles.newKey)}>{after()?.label ?? ""}</span>
			</Show>
		</span>
	);
}

const NO_BREAK_SPACE = String.fromCodePoint(0xa0);

/** A space as it is drawn inside a mark. */
function drawn(letter: string): string {
	if (letter === " ") return "·";
	if (letter === NO_BREAK_SPACE) return "⍽";
	if (letter === "\t") return "→";
	if (letter === "\n") return "↵\n";
	return letter;
}

/** A marked run's text with its spaces drawn, and a code point for a lone symbol. */
function Mark(props: { readonly segment: DiffSegment }) {
	const shown = () => Array.from(props.segment.text, drawn).join("");
	const title = () => {
		const letters = Array.from(props.segment.text);
		const [only] = letters;
		return letters.length === 1 && only !== undefined && !/[\p{L}\p{N}]/u.test(only)
			? `U+${(only.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`
			: undefined;
	};
	return (
		<mark
			title={title()}
			{...stylex.attrs(
				styles.mark,
				props.segment.op === "removed" ? styles.markRemoved : styles.markAdded
			)}
		>
			<Show when={props.segment.text.trim() === ""} fallback={props.segment.text}>
				<span aria-hidden="true">{shown()}</span>
				<span {...stylex.attrs(styles.visuallyHidden)}>{props.segment.text}</span>
			</Show>
		</mark>
	);
}

function Segments(props: { readonly segments: readonly DiffSegment[] }) {
	return (
		<Show
			when={props.segments.length > 0}
			fallback={<span {...stylex.attrs(styles.empty)}>(empty)</span>}
		>
			<For each={props.segments}>
				{(segment) => (
					<Show when={segment.op !== "same"} fallback={segment.text}>
						<Mark segment={segment} />
					</Show>
				)}
			</For>
		</Show>
	);
}

const REMOVED_LINE = "rgb(235 87 87 / 0.09)";
const REMOVED_WORD = "rgb(235 87 87 / 0.32)";
const REMOVED_EDGE = "rgb(235 87 87 / 0.9)";
const REMOVED_STRIKE = "rgb(235 87 87 / 0.7)";
const ADDED_LINE = "rgb(76 183 130 / 0.09)";
const ADDED_WORD = "rgb(76 183 130 / 0.32)";
const ADDED_EDGE = "rgb(76 183 130 / 0.9)";

const styles = stylex.create({
	diff: { display: "grid", gap: 10 },
	toolbar: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8
	},
	kinds: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 },
	kind: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		paddingBlock: 4,
		paddingInline: 10,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		backgroundColor: "transparent",
		fontSize: 12,
		color: tokens.colorText,
		cursor: { default: "pointer", ":disabled": "default" },
		opacity: { default: 1, ":disabled": 0.45 }
	},
	kindPressed: { borderColor: tokens.colorAccent, backgroundColor: tokens.colorAccentWash },
	kindCount: { fontSize: 12, fontVariantNumeric: "tabular-nums", color: tokens.colorTextStrong },
	swatch: { width: 8, height: 8, borderRadius: 2, flexShrink: 0 },
	swatchAdded: { backgroundColor: tokens.colorSuccess },
	swatchRemoved: { backgroundColor: tokens.colorDanger },
	swatchAttention: { backgroundColor: tokens.colorWarning },
	swatchChanged: { backgroundColor: tokens.colorAccent },
	swatchQuiet: { backgroundColor: tokens.colorTextFaint },
	unchanged: { fontSize: 12, color: tokens.colorTextMuted, paddingInline: 4 },
	search: {
		width: 260,
		maxWidth: "100%",
		boxSizing: "border-box",
		paddingBlock: 5,
		paddingInline: 10,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":focus-visible": tokens.colorAccent },
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		fontSize: 12,
		outline: "none"
	},
	note: { margin: 0, fontSize: 12, color: tokens.colorTextMuted },
	empty: { paddingBlock: 12, textAlign: "center" },
	plainList: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
	files: { gap: 12 },
	file: {
		display: "grid",
		gap: 2,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		overflow: "hidden",
		backgroundColor: tokens.colorSurface
	},
	fileHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		minWidth: 0,
		paddingBlock: 6,
		paddingInline: 12,
		backgroundColor: tokens.colorSurfaceRaised,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	fileName: {
		fontSize: 12,
		fontWeight: 600,
		color: tokens.colorTextStrong,
		whiteSpace: "nowrap"
	},
	folder: {
		minWidth: 0,
		flexShrink: 1,
		fontSize: 11,
		fontFamily: tokens.fontMono,
		color: tokens.colorTextMuted,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	fileCount: { fontSize: 11, color: tokens.colorTextMuted, fontVariantNumeric: "tabular-nums" },
	fileActions: { display: "flex", alignItems: "center", gap: 8, marginInlineStart: "auto" },
	sections: { display: "grid", gap: 16 },
	section: { display: "grid", gap: 6 },
	sectionHeader: { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 },
	sectionTitle: { margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colorTextStrong },
	sectionCount: {
		fontSize: 12,
		color: tokens.colorTextMuted,
		fontVariantNumeric: "tabular-nums"
	},
	sectionDescription: {
		minWidth: 0,
		fontSize: 12,
		color: tokens.colorTextMuted,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	sectionToggle: { marginInlineStart: "auto", flexShrink: 0 },
	showAll: { justifySelf: "start" },
	// An entry's lines sit together under a stripe of its kind's colour.
	entry: {
		display: "grid",
		paddingBlock: 2,
		borderLeftWidth: 3,
		borderLeftStyle: "solid",
		borderTopWidth: { default: 1, ":first-child": 0 },
		borderTopStyle: "solid",
		borderTopColor: tokens.colorBorder
	},
	stripeAdded: { borderLeftColor: tokens.colorSuccess },
	stripeRemoved: { borderLeftColor: tokens.colorDanger },
	stripeAttention: { borderLeftColor: tokens.colorWarning },
	stripeChanged: { borderLeftColor: tokens.colorAccent },
	stripeQuiet: { borderLeftColor: tokens.colorBorderStrong },
	// Sign, field label, text, then the key and place on the first line.
	row: {
		display: "grid",
		// The key column is fixed, so text keeps one width from entry to entry.
		gridTemplateColumns: "16px 84px minmax(0, 1fr) 240px",
		columnGap: 10,
		alignItems: "baseline",
		paddingBlock: 3,
		paddingInline: 10,
		fontSize: 13,
		lineHeight: 1.45,
		color: tokens.colorTextStrong
	},
	rowRemoved: { backgroundColor: REMOVED_LINE },
	rowAdded: { backgroundColor: ADDED_LINE },
	rowMoved: {},
	rowSame: {},
	rowContext: {},
	sign: {
		fontFamily: tokens.fontMono,
		color: tokens.colorTextMuted,
		textAlign: "center",
		userSelect: "none"
	},
	signRemoved: { color: tokens.colorDanger },
	signAdded: { color: tokens.colorSuccess },
	signMoved: { color: tokens.colorWarning },
	signSame: {},
	signContext: {},
	fieldLabel: {
		minWidth: 0,
		fontSize: 11,
		color: tokens.colorTextMuted,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	fieldNote: {
		marginInlineStart: 10,
		fontSize: 11,
		fontStyle: "italic",
		color: tokens.colorTextMuted,
		whiteSpace: "normal"
	},
	meta: {
		display: "flex",
		alignItems: "baseline",
		justifyContent: "flex-end",
		gap: 6,
		minWidth: 0,
		overflow: "hidden",
		whiteSpace: "nowrap"
	},
	place: {
		minWidth: 0,
		fontSize: 11,
		color: tokens.colorTextMuted,
		overflow: "hidden",
		textOverflow: "ellipsis"
	},
	key: {
		minWidth: 0,
		fontSize: 11,
		fontFamily: tokens.fontMono,
		color: tokens.colorTextMuted,
		overflow: "hidden",
		textOverflow: "ellipsis"
	},
	newKey: { color: tokens.colorText },
	arrow: { fontSize: 11, color: tokens.colorTextMuted },
	code: { fontFamily: tokens.fontMono, fontSize: 11 },
	// Text as it is: line breaks and runs of spaces kept, long words broken.
	text: { minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", tabSize: 2 },
	contextText: { color: tokens.colorTextMuted },
	entryNote: {
		margin: 0,
		paddingBlock: 2,
		paddingInlineStart: 120,
		paddingInlineEnd: 10,
		fontSize: 12,
		color: tokens.colorWarning
	},
	detailsButton: {
		justifySelf: "start",
		marginInlineStart: 120,
		marginBlock: 2,
		padding: 0,
		borderWidth: 0,
		backgroundColor: "transparent",
		fontSize: 11,
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorText },
		cursor: "pointer",
		textDecorationLine: "underline"
	},
	mark: {
		borderRadius: 2,
		color: "inherit",
		paddingInline: 1,
		borderBottomWidth: 2,
		borderBottomStyle: "solid"
	},
	markRemoved: {
		backgroundColor: REMOVED_WORD,
		borderBottomColor: REMOVED_EDGE,
		textDecorationLine: "line-through",
		textDecorationColor: REMOVED_STRIKE
	},
	markAdded: { backgroundColor: ADDED_WORD, borderBottomColor: ADDED_EDGE },
	visuallyHidden: {
		position: "absolute",
		width: 1,
		height: 1,
		overflow: "hidden",
		clipPath: "inset(50%)",
		whiteSpace: "nowrap"
	},
	more: { display: "flex", alignItems: "center", gap: 8 },
	moreButton: {
		paddingBlock: 3,
		paddingInline: 10,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		backgroundColor: "transparent",
		color: tokens.colorText,
		fontSize: 12,
		cursor: { default: "pointer", ":disabled": "default" }
	}
});

const SWATCH = {
	added: styles.swatchAdded,
	removed: styles.swatchRemoved,
	attention: styles.swatchAttention,
	changed: styles.swatchChanged,
	quiet: styles.swatchQuiet
};

const STRIPE = {
	added: styles.stripeAdded,
	removed: styles.stripeRemoved,
	attention: styles.stripeAttention,
	changed: styles.stripeChanged,
	quiet: styles.stripeQuiet
};

const TONE = {
	removed: styles.rowRemoved,
	added: styles.rowAdded,
	moved: styles.rowMoved,
	same: styles.rowSame,
	context: styles.rowContext
};

const SIGN = {
	removed: styles.signRemoved,
	added: styles.signAdded,
	moved: styles.signMoved,
	same: styles.signSame,
	context: styles.signContext
};
