import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal } from "solid-js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import {
	TEXT_DIFF_KINDS,
	TEXT_DIFF_KIND_LABELS,
	diffField,
	fieldChanged,
	filterEntries,
	groupByFile,
	type DiffSegment,
	type TextDiffEntry,
	type TextDiffKind
} from "./text-diff-model.js";

/** A file's name without its extension, and its folder. */
interface FileName {
	readonly name: string;
	readonly folder: string;
}

function fileName(path: string): FileName {
	const slash = path.lastIndexOf("/");
	const file = path.slice(slash + 1);
	const dot = file.lastIndexOf(".");
	return {
		name: dot > 0 && !/\.(?:po|archive|manifest|csv)$/iu.test(file) ? file.slice(0, dot) : file,
		folder: slash < 0 ? "" : path.slice(0, slash)
	};
}

/**
 * Keyed text on two sides, as a diff: entries grouped by file, each with its key and where it is,
 * and each changed field as a removed line over an added one, the words that differ marked.
 * Knows nothing of where the text came from: a changelist's game text, two `.po` files or two
 * `.archive` files all pass `TextDiffEntry`s.
 *
 * `entries` may be a page of more: give `total` and `counts` for the whole, and `onMore` to ask
 * for the next page. Filtering by kind or text works on the entries given.
 */
export function TextDiff(props: {
	readonly entries: readonly TextDiffEntry[];
	/** Accessible name of the whole diff. */
	readonly label: string;
	/** Whole counts per kind when `entries` is a page; counted from `entries` otherwise. */
	readonly counts?: Readonly<Record<TextDiffKind, number>>;
	/** Keys both sides have alike, shown as a muted figure. */
	readonly unchanged?: number;
	/** Entries in all, when `entries` is a page. */
	readonly total?: number;
	readonly loadingMore?: boolean;
	readonly onMore?: () => void;
	/** Actions on a file's header, such as showing its diff or opening it. */
	readonly fileActions?: (file: string) => JSX.Element;
}) {
	const [kind, setKind] = createSignal<TextDiffKind>();
	const [query, setQuery] = createSignal("");
	const counts = createMemo(
		() =>
			props.counts ??
			Object.fromEntries(
				TEXT_DIFF_KINDS.map((each) => [
					each,
					props.entries.filter((entry) => entry.kind === each).length
				])
			)
	);
	const all = () => TEXT_DIFF_KINDS.reduce((sum, each) => sum + (counts()[each] ?? 0), 0);
	const shown = createMemo(() => {
		const selected = kind();
		const ofKind =
			selected === undefined
				? props.entries
				: props.entries.filter((entry) => entry.kind === selected);
		return filterEntries(ofKind, query());
	});
	const files = createMemo(() => groupByFile(shown()));
	const partial = () => (props.total ?? props.entries.length) > props.entries.length;
	return (
		<section aria-label={props.label} {...stylex.attrs(styles.diff)}>
			<div {...stylex.attrs(styles.toolbar)}>
				<div role="group" aria-label="Show" {...stylex.attrs(styles.kinds)}>
					<KindButton
						label="All"
						count={all()}
						pressed={kind() === undefined}
						onClick={() => setKind(undefined)}
					/>
					<For each={TEXT_DIFF_KINDS}>
						{(each) => (
							<KindButton
								label={TEXT_DIFF_KIND_LABELS[each]}
								count={counts()[each] ?? 0}
								kind={each}
								pressed={kind() === each}
								onClick={() => setKind(kind() === each ? undefined : each)}
							/>
						)}
					</For>
					<Show when={props.unchanged !== undefined}>
						<span {...stylex.attrs(styles.unchanged)}>
							{(props.unchanged ?? 0).toLocaleString()} unchanged
						</span>
					</Show>
				</div>
				<input
					type="search"
					value={query()}
					onInput={(event) => setQuery(event.currentTarget.value)}
					aria-label="Filter by text, key or file"
					placeholder="Filter by text, key or file"
					{...stylex.attrs(styles.search)}
				/>
			</div>
			<Show when={partial() && (kind() !== undefined || query().trim() !== "")}>
				<p {...stylex.attrs(styles.note)}>
					Filtering the first {props.entries.length.toLocaleString()} of{" "}
					{(props.total ?? 0).toLocaleString()}.
				</p>
			</Show>
			<Show
				when={files().length > 0}
				fallback={
					<p {...stylex.attrs(styles.note)}>
						{props.entries.length === 0 ? "No text changed." : "Nothing matches."}
					</p>
				}
			>
				<ul aria-label="Files" {...stylex.attrs(styles.plainList, styles.files)}>
					<For each={files()}>
						{(group) => (
							<li {...stylex.attrs(styles.file)}>
								<header {...stylex.attrs(styles.fileHeader)}>
									<span {...stylex.attrs(styles.fileName)} title={group.file}>
										{fileName(group.file).name}
									</span>
									<span {...stylex.attrs(styles.folder)} title={group.file}>
										{fileName(group.file).folder}
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
									aria-label={`Changes in ${fileName(group.file).name}`}
									{...stylex.attrs(styles.plainList)}
								>
									<For each={group.entries}>
										{(entry) => <Entry entry={entry} />}
									</For>
								</ul>
							</li>
						)}
					</For>
				</ul>
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

function KindButton(props: {
	readonly label: string;
	readonly count: number;
	readonly kind?: TextDiffKind;
	readonly pressed: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={props.pressed ? "true" : "false"}
			disabled={props.count === 0 && !props.pressed}
			onClick={() => props.onClick()}
			{...stylex.attrs(styles.kind, props.pressed && styles.kindPressed)}
		>
			<Show when={props.kind}>
				{(kind) => <span {...stylex.attrs(styles.swatch, SWATCH[kind()])} />}
			</Show>
			<b {...stylex.attrs(styles.kindCount)}>{props.count.toLocaleString()}</b>
			<span>{props.label}</span>
		</button>
	);
}

/** One line of an entry: a field's side, signed and toned. */
export interface TextDiffRow {
	readonly field?: string;
	readonly code?: boolean;
	readonly sign: string;
	readonly tone: "removed" | "added" | "moved" | "same";
	readonly segments: readonly DiffSegment[];
}

/**
 * An entry's lines. A field both sides have alike is one plain line (a new key's text); a changed
 * one is its old line over its new, words marked only when both sides have text. Fields after the
 * first show only when they changed, and say which field they are.
 */
export function entryRows(entry: TextDiffEntry): TextDiffRow[] {
	return entry.fields.flatMap((field, index): TextDiffRow[] => {
		const label = {
			...(index === 0 ? undefined : { field: field.label }),
			...(field.code === true ? { code: true } : undefined)
		};
		if (!fieldChanged(field))
			return index === 0
				? [
						{
							...label,
							sign: entry.kind === "rekeyed" ? "~" : " ",
							tone: entry.kind === "rekeyed" ? "moved" : "same",
							segments: plain(field.after ?? "")
						}
					]
				: [];
		const both = (field.before ?? "") !== "" && (field.after ?? "") !== "";
		const diff = both ? diffField(field.before ?? "", field.after ?? "") : undefined;
		const rows: TextDiffRow[] = [];
		if (field.before !== undefined)
			rows.push({
				...label,
				sign: "−",
				tone: "removed",
				segments: diff?.before ?? plain(field.before)
			});
		if (field.after !== undefined)
			rows.push({
				...label,
				sign: "+",
				tone: "added",
				segments: diff?.after ?? plain(field.after)
			});
		return rows;
	});
}

const plain = (text: string): DiffSegment[] => (text === "" ? [] : [{ text, op: "same" }]);

/**
 * One entry as diff lines: the sign and the line's colour say what happened, so there is no tag.
 * The first line carries the key (old → new for a new key) and where the text is, in columns.
 */
function Entry(props: { readonly entry: TextDiffEntry }) {
	const rows = createMemo(() => entryRows(props.entry));
	return (
		<li aria-label={TEXT_DIFF_KIND_LABELS[props.entry.kind]} {...stylex.attrs(styles.entry)}>
			<For each={rows()}>
				{(row, index) => (
					<div {...stylex.attrs(styles.row, TONE[row.tone])}>
						<span aria-hidden="true" {...stylex.attrs(styles.sign, SIGN[row.tone])}>
							{row.sign}
						</span>
						<span
							{...stylex.attrs(
								styles.text,
								row.code === true && styles.code,
								// Lines under the first have no key or place: the text takes their room.
								index() > 0 && styles.textWide
							)}
						>
							<Show when={row.field}>
								{(field) => (
									<span {...stylex.attrs(styles.fieldLabel)}>{field()}</span>
								)}
							</Show>
							<Segments segments={row.segments} />
						</span>
						<Show when={index() === 0}>
							<Key entry={props.entry} />
							<span
								{...stylex.attrs(styles.place)}
								title={props.entry.placeTitle ?? props.entry.place ?? ""}
							>
								{props.entry.place ?? ""}
							</span>
						</Show>
					</div>
				)}
			</For>
		</li>
	);
}

/** The entry's key; a new key's old one is on the entry's own Key lines. */
function Key(props: { readonly entry: TextDiffEntry }) {
	const key = () => props.entry.after ?? props.entry.before;
	return (
		<span {...stylex.attrs(styles.key)} title={key()?.full ?? ""}>
			{key()?.label ?? ""}
		</span>
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
						<mark
							{...stylex.attrs(
								styles.mark,
								segment.op === "removed" ? styles.markRemoved : styles.markAdded
							)}
						>
							{segment.text}
						</mark>
					</Show>
				)}
			</For>
		</Show>
	);
}

const REMOVED_LINE = "rgb(235 87 87 / 0.09)";
const REMOVED_WORD = "rgb(235 87 87 / 0.32)";
const ADDED_LINE = "rgb(76 183 130 / 0.09)";
const ADDED_WORD = "rgb(76 183 130 / 0.32)";
const MOVED_LINE = "rgb(242 153 74 / 0.07)";

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
	kindCount: { fontSize: 13, fontVariantNumeric: "tabular-nums" },
	swatch: { width: 8, height: 8, borderRadius: 2 },
	swatchAdded: { backgroundColor: tokens.colorSuccess },
	swatchRemoved: { backgroundColor: tokens.colorDanger },
	swatchRekeyed: { backgroundColor: tokens.colorWarning },
	swatchEdited: { backgroundColor: tokens.colorAccent },
	unchanged: { fontSize: 12, color: tokens.colorTextMuted, paddingInline: 4 },
	search: {
		width: 260,
		maxWidth: "100%",
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
	plainList: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
	files: { gap: 12 },
	file: {
		display: "grid",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		overflow: "hidden"
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
	// Entries touch, like lines of a diff; a hairline parts one entry from the next.
	entry: {
		display: "grid",
		borderTopWidth: { default: 1, ":first-child": 0 },
		borderTopStyle: "solid",
		borderTopColor: tokens.colorBorder
	},
	// Sign, text, key, place: the same columns on every line of every file.
	row: {
		display: "grid",
		gridTemplateColumns: "16px minmax(0, 1fr) minmax(0, 24%) minmax(0, 20%)",
		columnGap: 12,
		alignItems: "baseline",
		paddingBlock: 3,
		paddingInline: 12,
		fontSize: 13,
		lineHeight: 1.45,
		color: tokens.colorTextStrong
	},
	rowRemoved: { backgroundColor: REMOVED_LINE },
	rowAdded: { backgroundColor: ADDED_LINE },
	rowMoved: { backgroundColor: MOVED_LINE },
	rowSame: {},
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
	fieldLabel: {
		marginInlineEnd: 8,
		fontSize: 11,
		color: tokens.colorTextMuted
	},
	key: {
		minWidth: 0,
		fontSize: 11,
		fontFamily: tokens.fontMono,
		color: tokens.colorTextMuted,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	place: {
		minWidth: 0,
		fontSize: 12,
		color: tokens.colorTextMuted,
		textAlign: "end",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	code: { fontFamily: tokens.fontMono, fontSize: 11 },
	textWide: { gridColumn: "2 / -1" },
	// Text as it is: line breaks and runs of spaces kept, long words broken.
	text: { minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
	empty: { fontStyle: "italic", color: tokens.colorTextMuted },
	mark: { borderRadius: 2, color: "inherit" },
	markRemoved: {
		backgroundColor: REMOVED_WORD,
		textDecorationLine: "line-through",
		textDecorationColor: "rgb(235 87 87 / 0.7)"
	},
	markAdded: { backgroundColor: ADDED_WORD },
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
	rekeyed: styles.swatchRekeyed,
	edited: styles.swatchEdited
};

const TONE = {
	removed: styles.rowRemoved,
	added: styles.rowAdded,
	moved: styles.rowMoved,
	same: styles.rowSame
};

const SIGN = {
	removed: styles.signRemoved,
	added: styles.signAdded,
	moved: styles.signMoved,
	same: styles.signSame
};
