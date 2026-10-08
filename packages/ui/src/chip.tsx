import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Show } from "solid-js";

export function Chip(props: {
	readonly label: string;
	readonly count?: number | undefined;
	readonly selected: boolean;
	readonly toggle?: boolean;
	readonly disabled?: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={props.disabled}
			aria-pressed={props.selected ? "true" : "false"}
			aria-label={
				props.label + (props.count === undefined ? "" : " " + props.count.toLocaleString())
			}
			onClick={props.onClick}
			{...stylex.attrs(styles.chip, props.selected && styles.selected)}
		>
			<Show when={props.toggle}>
				<span aria-hidden="true" {...stylex.attrs(styles.checkbox)}>
					{props.selected ? "✓" : ""}
				</span>
			</Show>
			{props.label}
			<Show when={props.count !== undefined}>
				{" "}
				<span {...stylex.attrs(styles.count)}>{props.count?.toLocaleString()}</span>
			</Show>
		</button>
	);
}

const styles = stylex.create({
	chip: {
		display: "inline-flex",
		alignItems: "center",
		gap: 6,
		minHeight: 26,
		padding: "3px 9px",
		borderRadius: tokens.radiusPill,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderInteractive,
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12,
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: 2 }
	},
	selected: { backgroundColor: tokens.colorAccentWash, borderColor: tokens.colorAccent },
	count: { color: tokens.colorTextMuted, fontVariantNumeric: "tabular-nums" },
	checkbox: {
		width: 11,
		height: 11,
		display: "grid",
		placeItems: "center",
		fontSize: 10,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorTextMuted,
		borderRadius: 2
	}
});
