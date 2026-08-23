import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { splitProps, type ComponentProps, type ParentProps } from "solid-js";

export type ButtonProps = ParentProps<
	Omit<ComponentProps<"button">, "class" | "classList" | "style"> & {
		readonly tone?: "primary" | "secondary" | "quiet";
	}
>;

export function Button(props: ButtonProps) {
	const [local, buttonProps] = splitProps(props, ["children", "tone"]);
	return (
		<button
			{...buttonProps}
			{...stylex.props(
				styles.base,
				local.tone === "primary"
					? styles.primary
					: local.tone === "quiet"
						? styles.quiet
						: styles.secondary
			)}
		>
			{local.children}
		</button>
	);
}

const styles = stylex.create({
	base: {
		appearance: "none",
		alignItems: "center",
		boxSizing: "border-box",
		display: "inline-flex",
		flexShrink: 0,
		gap: 6,
		justifyContent: "center",
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		fontFamily: tokens.fontBody,
		fontFeatureSettings: '"cv01", "ss03", "zero"',
		lineHeight: 1.35,
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorTextMuted },
		outlineOffset: 2,
		outlineStyle: "solid",
		outlineWidth: 1,
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, border-color, box-shadow, color, opacity, transform",
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { default: "scale(1)", ":active": "scale(0.97)", ":disabled": "scale(1)" },
		userSelect: "none",
		whiteSpace: "nowrap",
		opacity: { default: 1, ":disabled": 0.42 }
	},
	// The one acid-lime call to action per view: heavier and roomier than the rest.
	primary: {
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong,
			":active": "#d3e01f",
			":disabled": tokens.colorAccent
		},
		borderColor: "transparent",
		boxShadow: {
			default:
				"inset 0 1px 0 rgba(255, 255, 255, 0.32), inset 0 -1px 0 rgba(8, 9, 10, 0.28), 0 1px 2px rgba(0, 0, 0, 0.28)",
			":hover":
				"inset 0 1px 0 rgba(255, 255, 255, 0.4), inset 0 -1px 0 rgba(8, 9, 10, 0.24), 0 2px 4px rgba(0, 0, 0, 0.3)",
			":active":
				"inset 0 1px 2px rgba(8, 9, 10, 0.28), inset 0 -1px 0 rgba(255, 255, 255, 0.14)",
			":disabled": "none"
		},
		color: tokens.colorAccentText,
		fontSize: 14,
		fontWeight: 510,
		letterSpacing: "-0.011em",
		padding: "10px 16px"
	},
	// Nav text button: no chrome until you touch it.
	quiet: {
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":active": "rgba(255, 255, 255, 0.08)",
			":disabled": "transparent"
		},
		borderColor: "transparent",
		color: tokens.colorText,
		fontSize: 13,
		fontWeight: 400,
		padding: "8px 12px"
	},
	// Ghost/outline button: a Graphite hairline, never the brighter elevation border.
	secondary: {
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":active": "rgba(255, 255, 255, 0.08)",
			":disabled": "transparent"
		},
		borderColor: {
			default: tokens.colorBorder,
			":hover": tokens.colorBorderStrong,
			":disabled": tokens.colorBorder
		},
		color: tokens.colorText,
		fontSize: 13,
		fontWeight: 400,
		padding: "8px 12px"
	}
});
