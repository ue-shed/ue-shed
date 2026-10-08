import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show } from "solid-js";
import { CELL_WORDS, cultureCell, type CultureMark } from "./game-text-culture-state.js";

/**
 * One cell per culture, always in the target's order, so the column reads the same on every line
 * and keeps one width for a dozen cultures or more. When every culture shares a state the strip
 * draws one bar. Colour carries severity only; the shapes differ too, and the accessible name lists
 * every culture.
 */
export function CultureStrip(props: { readonly marks: readonly CultureMark[] }) {
	const cells = () =>
		props.marks.map((mark) => ({ culture: mark.culture, cell: cultureCell(mark) }));
	const shared = () => {
		const first = cells()[0]?.cell;
		return first !== undefined &&
			cells().length > 1 &&
			cells().every((item) => item.cell === first)
			? first
			: undefined;
	};
	const label = () =>
		cells()
			.map((item) => `${item.culture} ${CELL_WORDS[item.cell]}`)
			.join(", ");
	return (
		<span role="img" aria-label={label()} {...stylex.attrs(styles.strip)}>
			<Show
				when={shared()}
				fallback={
					<For each={cells()}>
						{(item) => (
							<span
								title={label()}
								{...stylex.attrs(styles.cell, styles[item.cell])}
							/>
						)}
					</For>
				}
			>
				{(cell) => (
					<span
						title={label()}
						{...stylex.attrs(styles.cell, styles.merged, styles[cell()])}
						style={{ width: `${cells().length * 8 - 2}px` }}
					/>
				)}
			</Show>
		</span>
	);
}

const styles = stylex.create({
	strip: { display: "inline-flex", gap: 2, flexShrink: 0, alignItems: "center" },
	cell: { width: 6, height: 12, borderRadius: 1.5, boxSizing: "border-box", display: "block" },
	merged: { borderRadius: 2 },
	shipped: { backgroundColor: tokens.colorBorder },
	missing: {
		backgroundColor: "transparent",
		borderWidth: 1,
		borderStyle: "dashed",
		borderColor: tokens.colorWarning
	},
	to_update: { backgroundColor: tokens.colorWarning },
	not_synced: { backgroundColor: tokens.colorAccent },
	other: {
		backgroundColor: "transparent",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong
	}
});
