import * as stylex from "@stylexjs/stylex";
import type {
	LocalizationLineId,
	LocalizationLinePreview,
	TextCorpusSearchPage,
	TextCorpusSearchRequest,
	TextGroup,
	TextGroupBy,
	TextUnitId
} from "@ue-shed/game-text/browser";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createEffect, createSignal, untrack } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextResultRows } from "./game-text-result-rows.js";

const SEVERE = new Set(["key_changed", "conflicting_source"]);

/** One row of a loaded page, as the list selects it. */
export interface LoadedRow {
	readonly unit: TextUnitId | undefined;
	readonly line: LocalizationLineId | undefined;
	/** The line as listed, for selecting ranges of lines. */
	readonly preview?: LocalizationLinePreview;
}

/** A page's rows in display order: localization lines with their first listed unit, or units. */
function loadedRows(page: TextCorpusSearchPage): readonly LoadedRow[] {
	if (!page.localization) return page.units.map((unit) => ({ unit: unit.id, line: undefined }));
	const units = new Set(page.units.map((unit) => unit.id));
	return page.localization.lines.map((line) => ({
		line: line.id,
		preview: line,
		unit:
			line.origin.kind === "corpus"
				? line.origin.unitIds.find((id) => units.has(id))
				: undefined
	}));
}
/** Tick boxes for bulk actions, passed through to every group's rows. */
export interface RowTicks {
	readonly checked: (line: LocalizationLineId) => boolean;
	readonly onCheck: (line: LocalizationLinePreview, range: boolean) => void;
	readonly checking: boolean;
}
const WAITING = new Set(["not_gathered", "changed_since_gather", "translation"]);

/**
 * The matching lines in groups, worst first. Each group shows its count and the lines that need
 * work; opening one loads its first page, and only open groups cost a request.
 */
export function GroupedResults(props: {
	readonly by: TextGroupBy;
	readonly groups: readonly TextGroup[];
	readonly more: number;
	readonly request: TextCorpusSearchRequest;
	readonly client: GameTextClientApi;
	readonly culture: string | undefined;
	/** The picked cultures; every culture when empty or absent. */
	readonly cultures?: readonly string[];
	readonly selectedId: TextUnitId | undefined;
	readonly selectedLocalizationId: LocalizationLineId | undefined;
	readonly onSelect: (unit: TextUnitId | undefined, line: LocalizationLineId | undefined) => void;
	/** A group's rows, in order, each time it loads a page; the line page steps through them. */
	readonly onLoaded?: (group: string, rows: readonly LoadedRow[]) => void;
	readonly ticks?: RowTicks | undefined;
}) {
	// When every line fits on one page all groups start open; otherwise the worst one does. What
	// you open or close is kept while the groups change.
	const [toggled, setToggled] = createSignal<ReadonlyMap<string, boolean>>(new Map());
	const fits = () =>
		props.more === 0 && props.groups.reduce((sum, group) => sum + group.count, 0) <= 50;
	const isOpen = (group: TextGroup, index: number) =>
		toggled().get(group.key) ?? (fits() || index === 0);
	return (
		<div {...stylex.attrs(styles.list)}>
			<For each={props.groups}>
				{(group, index) => (
					<GroupSection
						by={props.by}
						group={group}
						open={isOpen(group, index())}
						onToggle={() =>
							setToggled((current) =>
								new Map(current).set(group.key, !isOpen(group, index()))
							)
						}
						request={props.request}
						client={props.client}
						culture={props.culture}
						cultures={props.cultures ?? []}
						selectedId={props.selectedId}
						selectedLocalizationId={props.selectedLocalizationId}
						onSelect={props.onSelect}
						{...(props.onLoaded === undefined
							? undefined
							: { onLoaded: props.onLoaded })}
						ticks={props.ticks}
					/>
				)}
			</For>
			<Show when={props.more > 0}>
				<p {...stylex.attrs(styles.more)}>
					{props.more.toLocaleString()} more groups. Filter to narrow them.
				</p>
			</Show>
		</div>
	);
}

function GroupSection(props: {
	readonly by: TextGroupBy;
	readonly group: TextGroup;
	readonly open: boolean;
	readonly onToggle: () => void;
	readonly request: TextCorpusSearchRequest;
	readonly client: GameTextClientApi;
	readonly culture: string | undefined;
	/** The picked cultures; every culture when empty or absent. */
	readonly cultures?: readonly string[];
	readonly selectedId: TextUnitId | undefined;
	readonly selectedLocalizationId: LocalizationLineId | undefined;
	readonly onSelect: (unit: TextUnitId | undefined, line: LocalizationLineId | undefined) => void;
	readonly onLoaded?: (group: string, rows: readonly LoadedRow[]) => void;
	readonly ticks?: RowTicks | undefined;
}) {
	const action = createEffectAction();
	const [page, setPage] = createSignal<TextCorpusSearchPage>();
	const [loading, setLoading] = createSignal(false);
	// The effect passes the request and key it tracked; "Show more" reads them in its handler.
	const load = (more: boolean, base: TextCorpusSearchRequest, key: string) => {
		const current = untrack(page);
		const request: TextCorpusSearchRequest = {
			...base,
			openGroup: key,
			...(more && current?.localization?.nextCursor
				? { localizationCursor: current.localization.nextCursor }
				: more && current?.nextCursor
					? { cursor: current.nextCursor }
					: undefined)
		};
		setLoading(true);
		action.run(props.client.search(request), {
			onSuccess: (result) => {
				setLoading(false);
				if (result.status !== "ready") return;
				const previous = untrack(page);
				const merged =
					more && previous
						? {
								...result.page,
								units: [...previous.units, ...result.page.units],
								...(result.page.localization && previous.localization
									? {
											localization: {
												...result.page.localization,
												lines: [
													...previous.localization.lines,
													...result.page.localization.lines
												]
											}
										}
									: undefined)
							}
						: result.page;
				setPage(merged);
				props.onLoaded?.(key, loadedRows(merged));
			},
			onFailure: () => setLoading(false)
		});
	};
	createEffect(
		() => ({
			open: props.open,
			request: props.request,
			key: props.group.key,
			count: props.group.count
		}),
		({ open, request, key }) => {
			if (open) load(false, request, key);
			else {
				action.cancel();
				setPage(undefined);
				props.onLoaded?.(key, []);
			}
		}
	);
	const label = () =>
		props.group.label === ""
			? props.by === "folder"
				? "Project root"
				: props.by === "namespace"
					? "No namespace"
					: "Unknown"
			: props.group.label;
	const listed = () => page()?.localization?.lines.length ?? page()?.units.length ?? 0;
	return (
		<section
			aria-label={label()}
			data-group={props.group.key}
			{...stylex.attrs(styles.section)}
		>
			<button
				type="button"
				aria-expanded={props.open ? "true" : "false"}
				onClick={() => props.onToggle()}
				{...stylex.attrs(styles.header)}
			>
				<span aria-hidden="true" {...stylex.attrs(styles.twist)}>
					{props.open ? "▾" : "▸"}
				</span>
				<span
					{...stylex.attrs(
						styles.name,
						props.by === "folder" || props.by === "asset" ? styles.mono : undefined,
						props.by === "problem" && SEVERE.has(props.group.key) && styles.severe,
						props.by === "problem" && WAITING.has(props.group.key) && styles.waiting
					)}
				>
					{label()}
				</span>
				<span {...stylex.attrs(styles.count)}>{props.group.count.toLocaleString()}</span>
				<Show when={props.by !== "problem" && props.group.needWork > 0}>
					<span
						{...stylex.attrs(
							styles.need,
							SEVERE.has(props.group.worst) ? styles.severe : styles.waiting
						)}
					>
						{props.group.needWork.toLocaleString()} need work
					</span>
				</Show>
			</button>
			<Show when={props.open}>
				<Show
					when={page()}
					fallback={
						<p role="status" {...stylex.attrs(styles.more)}>
							Loading…
						</p>
					}
				>
					{(current) => (
						<>
							<GameTextResultRows
								page={current()}
								culture={props.culture}
								cultures={props.cultures ?? []}
								selectedId={props.selectedId}
								selectedLocalizationId={props.selectedLocalizationId}
								onSelect={props.onSelect}
								checked={props.ticks?.checked}
								onCheck={props.ticks?.onCheck}
								checking={props.ticks?.checking}
							/>
							<Show when={current().localization?.nextCursor ?? current().nextCursor}>
								<div {...stylex.attrs(styles.more)}>
									<Button
										size="compact"
										tone="quiet"
										disabled={loading()}
										data-more=""
										onClick={() => load(true, props.request, props.group.key)}
									>
										Show more ({(props.group.count - listed()).toLocaleString()}{" "}
										left)
									</Button>
								</div>
							</Show>
						</>
					)}
				</Show>
			</Show>
		</section>
	);
}

const styles = stylex.create({
	list: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", alignContent: "start" },
	section: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" },
	header: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		minHeight: 32,
		paddingInline: 10,
		borderWidth: 0,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		backgroundColor: { default: tokens.colorSurfaceRaised, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontBody,
		fontSize: 12.5,
		fontWeight: 500,
		textAlign: "start",
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	twist: { width: 10, color: tokens.colorTextMuted, fontSize: 9 },
	name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	mono: { fontFamily: tokens.fontMono, fontSize: 12 },
	count: { color: tokens.colorTextMuted, fontWeight: 400, fontVariantNumeric: "tabular-nums" },
	need: { marginLeft: "auto", fontWeight: 400, fontSize: 12 },
	severe: { color: tokens.colorDanger },
	waiting: { color: tokens.colorWarning },
	more: {
		margin: 0,
		paddingBlock: 6,
		paddingInline: 34,
		color: tokens.colorTextMuted,
		fontSize: 12
	}
});
