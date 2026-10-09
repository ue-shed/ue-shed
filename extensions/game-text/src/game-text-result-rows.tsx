import * as stylex from "@stylexjs/stylex";
import {
	manifestPathOrigin,
	textReviewSignalLabel,
	type LocalizationLineId,
	type LocalizationLinePreview,
	type TextCorpusSearchPage,
	type TextUnitId,
	type TextUnitSearchResult
} from "@ue-shed/game-text/browser";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show } from "solid-js";
import { CultureStrip } from "./game-text-culture-strip.js";
import { cultureCell, cultureSummary, lineState } from "./game-text-culture-state.js";
import { LocalizationRow, localizationLabels } from "./game-text-localization-view.js";
import { sourceText, textContext } from "./game-text-view.js";
import { styles } from "./game-text-styles.js";

type ResultRow = {
	readonly line: LocalizationLinePreview | undefined;
	readonly unit: TextUnitSearchResult | undefined;
};

export function GameTextResultRows(props: {
	readonly page: TextCorpusSearchPage | undefined;
	readonly culture: string | undefined;
	/** The picked cultures; every culture when empty or absent. */
	readonly cultures?: readonly string[];
	readonly selectedId: TextUnitId | undefined;
	readonly selectedLocalizationId: LocalizationLineId | undefined;
	readonly onSelect: (unit: TextUnitId | undefined, line: LocalizationLineId | undefined) => void;
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
	return (
		<For each={rows()}>
			{(row) => (
				<div {...stylex.attrs(local.wrap, selected(row) && styles.selected)}>
					<Show when={props.onCheck !== undefined && row.line}>
						{(line) => (
							<span {...stylex.attrs(local.tick)}>
								<input
									type="checkbox"
									aria-label={"Select " + line().source}
									checked={props.checked?.(line().id) ?? false}
									onClick={(event) => props.onCheck?.(line(), event.shiftKey)}
									{...stylex.attrs(local.box, props.checking && local.boxOn)}
								/>
							</span>
						)}
					</Show>
					<button
						type="button"
						aria-current={selected(row) ? "true" : undefined}
						data-row=""
						data-unit={row.unit?.id}
						data-line={row.line?.id}
						onClick={() => props.onSelect(row.unit?.id, row.line?.id)}
						{...stylex.attrs(styles.row, local.line, selected(row) && styles.selected)}
					>
						<span {...stylex.attrs(local.main)}>
							<span {...stylex.attrs(styles.rowText)}>
								{row.line?.source ?? (row.unit ? sourceText(row.unit) : "")}
							</span>
							<Show when={row.line}>
								{(line) => (
									<LocalizationRow line={line()} culture={props.culture} />
								)}
							</Show>
							<Show
								when={row.unit}
								fallback={
									<span
										title={row.line?.manifestLocations.join("\n")}
										{...stylex.attrs(styles.context)}
									>
										{row.line?.manifestLocations[0] ?? "Gathered source"}
										{manifestPathOrigin(
											row.line?.manifestLocations[0] ?? ""
										) === "cpp"
											? " · C++"
											: " · Gathered source"}
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
											{unit()
												.reviewSignals.filter(
													(signal) => signal !== "evidence_only"
												)
												.map(
													(signal) =>
														" · " + textReviewSignalLabel(signal)
												)
												.join("")}
										</span>
									</span>
								)}
							</Show>
						</span>
						<Show when={row.line}>
							{(line) => <LineStatus line={line()} cultures={props.cultures ?? []} />}
						</Show>
					</button>
				</div>
			)}
		</For>
	);
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
			<Show when={props.line.keyChange?.direction === "to"}>
				<span {...stylex.attrs(local.severe)}>Key changed</span>
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
	tick: {
		display: "flex",
		alignItems: "center",
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
	line: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 },
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
