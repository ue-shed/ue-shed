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
import { For, Show } from "solid-js";
import { LocalizationRow } from "./game-text-localization-view.js";
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
					{...stylex.attrs(styles.row, selected(row) && styles.selected)}
				>
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
								{manifestPathOrigin(row.line?.manifestLocations[0] ?? "") === "cpp"
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
								<span {...stylex.attrs(styles.warning)}>
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
				</button>
			)}
		</For>
	);
}
