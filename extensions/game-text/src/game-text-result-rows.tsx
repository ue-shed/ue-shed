import * as stylex from "@stylexjs/stylex";
import { textReviewSignalLabel } from "@ue-shed/game-text/labels";
import { manifestPathOrigin } from "@ue-shed/game-text/rules";
import {
	type LocalizationLineId,
	type LocalizationLinePreview,
	type TextCorpusRows,
	type TextUnitId,
	type TextUnitSearchResult
} from "@ue-shed/game-text/schema";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show } from "solid-js";
import { CultureStrip } from "./game-text-culture-strip.js";
import { cultureCell, cultureSummary, lineState } from "./game-text-culture-state.js";
import { localizationLabels } from "./game-text-localization-view.js";
import { browseStateLabel, browseStyles, stateTone } from "./game-text-browse-chrome.js";
import { identityLabel, sourceText, textContext } from "./game-text-view.js";
import { styles } from "./game-text-styles.js";

type ResultRow = {
	readonly line: LocalizationLinePreview | undefined;
	readonly unit: TextUnitSearchResult | undefined;
};

/** The translation column only shows with one culture picked; with more, the state strip covers them. */
/** The labels of a row's findings, with how many more it has. */
export function rowFindings(
	row: { readonly findings?: readonly string[]; readonly findingsOmitted?: number },
	rules: ReadonlyMap<string, string> | undefined
): readonly string[] {
	const labels = (row.findings ?? []).map((rule) => rules?.get(rule) ?? rule);
	const omitted = row.findingsOmitted ?? 0;
	return omitted > 0 ? [...labels, `+${omitted} more findings`] : labels;
}

export function GameTextColumns(props: { readonly culture: string | undefined }) {
	return (
		<div
			aria-hidden="true"
			{...stylex.attrs(local.columns, props.culture === undefined && local.columnsCompact)}
		>
			<span />
			<span>Key</span>
			<span>Source</span>
			<Show when={props.culture}>{(culture) => <span>Translation · {culture()}</span>}</Show>
			<span>State</span>
		</div>
	);
}

export function GameTextResultRows(props: {
	readonly page: TextCorpusRows | undefined;
	readonly culture: string | undefined;
	/** The picked cultures; every culture when empty or absent. */
	readonly cultures?: readonly string[];
	readonly selectedId: TextUnitId | undefined;
	readonly selectedLocalizationId: LocalizationLineId | undefined;
	readonly onSelect: (unit: TextUnitId | undefined, line: LocalizationLineId | undefined) => void;
	/** Rule labels by ID, for the findings a row lists; a rule reads as its ID without one. */
	readonly rules?: ReadonlyMap<string, string> | undefined;
	/** Lines ticked for bulk actions; rows have no tick box without it. */
	readonly checked?: ((line: LocalizationLineId) => boolean) | undefined;
	/** Ticks or unticks a line; `range` extends from the last line ticked (shift-click). */
	readonly onCheck?: ((line: LocalizationLinePreview, range: boolean) => void) | undefined;
	/** Some line is ticked, so every tick box shows at full strength. */
	readonly checking?: boolean | undefined;
}) {
	const rows = (): readonly ResultRow[] => {
		const page = props.page;
		if (!page) return [];
		if (!page.localization) return page.units.map((unit) => ({ unit, line: undefined }));
		// Query previews follow corpus lines in order; two lines can share a saved unit ID, so a
		// preview is taken in turn, and only by a line it belongs to.
		let next = 0;
		return page.localization.lines.map((line) => {
			const unit = page.units[next];
			const owned =
				line.origin.kind === "corpus" &&
				unit !== undefined &&
				line.origin.unitIds.includes(unit.id);
			if (owned) next++;
			return { line, unit: owned ? unit : undefined };
		});
	};
	const selected = (row: ResultRow) =>
		row.line
			? props.selectedLocalizationId !== undefined
				? row.line.id === props.selectedLocalizationId
				: row.unit !== undefined && row.unit.id === props.selectedId
			: row.unit !== undefined && row.unit.id === props.selectedId;
	const mark = (row: ResultRow) =>
		row.line?.cultures.find((item) => item.culture === props.culture);
	const key = (row: ResultRow) => {
		const identity = row.line?.identity;
		if (identity) return [identity.namespace, identity.key].filter(Boolean).join(".");
		return row.unit ? identityLabel(row.unit) : "No localization key";
	};
	const source = (row: ResultRow) => row.line?.source ?? (row.unit ? sourceText(row.unit) : "");
	const rowLabel = (row: ResultRow) => {
		const context = row.unit?.contexts[0];
		const current = mark(row);
		return [
			row.line?.source ?? (row.unit ? sourceText(row.unit) : ""),
			context ? textContext(context.location).title : row.line?.manifestLocations[0],
			key(row),
			current?.translation,
			current ? browseStateLabel(current.state) : undefined,
			row.line?.cultures
				.filter((mark) => !props.cultures?.length || props.cultures.includes(mark.culture))
				.map(
					(mark) =>
						`${mark.culture}: ${localizationLabels[mark.state]}${mark.facts.includes("not_synced") && mark.state !== "not_synced" ? ", Not synced" : ""}`
				)
				.join(", "),
			keyChangeLabel(row.line)
		]
			.filter(Boolean)
			.join(" ");
	};
	return (
		<For
			each={rows()}
			keyed={(row) => (row.line ? `line:${row.line.id}` : `unit:${row.unit?.id}`)}
		>
			{(row) => (
				<div {...stylex.attrs(local.wrap, selected(row()) && styles.selected)}>
					<span {...stylex.attrs(local.tick)}>
						<Show when={props.onCheck !== undefined && row().line}>
							{(line) => (
								<input
									type="checkbox"
									aria-label={"Select " + line().source}
									checked={props.checked?.(line().id) ?? false}
									onClick={(event) => props.onCheck?.(line(), event.shiftKey)}
									{...stylex.attrs(local.box, props.checking && local.boxOn)}
								/>
							)}
						</Show>
					</span>
					<button
						type="button"
						aria-current={selected(row()) ? "true" : undefined}
						aria-label={rowLabel(row())}
						data-row=""
						data-unit={row().unit?.id}
						data-line={row().line?.id}
						onClick={() => props.onSelect(row().unit?.id, row().line?.id)}
						{...stylex.attrs(
							styles.row,
							local.line,
							props.culture === undefined && local.lineCompact,
							selected(row()) && styles.selected
						)}
					>
						<span
							aria-hidden="true"
							{...stylex.attrs(local.dot, stateTone(mark(row())?.state))}
						/>
						<span title={key(row())} {...stylex.attrs(local.key)}>
							{key(row())}
						</span>
						<span {...stylex.attrs(local.main)}>
							<span title={source(row())} {...stylex.attrs(styles.rowText)}>
								{source(row())}
							</span>
							<Show
								when={row().unit}
								fallback={
									<span
										title={row().line?.manifestLocations.join("\n")}
										{...stylex.attrs(styles.context)}
									>
										{row().line?.manifestLocations[0] ?? "Gathered source"}
										{manifestPathOrigin(
											row().line?.manifestLocations[0] ?? ""
										) === "cpp"
											? " · C++"
											: row().line?.manifestLocations[0]
												? " · Gathered source"
												: ""}
									</span>
								}
							>
								{(unit) => (
									<span
										title={unit().contexts[0]?.location.objectPath}
										{...stylex.attrs(styles.context)}
									>
										{unit()
											.contexts.slice(0, 1)
											.map((context) => textContext(context.location).title)
											.join("")}
										{unit().occurrenceCount > 1
											? " · +" + (unit().occurrenceCount - 1) + " more"
											: ""}
										<span>
											{[
												...unit()
													.reviewSignals.filter(
														(signal) => signal !== "evidence_only"
													)
													.map(textReviewSignalLabel),
												...rowFindings(unit(), props.rules)
											]
												.map((label) => " · " + label)
												.join("")}
										</span>
									</span>
								)}
							</Show>
						</span>
						<Show when={props.culture}>
							{(culture) => (
								<span
									dir="auto"
									lang={culture()}
									title={mark(row())?.translation ?? undefined}
									{...stylex.attrs(
										local.translation,
										!mark(row())?.translation && local.empty
									)}
								>
									{mark(row())?.translation ?? "No translation"}
								</span>
							)}
						</Show>
						<Show
							when={mark(row())}
							fallback={
								<Show
									when={row().line}
									fallback={
										<span {...stylex.attrs(local.quiet)}>Saved source</span>
									}
								>
									{(line) => (
										<LineStatus line={line()} cultures={props.cultures ?? []} />
									)}
								</Show>
							}
						>
							{(current) => (
								<span {...stylex.attrs(local.status)}>
									<Show when={keyChangeLabel(row().line)}>
										{(label) => (
											<span {...stylex.attrs(local.severe)}>{label()}</span>
										)}
									</Show>
									<span
										title={current()
											.facts.map((state) => localizationLabels[state])
											.join(" · ")}
										{...stylex.attrs(
											browseStyles.badge,
											stateTone(current().state)
										)}
									>
										{browseStateLabel(current().state)}
									</span>
									<Show
										when={
											current().state !== "not_synced" &&
											current().facts.includes("not_synced")
										}
									>
										<span {...stylex.attrs(local.synced)}>Not synced</span>
									</Show>
								</span>
							)}
						</Show>
					</button>
				</div>
			)}
		</For>
	);
}

/** Both lines of a changed key lose work: the new key until it is carried, the earlier one at the next gather. */
function keyChangeLabel(line: LocalizationLinePreview | undefined) {
	const direction = line?.keyChange?.direction;
	return direction === "to" ? "Key changed" : direction === "from" ? "Earlier key" : undefined;
}

/**
 * What a line still needs, on the right: a changed key in red, a gather state the line shares
 * across cultures, or each culture's translation state as a strip.
 */
function LineStatus(props: {
	readonly line: LocalizationLinePreview;
	readonly cultures: readonly string[];
}) {
	// Only the picked cultures, in the target's order; every culture when none is picked.
	const marks = () =>
		props.cultures.length === 0
			? props.line.cultures
			: props.line.cultures.filter((mark) => props.cultures.includes(mark.culture));
	const shared = () => lineState(marks());
	const summary = () => cultureSummary(marks());
	return (
		<span {...stylex.attrs(local.status)}>
			<Show when={keyChangeLabel(props.line)}>
				{(label) => <span {...stylex.attrs(local.severe)}>{label()}</span>}
			</Show>
			<Show
				when={shared()}
				fallback={
					<>
						<Show when={summary()}>
							<span
								{...stylex.attrs(
									marks().some(
										(mark) =>
											mark.state === "not_translated" ||
											mark.state === "needs_update"
									)
										? local.waiting
										: local.synced
								)}
							>
								{summary()}
							</span>
						</Show>
						{/* A line every culture ships draws no mark. */}
						<Show when={marks().some((mark) => cultureCell(mark) !== "shipped")}>
							<CultureStrip marks={marks()} />
						</Show>
					</>
				}
			>
				{(state) => (
					<span
						{...stylex.attrs(
							state() === "not_gathered" || state() === "changed_since_gather"
								? local.waiting
								: local.quiet
						)}
					>
						{localizationLabels[state()]}
					</span>
				)}
			</Show>
		</span>
	);
}

const local = stylex.create({
	wrap: { display: "flex", minWidth: 0 },
	columns: {
		display: "grid",
		gridTemplateColumns:
			"34px minmax(55px, .7fr) minmax(90px, 1.4fr) minmax(70px, 1.1fr) minmax(100px, 1fr)",
		gap: 8,
		padding: "8px 14px",
		minWidth: 0,
		position: "sticky",
		top: 0,
		zIndex: 2,
		backgroundColor: tokens.colorCanvas,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		color: tokens.colorTextFaint,
		fontSize: 10,
		textTransform: "uppercase",
		letterSpacing: ".04em"
	},
	columnsCompact: {
		gridTemplateColumns: "34px minmax(55px, .7fr) minmax(90px, 2fr) minmax(100px, 1fr)"
	},
	key: {
		fontFamily: tokens.fontMono,
		fontSize: 11,
		color: tokens.colorTextMuted,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis"
	},
	translation: {
		fontSize: 12,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis"
	},
	empty: { color: tokens.colorTextFaint, fontStyle: "italic" },
	dot: { width: 6, height: 6, borderRadius: "50%", backgroundColor: "currentColor" },
	tick: {
		display: "flex",
		alignItems: "center",
		width: 26,
		flexShrink: 0,
		paddingInlineStart: 12,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	box: {
		margin: 0,
		cursor: "pointer",
		accentColor: tokens.colorAccent,
		opacity: { default: 0.35, ":hover": 1, ":checked": 1, ":focus-visible": 1 }
	},
	boxOn: { opacity: 1 },
	line: {
		flex: 1,
		minWidth: 0,
		display: "grid",
		gridTemplateColumns:
			"8px minmax(55px, .7fr) minmax(90px, 1.4fr) minmax(70px, 1.1fr) minmax(100px, 1fr)",
		alignItems: "center",
		gap: 8,
		minHeight: 34,
		paddingBlock: 6
	},
	lineCompact: {
		gridTemplateColumns: "8px minmax(55px, .7fr) minmax(90px, 2fr) minmax(100px, 1fr)"
	},
	main: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 },
	status: {
		flexShrink: 0,
		display: "inline-flex",
		alignItems: "center",
		gap: 10,
		fontSize: 12,
		whiteSpace: "nowrap"
	},
	severe: { color: tokens.colorDanger },
	waiting: { color: tokens.colorWarning },
	synced: { color: tokens.colorAccent },
	quiet: { color: tokens.colorTextMuted }
});
