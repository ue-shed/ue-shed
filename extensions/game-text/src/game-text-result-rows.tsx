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
	readonly selectedId: TextUnitId | undefined;
	readonly selectedLocalizationId: LocalizationLineId | undefined;
	readonly onSelect: (unit: TextUnitId | undefined, line: LocalizationLineId | undefined) => void;
}) {
	const rows = (): readonly ResultRow[] => {
		const page = props.page;
		if (!page) return [];
		if (!page.localization) return page.units.map((unit) => ({ unit, line: undefined }));
		const units = new Map(page.units.map((unit) => [unit.id, unit]));
		return page.localization.lines.map((line) => ({
			line,
			unit:
				line.origin.kind === "corpus"
					? line.origin.unitIds.map((id) => units.get(id)).find(Boolean)
					: undefined
		}));
	};
	const selected = (row: ResultRow) =>
		row.line
			? row.line.id === props.selectedLocalizationId ||
				(row.unit !== undefined && row.unit.id === props.selectedId)
			: row.unit !== undefined && row.unit.id === props.selectedId;
	return (
		<For each={rows()}>
			{(row) => (
				<button
					type="button"
					aria-current={selected(row) ? "true" : undefined}
					onClick={() => props.onSelect(row.unit?.id, row.line?.id)}
					{...stylex.attrs(styles.row, local.line, selected(row) && styles.selected)}
				>
					<span {...stylex.attrs(local.main)}>
						<span {...stylex.attrs(styles.rowText)}>
							{row.line?.source ?? (row.unit ? sourceText(row.unit) : "")}
						</span>
						<Show when={row.line}>
							{(line) => <LocalizationRow line={line()} culture={props.culture} />}
						</Show>
						<Show
							when={row.unit}
							fallback={
								<span
									title={row.line?.manifestLocations.join("\n")}
									{...stylex.attrs(styles.context)}
								>
									{row.line?.manifestLocations[0] ?? "Gathered source"}
									{manifestPathOrigin(row.line?.manifestLocations[0] ?? "") ===
									"cpp"
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
											.map((signal) => " · " + textReviewSignalLabel(signal))
											.join("")}
									</span>
								</span>
							)}
						</Show>
					</span>
					<Show when={row.line}>{(line) => <LineStatus line={line()} />}</Show>
				</button>
			)}
		</For>
	);
}

/**
 * What a line still needs, on the right: a changed key in red, a gather state the line shares
 * across cultures, or each culture's translation state as a strip.
 */
function LineStatus(props: { readonly line: LocalizationLinePreview }) {
	const shared = () => lineState(props.line.cultures);
	const summary = () => cultureSummary(props.line.cultures);
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
									props.line.cultures.some(
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
						<Show
							when={props.line.cultures.some(
								(mark) => cultureCell(mark) !== "shipped"
							)}
						>
							<CultureStrip marks={props.line.cultures} />
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
	line: { flexDirection: "row", alignItems: "center", gap: 12 },
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
