import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createSignal, For, Show } from "solid-js";
import { showcaseTabs } from "../content.js";
import { siteMedia } from "./media.js";
import { WindowFrame } from "./WindowFrame.js";

export function Showcase() {
	const [active, setActive] = createSignal(showcaseTabs[0]?.id ?? "");

	const activeTab = () => showcaseTabs.find((tab) => tab.id === active()) ?? showcaseTabs[0];

	return (
		<div>
			<div {...stylex.props(styles.tabBar)} role="tablist" aria-label="Workbench captures">
				<For each={showcaseTabs}>
					{(tab) => (
						<button
							type="button"
							role="tab"
							aria-selected={active() === tab.id}
							onClick={() => setActive(tab.id)}
							{...stylex.props(styles.tab, active() === tab.id && styles.tabActive)}
						>
							{tab.label}
						</button>
					)}
				</For>
			</div>
			<For each={showcaseTabs}>
				{(tab) => {
					const capture = siteMedia.captures[tab.capture];
					return (
						<Show when={active() === tab.id}>
							<div role="tabpanel">
								<WindowFrame title={capture.title}>
									<img
										src={`/media/${capture.file}`}
										alt={tab.alt}
										{...stylex.props(styles.capture)}
									/>
								</WindowFrame>
							</div>
						</Show>
					);
				}}
			</For>
			<Show when={activeTab()}>
				{(tab) => (
					<div {...stylex.props(styles.caption)}>
						<p {...stylex.props(styles.note)}>{tab().note}</p>
						<div {...stylex.props(styles.chips)}>
							<For each={tab().chips}>
								{(chip) => <span {...stylex.props(styles.chip)}>{chip}</span>}
							</For>
						</div>
					</div>
				)}
			</Show>
		</div>
	);
}

const styles = stylex.create({
	tabBar: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		display: "inline-flex",
		flexWrap: "wrap",
		gap: 2,
		marginBottom: 16,
		maxWidth: "100%",
		padding: 3
	},
	tab: {
		backgroundColor: {
			default: "transparent",
			":hover": tokens.colorSurfaceHover
		},
		borderRadius: tokens.radiusControl,
		borderWidth: 0,
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 11,
		letterSpacing: ".04em",
		padding: "7px 14px"
	},
	tabActive: {
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextStrong
	},
	capture: {
		display: "block",
		height: "auto",
		width: "100%"
	},
	caption: {
		alignItems: "center",
		display: "flex",
		flexWrap: "wrap",
		gap: "10px 16px",
		justifyContent: "space-between",
		marginTop: 14
	},
	note: {
		color: tokens.colorTextMuted,
		fontSize: 11,
		margin: 0
	},
	chips: {
		display: "flex",
		flexWrap: "wrap",
		gap: 6
	},
	chip: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextSubtle,
		fontSize: 9,
		letterSpacing: ".08em",
		padding: "3px 8px"
	}
});
