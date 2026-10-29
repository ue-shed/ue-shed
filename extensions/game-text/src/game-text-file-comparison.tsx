import * as stylex from "@stylexjs/stylex";
import {
	LocalizationFileGroup,
	type LocalizationFileAsset,
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
	type TextDiffGroup,
	type TextDiffKey
} from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
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
/** Groups whose entries show their translation even unchanged: the reader has to check it. */
const TRANSLATION_CONTEXT = new Set<LocalizationFileGroup>(["rekeyed", "reworded", "retouched"]);

/**
 * The groups in the order the engine lists them, each with what it means for translations. A
 * manifest holds no translations: its new keys are a risk because the archives still hold the old
 * key.
 */
export function fileComparisonGroups(
	format: LocalizationFileFormat,
	counts: LocalizationFileCounts,
	listed: LocalizationFileCounts
): TextDiffGroup[] {
	const manifest = format === "manifest";
	const groups = [
		{
			id: "rekeyed",
			label: manifest ? "New key" : "New key, translation lost",
			tone: "attention",
			description: manifest
				? "The archives still hold translations under the old key."
				: "The translation stayed with the old key."
		},
		{
			id: "reworded",
			label: "Wording changed",
			tone: "attention",
			description: "Translations made for the old wording need redoing."
		},
		{
			id: "retouched",
			label: "Case, punctuation or spacing",
			tone: "attention",
			description: "Only the source's case, punctuation or spacing changed."
		},
		{ id: "removed", label: "Removed", tone: "removed" },
		{ id: "added", label: "Added", tone: "added" },
		{
			id: "translation",
			label: "Translation changed",
			tone: "changed",
			description: "The source is the same."
		},
		{
			id: "carried",
			label: "New key, translation kept",
			tone: "quiet",
			description: "Same text and translation under a new key."
		},
		{
			id: "context",
			label: "Notes and references only",
			tone: "quiet",
			description: "Where the text is, not what it says.",
			folded: true
		}
	] as const satisfies readonly (Omit<TextDiffGroup, "count"> & {
		readonly id: LocalizationFileGroup;
	})[];
	return groups.map((group) => ({
		...group,
		count: counts[group.id],
		...(listed[group.id] === counts[group.id] ? undefined : { listed: listed[group.id] })
	}));
}

/** A key Unreal generated rather than a person wrote: a GUID or a long hexadecimal hash. */
const generated = (key: string) => /^[0-9A-F]{16,}$/iu.test(key.replaceAll("-", ""));

/** A key as listed: a generated one shortened, its namespace when that is what changed. */
function keyLabel(key: LocalizationFileChange["after"] & object, namespaced: boolean): TextDiffKey {
	const full = key.namespace === "" ? key.key : `${key.namespace},${key.key}`;
	const short = generated(key.key) ? `${key.key.slice(0, 8)}…` : key.key;
	return { label: namespaced ? `${key.namespace || "(no namespace)"}, ${short}` : short, full };
}

function field(change: LocalizationFileChange, value: LocalizationFileField): TextDiffField {
	const translation = value.name === "translation";
	const source = change.fields.find((each) => each.name === "source")?.after;
	const note =
		translation && value.after !== undefined && value.after === source
			? "same as the source"
			: undefined;
	return {
		label:
			value.form === undefined
				? FIELD_LABELS[value.name]
				: `${FIELD_LABELS[value.name]} [${value.form}]`,
		...(value.before === undefined ? undefined : { before: value.before }),
		...(value.after === undefined ? undefined : { after: value.after }),
		...(CODE_FIELDS.has(value.name) ? { code: true } : undefined),
		...(translation && TRANSLATION_CONTEXT.has(change.group) ? { context: true } : undefined),
		...(note === undefined ? undefined : { note }),
		...(SECONDARY_FIELDS.has(value.name) ? { secondary: true } : undefined)
	};
}

/** What an entry's change means when it is the exception in its group. */
function entryNote(
	change: LocalizationFileChange,
	format: LocalizationFileFormat
): string | undefined {
	if (format === "manifest") return undefined;
	const translations = change.fields.filter((each) => each.name === "translation");
	const cleared = translations.some(
		(each) => each.before !== undefined && each.after === undefined
	);
	if (cleared && change.group !== "removed")
		return "Now untranslated: the game shows the source.";
	if (change.group === "added" && translations.length === 0) return "Not translated.";
	return undefined;
}

/**
 * A page of a file comparison as `TextDiff` entries: the key, its namespace as the place, each
 * field, and a note where an entry is the exception in its group.
 */
export function fileComparisonEntries(
	file: string,
	format: LocalizationFileFormat,
	changes: readonly LocalizationFileChange[],
	offset: number
): TextDiffEntry[] {
	return changes.map((change, index) => {
		const key = change.after ?? change.before;
		const namespaced =
			change.before !== undefined &&
			change.after !== undefined &&
			change.before.namespace !== change.after.namespace;
		const note = entryNote(change, format);
		return {
			id: String(offset + index),
			kind: change.kind,
			group: change.group,
			...(change.before ? { before: keyLabel(change.before, namespaced) } : undefined),
			...(change.after ? { after: keyLabel(change.after, namespaced) } : undefined),
			file,
			...(key && key.namespace !== "" && !namespaced ? { place: key.namespace } : undefined),
			...(note === undefined ? undefined : { note }),
			fields: change.fields.map((value) => field(change, value))
		};
	});
}

/** What the comparison means for translators first, then everything else. */
export function fileComparisonSummary(
	format: LocalizationFileFormat,
	counts: LocalizationFileCounts
): string {
	const count = (value: number, words: string) =>
		value > 0 ? [`${value.toLocaleString()} ${words}`] : [];
	const work = [
		...count(counts.rekeyed, format === "manifest" ? "new keys" : "lost on a new key"),
		...count(counts.reworded, "reworded"),
		...count(counts.retouched, "retouched")
	];
	const other = [
		...count(counts.removed, "removed"),
		...count(counts.added, "added"),
		...count(counts.translation, "translations changed"),
		...count(counts.carried, "moved with their translation"),
		...count(counts.context, "notes or references only"),
		`${counts.unchanged.toLocaleString()} unchanged`
	];
	return work.length === 0
		? `Nothing for translators to redo. ${other.join(" · ")}.`
		: `For translators: ${work.join(" · ")}. Also ${other.join(" · ")}.`;
}

/** How two chosen files are named on screen. */
export interface FilePairNames {
	readonly before: string;
	readonly after: string;
}

/** The shortest ends of two paths that tell them apart, `before\Game.po` and `after\Game.po`. */
export function distinctNames(before: string, after: string): FilePairNames {
	const parts = (path: string) => path.split(/[/\\]/u);
	// Tails keep the paths' own separator.
	const separator = before.includes("\\") ? "\\" : "/";
	const a = parts(before);
	const b = parts(after);
	for (let length = 1; length <= Math.max(a.length, b.length); length += 1) {
		const tailA = a.slice(-length).join(separator);
		const tailB = b.slice(-length).join(separator);
		if (tailA !== tailB) return { before: tailA, after: tailB };
	}
	return { before: textDiffFileName(before).name, after: textDiffFileName(after).name };
}

/** Changes a filtered comparison loads at a time. */
const PAGE = 200;
/** Changes of each group an unfiltered comparison shows. */
const PREVIEW = 5;
/** How long typing waits before the engine filters again. */
const QUERY_DELAY_MS = 250;

interface ChosenFile {
	readonly path: string;
	readonly format: LocalizationFileFormat;
}

/** What the comparison lists: the diff's group and text filter, and a rollup's asset. */
interface ComparisonView {
	readonly filter: TextDiffFilter;
	/** Only this asset's changes, picked from a rollup; every asset when empty. */
	readonly asset: string;
}

const EVERYTHING: ComparisonView = { filter: { query: "" }, asset: "" };

/** Whether a view lists everything, as an overview of a few changes per group. */
const overview = (view: ComparisonView) =>
	view.filter.kind === undefined && view.filter.query.trim() === "" && view.asset === "";

/**
 * Compare two localization files: choose an older and a newer `.po`, `.archive` or `.manifest`,
 * and see which keys came, went, moved to a new key or changed, grouped by what that means for
 * their translations. The engine filters and pages over every change; unfiltered, each group shows
 * a few changes and the assets most of them come from.
 *
 * `hidden` keeps the chosen files and the comparison while another view is shown.
 */
export function GameTextFileComparison(props: {
	readonly client: GameTextClientApi;
	readonly hidden?: boolean;
}) {
	const choose = createEffectAction();
	const compare = createEffectAction();
	const [before, setBefore] = createSignal<ChosenFile>();
	const [after, setAfter] = createSignal<ChosenFile>();
	const [comparison, setComparison] = createSignal<ReadyFileComparison>();
	// Entries are mapped once per page and appended, so a later page leaves earlier ones as they are.
	const [entries, setEntries] = createSignal<readonly TextDiffEntry[]>([]);
	const [view, setView] = createSignal<ComparisonView>(EVERYTHING);
	const [loading, setLoading] = createSignal(false);
	const [problem, setProblem] = createSignal<string>();
	let generation = 0;
	let typing: ReturnType<typeof setTimeout> | undefined;
	const stopTyping = () => {
		clearTimeout(typing);
		typing = undefined;
	};
	onCleanup(stopTyping);

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
				(side === "before" ? setBefore : setAfter)({
					path: result.path,
					format: result.format
				});
				reset();
			}
		});
	};
	/** Forgets the comparison and anything about to load, for files that changed. */
	const reset = () => {
		generation += 1;
		stopTyping();
		compare.cancel();
		setLoading(false);
		setProblem(undefined);
		setComparison(undefined);
		setEntries([]);
		setView(EVERYTHING);
	};
	const swap = () => {
		const older = before();
		const newer = after();
		setBefore(newer);
		setAfter(older);
		reset();
	};
	/** Why the chosen files cannot be compared, if they cannot. */
	const blocked = () => {
		const older = before();
		const newer = after();
		if (older === undefined || newer === undefined) return undefined;
		if (older.path === newer.path)
			return "Before and after are the same file. Choose two revisions.";
		if (older.format !== newer.format)
			return "Both files must be the same kind: two .po, two .archive or two .manifest files.";
		return undefined;
	};
	/**
	 * The first page of a view, or with `more` the next page of the open one. The view is passed
	 * in: a signal set in the same tick still reads its old value. If a fresh view fails, `restore`
	 * puts back the one whose list is still on screen.
	 */
	const load = (more: boolean, current: ComparisonView, restore?: ComparisonView) => {
		const action = props.client.compareLocalizationFiles;
		const older = before();
		const newer = after();
		if (!action || !older || !newer || blocked() !== undefined) return;
		const version = more ? generation : ++generation;
		const kind = LocalizationFileGroup.literals.find((group) => group === current.filter.kind);
		const failed = (message: string) => {
			setProblem(message);
			if (!more && restore !== undefined) setView(restore);
		};
		setLoading(true);
		compare.run(
			action({
				files: { before: older.path, after: newer.path },
				filter: {
					groups: kind === undefined ? [] : [kind],
					query: current.filter.query,
					asset: current.asset,
					preview: overview(current) ? PREVIEW : 0
				},
				changes: { offset: more ? entries().length : 0, limit: PAGE }
			}),
			{
				onFailure: () => {
					if (version !== generation) return;
					setLoading(false);
					failed("Couldn’t compare the files. Try again.");
				},
				onSuccess: (result) => {
					if (version !== generation) return;
					setLoading(false);
					if (result.status === "failed") {
						failed(`${result.message} ${result.recovery}`);
						return;
					}
					setProblem(undefined);
					const file = result.files.after ?? result.files.before ?? "";
					setEntries((previous) => {
						const page = fileComparisonEntries(
							file,
							result.format,
							result.changes,
							more ? previous.length : 0
						);
						return more ? [...previous, ...page] : page;
					});
					setComparison(result);
				}
			}
		);
	};
	// Two files that can be compared are compared as soon as both are chosen.
	createEffect(
		() => [before(), after()] as const,
		([older, newer]) => {
			if (older && newer && blocked() === undefined) load(false, EVERYTHING);
		}
	);
	/** Shows a new view: at once for a click, after a pause for typing. */
	const show = (next: ComparisonView, typed: boolean) => {
		const shown = view();
		setView(next);
		stopTyping();
		if (typed) typing = setTimeout(() => load(false, next, shown), QUERY_DELAY_MS);
		else load(false, next, shown);
	};
	const refilter = (filter: TextDiffFilter) =>
		show({ ...view(), filter }, filter.query !== view().filter.query);
	/** The next page; a filter still being typed loads its first page instead. */
	const more = () => {
		if (typing === undefined) load(true, view());
		else {
			stopTyping();
			load(false, view());
		}
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
	const lead = (group: TextDiffGroup) => {
		const open = comparison();
		const assets = open?.assets.filter((asset) => asset.group === group.id) ?? [];
		// One asset with one change says nothing the entry does not; a picked asset is shown above.
		if (
			view().asset !== "" ||
			assets.length === 0 ||
			(assets.length === 1 && (assets[0]?.count ?? 0) < 2)
		)
			return <></>;
		return (
			<Rollup
				assets={assets}
				onPick={(asset) =>
					show({ filter: { kind: group.id, query: view().filter.query }, asset }, false)
				}
			/>
		);
	};
	return (
		<div {...stylex.attrs(styles.compare, props.hidden === true && styles.hidden)}>
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
					tone="quiet"
					disabled={!before() || !after() || blocked() !== undefined || loading()}
					onClick={() => {
						stopTyping();
						load(false, view());
					}}
				>
					{loading() ? "Comparing…" : "Compare again"}
				</Button>
			</section>
			<Show when={blocked() ?? problem()}>
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
							{fileComparisonSummary(open().format, open().counts)}
						</p>
						<Show when={view().asset !== "" ? view().asset : undefined}>
							{(asset) => (
								<p {...stylex.attrs(styles.assetFilter)}>
									Only changes from <code>{asset()}</code>
									<Button
										size="compact"
										tone="quiet"
										onClick={() => show({ ...view(), asset: "" }, false)}
									>
										Show every asset
									</Button>
								</p>
							)}
						</Show>
						<TextDiff
							label="Changed entries"
							entries={entries()}
							groups={fileComparisonGroups(
								open().format,
								open().counts,
								open().listed
							)}
							total={open().total}
							filter={view().filter}
							onFilter={refilter}
							overview={overview(view())}
							sectionLead={lead}
							loadingMore={loading()}
							onMore={more}
						/>
					</section>
				)}
			</Show>
		</div>
	);
}

/** The assets most of a group's changes come from; picking one filters the group to it. */
function Rollup(props: {
	readonly assets: readonly LocalizationFileAsset[];
	readonly onPick: (asset: string) => void;
}) {
	return (
		<ul aria-label="Most changes come from" {...stylex.attrs(styles.rollup)}>
			<For each={props.assets}>
				{(asset) => (
					<li>
						<button
							type="button"
							onClick={() => props.onPick(asset.asset)}
							{...stylex.attrs(styles.asset)}
						>
							<Show when={asset.previous}>
								{(previous) => (
									<>
										<span {...stylex.attrs(styles.assetName)}>
											{previous()}
										</span>
										<span aria-hidden="true">→</span>
									</>
								)}
							</Show>
							<span {...stylex.attrs(styles.assetName)}>{asset.asset}</span>
							<span {...stylex.attrs(styles.assetCount)}>
								{asset.count.toLocaleString()}
							</span>
							<Show when={asset.generated > 0}>
								<span {...stylex.attrs(styles.assetNote)}>
									{asset.generated === asset.count
										? "every"
										: asset.generated.toLocaleString()}{" "}
									written key replaced by a generated one
								</span>
							</Show>
						</button>
					</li>
				)}
			</For>
		</ul>
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
	summary: { margin: 0, fontSize: 13, color: tokens.colorTextStrong },
	hidden: { display: "none" },
	assetFilter: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		margin: 0,
		fontSize: 12,
		color: tokens.colorText
	},
	rollup: {
		display: "flex",
		flexWrap: "wrap",
		gap: 6,
		margin: 0,
		padding: 0,
		listStyle: "none"
	},
	asset: {
		display: "flex",
		alignItems: "baseline",
		gap: 6,
		paddingBlock: 3,
		paddingInline: 8,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		fontSize: 12,
		cursor: "pointer"
	},
	assetName: { fontFamily: tokens.fontMono, fontSize: 11 },
	assetCount: { fontVariantNumeric: "tabular-nums", color: tokens.colorTextStrong },
	assetNote: { fontSize: 11, color: tokens.colorWarning }
});
