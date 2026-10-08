import * as stylex from "@stylexjs/stylex";
import {
	TEXT_PROBLEM_LABELS,
	TextOriginKind,
	TextProblem,
	type TextCorpusSearchPage,
	type TextFilter,
	type TextGroup,
	type TextGroupBy
} from "@ue-shed/game-text/browser";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createSignal } from "solid-js";
import { hasValue, toggleValue } from "./game-text-filter-model.js";
import { FolderBrowser } from "./game-text-folder-browser.js";

const SEVERE = new Set<string>(["key_changed", "conflicting_source"]);
const WAITING = new Set<string>(["not_gathered", "changed_since_gather", "translation"]);
type Tab = "folders" | "assets" | "origins";

/**
 * Where the matching lines are, until a line is opened: problems (unless the list is grouped by
 * them) and folders, assets and origins, worst first. A name adds its filter; a folder's arrow
 * opens the folders inside it.
 */
export function FacetsPane(props: {
	readonly page: TextCorpusSearchPage | undefined;
	readonly group: TextGroupBy | undefined;
	readonly filter: TextFilter;
	readonly folder: string;
	readonly onFolderChange: (folder: string) => void;
	readonly onFilterChange: (filter: TextFilter) => void;
}) {
	const [tab, setTab] = createSignal<Tab>("folders");
	const problems = () =>
		TextProblem.literals.flatMap((problem) => {
			const count = props.page?.problems?.[problem] ?? 0;
			return count > 0 || hasValue(props.filter, "problem", problem)
				? [{ problem, count }]
				: [];
		});
	const entries = (): readonly TextGroup[] => {
		const facets = props.page?.facets;
		if (tab() === "folders") return facets?.folders?.entries ?? [];
		if (tab() === "assets") return facets?.assets?.entries ?? [];
		return facets?.origins?.entries ?? [];
	};
	const more = () => {
		const facets = props.page?.facets;
		return (
			(tab() === "folders"
				? facets?.folders?.more
				: tab() === "assets"
					? facets?.assets?.more
					: facets?.origins?.more) ?? 0
		);
	};
	// Folders have their own browser; assets and origins are flat lists.
	const field = () => (tab() === "assets" ? "asset" : "origin");
	const value = (entry: TextGroup) => entry.key;
	const toggle = (entry: TextGroup) => {
		if (tab() === "assets") {
			props.onFilterChange(
				toggleValue(props.filter, { field: "asset", op: "is", values: [entry.key] })
			);
			return;
		}
		const origin = TextOriginKind.literals.find((item) => item === entry.key);
		if (origin !== undefined)
			props.onFilterChange(
				toggleValue(props.filter, { field: "origin", op: "is", values: [origin] })
			);
	};
	return (
		<div {...stylex.attrs(styles.pane)}>
			<Show when={props.group !== "problem" && problems().length > 0}>
				<section aria-label="Problems" {...stylex.attrs(styles.card)}>
					<h3 {...stylex.attrs(styles.head)}>Problems</h3>
					<For each={problems()}>
						{(item) => (
							<button
								type="button"
								aria-pressed={
									hasValue(props.filter, "problem", item.problem)
										? "true"
										: "false"
								}
								onClick={() =>
									props.onFilterChange(
										toggleValue(props.filter, {
											field: "problem",
											op: "is",
											values: [item.problem]
										})
									)
								}
								{...stylex.attrs(
									styles.facet,
									hasValue(props.filter, "problem", item.problem) && styles.chosen
								)}
							>
								<span
									{...stylex.attrs(
										styles.name,
										SEVERE.has(item.problem) && styles.severe,
										WAITING.has(item.problem) && styles.waiting,
										!SEVERE.has(item.problem) &&
											!WAITING.has(item.problem) &&
											styles.quiet
									)}
								>
									{TEXT_PROBLEM_LABELS[item.problem]}
								</span>
								<span {...stylex.attrs(styles.count)}>
									{item.count.toLocaleString()}
								</span>
							</button>
						)}
					</For>
				</section>
			</Show>
			<section aria-label="Where the lines are" {...stylex.attrs(styles.card)}>
				<div role="tablist" aria-label="Where the lines are" {...stylex.attrs(styles.tabs)}>
					<For each={["folders", "assets", "origins"] satisfies Tab[]}>
						{(item) => (
							<button
								type="button"
								role="tab"
								aria-selected={tab() === item ? "true" : "false"}
								onClick={() => setTab(item)}
								{...stylex.attrs(styles.tab, tab() === item && styles.tabOn)}
							>
								{item === "folders"
									? "Folders"
									: item === "assets"
										? "Assets"
										: "Origins"}
							</button>
						)}
					</For>
				</div>
				<Show when={tab() === "folders"}>
					<FolderBrowser
						list={props.page?.facets?.folders}
						folder={props.folder}
						filter={props.filter}
						onFolderChange={props.onFolderChange}
						onFilterChange={props.onFilterChange}
					/>
				</Show>
				<For each={tab() === "folders" ? [] : entries()}>
					{(entry) => (
						<div {...stylex.attrs(styles.row)}>
							<button
								type="button"
								aria-pressed={
									hasValue(props.filter, field(), value(entry)) ? "true" : "false"
								}
								onClick={() => toggle(entry)}
								{...stylex.attrs(
									styles.facet,
									hasValue(props.filter, field(), value(entry)) && styles.chosen
								)}
							>
								<span
									{...stylex.attrs(
										styles.name,
										tab() === "assets" ? styles.mono : undefined
									)}
								>
									{entry.label}
								</span>
								<span {...stylex.attrs(styles.count)}>
									<Show when={entry.needWork > 0}>
										<span
											{...stylex.attrs(
												SEVERE.has(entry.worst)
													? styles.severe
													: styles.waiting
											)}
										>
											{entry.needWork.toLocaleString()}
										</span>
										{" · "}
									</Show>
									{entry.count.toLocaleString()}
								</span>
							</button>
						</div>
					)}
				</For>
				<Show when={tab() !== "folders" && entries().length === 0}>
					<p {...stylex.attrs(styles.empty)}>Nothing here.</p>
				</Show>
				<Show when={tab() !== "folders" && more() > 0}>
					<p {...stylex.attrs(styles.empty)}>
						{more().toLocaleString()} more, by problems.
					</p>
				</Show>
			</section>
		</div>
	);
}

const styles = stylex.create({
	pane: { display: "grid", gap: 10, alignContent: "start" },
	card: {
		display: "grid",
		gap: 2,
		padding: 8,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: 8,
		backgroundColor: tokens.colorSurface
	},
	head: {
		margin: 0,
		paddingInline: 6,
		paddingBottom: 4,
		color: tokens.colorTextMuted,
		fontSize: 11.5
	},
	tabs: { display: "flex", gap: 2, paddingBottom: 6 },
	tab: {
		paddingBlock: 3,
		paddingInline: 9,
		borderWidth: 0,
		borderRadius: 5,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontBody,
		fontSize: 12,
		cursor: "pointer"
	},
	tabOn: { backgroundColor: tokens.colorSurfaceHover, color: tokens.colorTextStrong },
	row: { display: "flex", alignItems: "center", gap: 2 },
	facet: {
		flex: 1,
		minWidth: 0,
		display: "flex",
		alignItems: "center",
		gap: 8,
		minHeight: 26,
		paddingInline: 6,
		borderWidth: 0,
		borderRadius: 5,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12.5,
		textAlign: "start",
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	chosen: { backgroundColor: tokens.colorAccentWash, color: tokens.colorTextStrong },
	up: { color: tokens.colorTextMuted },
	into: {
		width: 22,
		height: 22,
		borderWidth: 0,
		borderRadius: 4,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		cursor: "pointer"
	},
	name: {
		flex: 1,
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	mono: { fontFamily: tokens.fontMono, fontSize: 12 },
	count: { color: tokens.colorTextMuted, fontVariantNumeric: "tabular-nums", fontSize: 12 },
	severe: { color: tokens.colorDanger },
	waiting: { color: tokens.colorWarning },
	quiet: { color: tokens.colorTextMuted },
	empty: {
		margin: 0,
		paddingInline: 6,
		paddingBlock: 4,
		color: tokens.colorTextMuted,
		fontSize: 12
	}
});
