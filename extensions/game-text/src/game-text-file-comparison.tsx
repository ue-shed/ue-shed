import * as stylex from "@stylexjs/stylex";
import {
	LocalizationFileGroup,
	type LocalizationFileChange,
	type LocalizationFileComparisonResult,
	type LocalizationFileCounts,
	type LocalizationFileField,
	type LocalizationFileFormat
} from "@ue-shed/game-text/schema";
import {
	Button,
	TextDiff,
	createEffectAction,
	textDiffFileName,
	type TextDiffEntry,
	type TextDiffField,
	type TextDiffFilter,
	type TextDiffGroup
} from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";

export type ReadyFileComparison = Extract<LocalizationFileComparisonResult, { status: "ready" }>;

const FIELD_LABELS = {
	source: "Source",
	source_plural: "Plural",
	translation: "Translation",
	path: "Path",
	notes: "Notes",
	comments: "Comments",
	references: "References",
	flags: "Flags"
} as const satisfies Record<LocalizationFileField["name"], string>;

/** Fields that hold identifiers or paths rather than prose, shown in the code font. */
const CODE_FIELDS = new Set<LocalizationFileField["name"]>(["path", "references", "flags"]);
/** Fields an added or removed entry folds away. */
const SECONDARY_FIELDS = new Set<LocalizationFileField["name"]>([
	"path",
	"notes",
	"comments",
	"references",
	"flags"
]);

/** The groups in the order the engine lists them, with what each means for the reader. */
export function fileComparisonGroups(counts: LocalizationFileCounts): TextDiffGroup[] {
	const groups: {
		readonly id: LocalizationFileGroup;
		readonly group: Omit<TextDiffGroup, "id" | "count">;
	}[] = [
		{
			id: "rekeyed",
			group: {
				label: "New key",
				tone: "rekeyed",
				description:
					"Same text under another key: translations made for the old key are lost."
			}
		},
		{
			id: "source",
			group: {
				label: "Source changed",
				tone: "edited",
				description: "A translation made for the old source is out of date."
			}
		},
		{ id: "removed", group: { label: "Removed", tone: "removed" } },
		{ id: "added", group: { label: "Added", tone: "added" } },
		{
			id: "translation",
			group: {
				label: "Translation changed",
				tone: "edited",
				description: "The source is the same."
			}
		},
		{
			id: "context",
			group: {
				label: "Notes and references only",
				tone: "edited",
				description: "Where the text is, not what it says.",
				folded: true
			}
		}
	];
	return groups.map(({ id, group }) => ({ id, count: counts[id], ...group }));
}

const fullKey = (key: { readonly namespace: string; readonly key: string }) =>
	key.namespace === "" ? key.key : `${key.namespace},${key.key}`;

/** A key Unreal generated rather than a person wrote: a GUID or a long hexadecimal hash. */
const generated = (key: string) => /^[0-9A-F]{16,}$/iu.test(key.replaceAll("-", ""));

function field(change: LocalizationFileChange, value: LocalizationFileField): TextDiffField {
	const translation = value.name === "translation";
	// Under a changed source or a new key, a translation is context the reader must check.
	const context = translation && (change.group === "source" || change.group === "rekeyed");
	const note =
		context && value.before === value.after && value.after !== undefined
			? change.group === "source"
				? "made for the old source"
				: "carried to the new key"
			: undefined;
	return {
		label:
			value.form === undefined
				? FIELD_LABELS[value.name]
				: `${FIELD_LABELS[value.name]} [${value.form}]`,
		...(value.before === undefined ? undefined : { before: value.before }),
		...(value.after === undefined ? undefined : { after: value.after }),
		...(CODE_FIELDS.has(value.name) ? { code: true } : undefined),
		...(context ? { context: true } : undefined),
		...(note === undefined ? undefined : { note }),
		...(SECONDARY_FIELDS.has(value.name) ? { secondary: true } : undefined)
	};
}

/**
 * A page of a file comparison as `TextDiff` entries: the key, its namespace as the place, each
 * field, and what a new key or a changed source means for the entry's translation.
 */
export function fileComparisonEntries(
	file: string,
	format: LocalizationFileFormat,
	changes: readonly LocalizationFileChange[],
	offset: number
): TextDiffEntry[] {
	return changes.map((change, index) => {
		const key = change.after ?? change.before;
		const fields = change.fields.map((value) => field(change, value));
		const translated = change.fields.some(
			(value) => value.name === "translation" && value.after !== undefined
		);
		const note =
			change.group === "rekeyed" &&
			change.before !== undefined &&
			change.after !== undefined &&
			generated(change.after.key) &&
			!generated(change.before.key)
				? "A key someone wrote was replaced by a generated one."
				: (change.group === "source" || change.group === "rekeyed") &&
					  format !== "manifest" &&
					  !translated
					? "Not translated."
					: undefined;
		return {
			id: String(offset + index),
			kind: change.kind,
			group: change.group,
			...(change.before
				? { before: { label: change.before.key, full: fullKey(change.before) } }
				: undefined),
			...(change.after
				? { after: { label: change.after.key, full: fullKey(change.after) } }
				: undefined),
			file,
			...(key && key.namespace !== "" ? { place: key.namespace } : undefined),
			...(note === undefined ? undefined : { note }),
			fields
		};
	});
}

/** One sentence of what the comparison found, biggest consequences first. */
export function fileComparisonSummary(counts: LocalizationFileCounts): string {
	const parts = [
		[counts.rekeyed, "moved to a new key"],
		[counts.source, "with a changed source"],
		[counts.removed, "removed"],
		[counts.added, "added"],
		[counts.translation, "with a changed translation"],
		[counts.context, "with only notes or references changed"]
	] as const;
	const found = parts
		.filter(([count]) => count > 0)
		.map(([count, words]) => `${count.toLocaleString()} ${words}`);
	const unchanged = `${counts.unchanged.toLocaleString()} unchanged.`;
	return found.length === 0
		? `The files hold the same text: ${unchanged}`
		: `${found.join(" · ")} · ${unchanged}`;
}

/** How two chosen files are named on screen. */
export interface FilePairNames {
	readonly before: string;
	readonly after: string;
}

/** The shortest ends of two paths that tell them apart, `before\Game.po` and `after\Game.po`. */
export function distinctNames(before: string, after: string): FilePairNames {
	const parts = (path: string) => path.split(/[/\\]/u);
	const a = parts(before);
	const b = parts(after);
	for (let length = 1; length <= Math.max(a.length, b.length); length += 1) {
		const tailA = a.slice(-length).join("\\");
		const tailB = b.slice(-length).join("\\");
		if (tailA !== tailB) return { before: tailA, after: tailB };
	}
	return { before: textDiffFileName(before).name, after: textDiffFileName(after).name };
}

/** Changes a comparison loads at a time. */
const PAGE = 200;
/** How long typing waits before the engine filters again. */
const QUERY_DELAY_MS = 250;

interface ChosenFile {
	readonly path: string;
	readonly format: LocalizationFileFormat;
}

/**
 * Compare two localization files: choose an older and a newer `.po`, `.archive` or `.manifest`,
 * and see which keys came, went, moved to a new key or changed, grouped by what that means for
 * their translations. The engine filters and pages over every change.
 */
export function GameTextFileComparison(props: { readonly client: GameTextClientApi }) {
	const choose = createEffectAction();
	const compare = createEffectAction();
	const [before, setBefore] = createSignal<ChosenFile>();
	const [after, setAfter] = createSignal<ChosenFile>();
	const [comparison, setComparison] = createSignal<ReadyFileComparison>();
	const [changes, setChanges] = createSignal<readonly LocalizationFileChange[]>([]);
	const [filter, setFilter] = createSignal<TextDiffFilter>({ query: "" });
	const [loading, setLoading] = createSignal(false);
	const [problem, setProblem] = createSignal<string>();
	let generation = 0;
	let typing: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(typing));

	const pick = (side: "before" | "after") => {
		const action = props.client.chooseLocalizationFile;
		if (!action) return;
		choose.run(action({ side }), {
			onFailure: () => setProblem("Couldn’t open the file picker. Try again."),
			onSuccess: (result) => {
				if (result.status === "cancelled") return;
				if (result.status === "failed") {
					setProblem(`${result.message} ${result.recovery}`);
					return;
				}
				setProblem(undefined);
				(side === "before" ? setBefore : setAfter)({
					path: result.path,
					format: result.format
				});
				reset();
			}
		});
	};
	const reset = () => {
		generation += 1;
		compare.cancel();
		setLoading(false);
		setComparison(undefined);
		setChanges([]);
		setFilter({ query: "" });
	};
	const swap = () => {
		const older = before();
		const newer = after();
		setBefore(newer);
		setAfter(older);
		reset();
	};
	/**
	 * The first page of a filter, or with `more` the next page of the open one. The filter is passed
	 * in: a signal set in the same tick still reads its old value.
	 */
	const load = (more = false, current = filter()) => {
		const action = props.client.compareLocalizationFiles;
		const older = before();
		const newer = after();
		if (!action || !older || !newer) return;
		const version = more ? generation : ++generation;
		const kind = LocalizationFileGroup.literals.find((group) => group === current.kind);
		setLoading(true);
		compare.run(
			action({
				files: { before: older.path, after: newer.path },
				filter: {
					groups: kind === undefined ? [] : [kind],
					query: current.query
				},
				changes: { offset: more ? changes().length : 0, limit: PAGE }
			}),
			{
				onFailure: () => {
					if (version !== generation) return;
					setLoading(false);
					setProblem("Couldn’t compare the files. Try again.");
				},
				onSuccess: (result) => {
					if (version !== generation) return;
					setLoading(false);
					if (result.status === "failed") {
						setProblem(`${result.message} ${result.recovery}`);
						return;
					}
					setProblem(undefined);
					setChanges((previous) =>
						more ? [...previous, ...result.changes] : result.changes
					);
					setComparison(result);
				}
			}
		);
	};
	const refilter = (next: TextDiffFilter) => {
		const typed = next.query !== filter().query;
		setFilter(next);
		clearTimeout(typing);
		if (typed) typing = setTimeout(() => load(false, next), QUERY_DELAY_MS);
		else load(false, next);
	};
	const names = createMemo(() => {
		const older = before();
		const newer = after();
		return older && newer
			? distinctNames(older.path, newer.path)
			: {
					before: older ? textDiffFileName(older.path).name : "",
					after: newer ? textDiffFileName(newer.path).name : ""
				};
	});
	const mismatch = () => {
		const older = before();
		const newer = after();
		return older !== undefined && newer !== undefined && older.format !== newer.format;
	};
	const entries = createMemo(() => {
		const open = comparison();
		return open
			? fileComparisonEntries(
					open.files.after ?? open.files.before ?? "",
					open.format,
					changes(),
					0
				)
			: [];
	});
	return (
		<div {...stylex.attrs(styles.compare)}>
			<section aria-label="Files to compare" {...stylex.attrs(styles.picker)}>
				<Slot
					label="Before"
					hint="The older file"
					file={before()}
					name={names().before}
					onChoose={() => pick("before")}
				/>
				<button
					type="button"
					aria-label="Swap before and after"
					title="Swap before and after"
					disabled={!before() && !after()}
					onClick={swap}
					{...stylex.attrs(styles.swap)}
				>
					⇄
				</button>
				<Slot
					label="After"
					hint="The newer file"
					file={after()}
					name={names().after}
					onChoose={() => pick("after")}
				/>
				<Button
					tone="primary"
					disabled={!before() || !after() || mismatch() || loading()}
					onClick={() => load()}
				>
					{loading() && !comparison() ? "Comparing…" : "Compare"}
				</Button>
			</section>
			<Show when={mismatch()}>
				<p role="alert" {...stylex.attrs(styles.problem)}>
					Both files must be the same kind: two .po, two .archive or two .manifest files.
				</p>
			</Show>
			<Show when={problem()}>
				{(message) => (
					<p role="alert" {...stylex.attrs(styles.problem)}>
						{message()}
					</p>
				)}
			</Show>
			<Show
				when={comparison()}
				fallback={
					<p {...stylex.attrs(styles.intro)}>
						Choose an older and a newer .po, .archive or .manifest of one target and
						culture to see which keys came and went, which moved to a new key, and which
						changed, grouped by what that means for their translations.
					</p>
				}
			>
				{(open) => (
					<section aria-label="File comparison" {...stylex.attrs(styles.result)}>
						<p role="status" {...stylex.attrs(styles.summary)}>
							{fileComparisonSummary(open().counts)}
						</p>
						<TextDiff
							label="Changed entries"
							entries={entries()}
							groups={fileComparisonGroups(open().counts)}
							total={open().total}
							filter={filter()}
							onFilter={refilter}
							loadingMore={loading()}
							onMore={() => load(true)}
						/>
					</section>
				)}
			</Show>
		</div>
	);
}

function Slot(props: {
	readonly label: string;
	readonly hint: string;
	readonly file: ChosenFile | undefined;
	readonly name: string;
	readonly onChoose: () => void;
}) {
	return (
		<div role="group" aria-label={props.label} {...stylex.attrs(styles.slot)}>
			<span {...stylex.attrs(styles.slotLabel)}>{props.label}</span>
			<Show
				when={props.file}
				fallback={<span {...stylex.attrs(styles.slotEmpty)}>{props.hint}</span>}
			>
				{(file) => (
					<span {...stylex.attrs(styles.slotFile)} title={file().path}>
						<span {...stylex.attrs(styles.slotName)}>{props.name}</span>
						<span {...stylex.attrs(styles.slotFolder)}>
							{textDiffFileName(file().path).folder}
						</span>
					</span>
				)}
			</Show>
			<Button size="compact" tone="quiet" onClick={() => props.onChoose()}>
				{props.file ? "Change…" : "Choose…"}
			</Button>
		</div>
	);
}

const styles = stylex.create({
	compare: {
		display: "grid",
		alignContent: "start",
		gap: 12,
		minHeight: 0,
		overflowY: "auto",
		padding: 16
	},
	picker: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 8
	},
	slot: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		minWidth: 0,
		paddingBlock: 8,
		paddingInline: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface
	},
	slotLabel: {
		flexShrink: 0,
		fontSize: 11,
		fontWeight: 600,
		textTransform: "uppercase",
		letterSpacing: "0.04em",
		color: tokens.colorTextMuted
	},
	slotEmpty: { flex: 1, fontSize: 12, color: tokens.colorTextMuted },
	slotFile: { display: "grid", flex: 1, minWidth: 0 },
	slotName: {
		fontFamily: tokens.fontMono,
		fontSize: 12,
		color: tokens.colorTextStrong,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	slotFolder: {
		fontFamily: tokens.fontMono,
		fontSize: 11,
		color: tokens.colorTextMuted,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		direction: "rtl",
		textAlign: "left"
	},
	swap: {
		width: 32,
		height: 32,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		backgroundColor: "transparent",
		color: tokens.colorText,
		fontSize: 14,
		cursor: { default: "pointer", ":disabled": "default" },
		opacity: { default: 1, ":disabled": 0.45 }
	},
	problem: { margin: 0, fontSize: 12, color: tokens.colorWarning },
	intro: { margin: 0, maxWidth: 720, fontSize: 13, color: tokens.colorTextMuted },
	result: { display: "grid", gap: 10 },
	summary: { margin: 0, fontSize: 13, color: tokens.colorTextStrong }
});
