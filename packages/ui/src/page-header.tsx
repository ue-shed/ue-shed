import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";

import type { JSX } from "@solidjs/web";

export interface PageHeaderProps {
	readonly eyebrow: string;
	readonly actions?: JSX.Element;
}

export function PageHeader(props: PageHeaderProps) {
	return (
		<header {...stylex.attrs(styles.header)}>
			<nav aria-label="Breadcrumb" {...stylex.attrs(styles.eyebrow)}>
				{props.eyebrow}
			</nav>
			{props.actions ? <div {...stylex.attrs(styles.actions)}>{props.actions}</div> : null}
		</header>
	);
}

const styles = stylex.create({
	actions: { display: "flex", alignItems: "center", gap: tokens.space2 },
	eyebrow: {
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		letterSpacing: "0"
	},
	header: {
		alignItems: "center",
		display: "flex",
		gap: tokens.space6,
		justifyContent: "space-between",
		paddingBottom: tokens.space4
	}
});
