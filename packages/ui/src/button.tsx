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
		alignItems: "center",
		justifyContent: "center",
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		fontFamily: tokens.fontBody,
		fontSize: 13,
		fontWeight: 500,
		letterSpacing: "-0.005em",
		lineHeight: 1.35,
		padding: "5px 12px",
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, border-color, color, opacity",
		transitionTimingFunction: "ease",
		opacity: { default: 1, ":disabled": 0.5 }
	},
	primary: {
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong,
			":active": "#d3e01f"
		},
		borderColor: "transparent",
		color: tokens.colorAccentText
	},
	quiet: {
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":active": "rgba(255, 255, 255, 0.08)"
		},
		borderColor: "transparent",
		color: tokens.colorTextMuted
	},
	secondary: {
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":active": "rgba(255, 255, 255, 0.08)"
		},
		borderColor: { default: tokens.colorBorderStrong, ":hover": "#4a4e54" },
		color: tokens.colorText
	}
});
