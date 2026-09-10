import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Show, type Element } from "solid-js";

export function WindowFrame(props: {
	readonly title: string;
	readonly badge?: string;
	readonly children: Element;
}) {
	return (
		<div {...stylex.attrs(styles.frame)}>
			<div {...stylex.attrs(styles.bar)}>
				<span {...stylex.attrs(styles.dot)} />
				<span {...stylex.attrs(styles.dot)} />
				<span {...stylex.attrs(styles.dot)} />
				<span {...stylex.attrs(styles.title)}>{props.title}</span>
				<Show when={props.badge}>
					<span {...stylex.attrs(styles.badge)}>{props.badge}</span>
				</Show>
			</div>
			{props.children}
		</div>
	);
}

const styles = stylex.create({
	frame: {
		backgroundColor: tokens.colorSurfaceInset,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		overflow: "hidden"
	},
	bar: {
		alignItems: "center",
		backgroundColor: tokens.colorSurface,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		gap: 6,
		padding: "9px 12px"
	},
	dot: {
		backgroundColor: tokens.colorBorderStrong,
		borderRadius: "50%",
		height: 8,
		width: 8
	},
	title: {
		color: tokens.colorTextSubtle,
		fontSize: 10,
		letterSpacing: ".14em",
		marginLeft: 8,
		textTransform: "uppercase"
	},
	badge: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextSubtle,
		fontSize: 9,
		letterSpacing: ".1em",
		marginLeft: "auto",
		padding: "3px 8px",
		textTransform: "uppercase"
	}
});
