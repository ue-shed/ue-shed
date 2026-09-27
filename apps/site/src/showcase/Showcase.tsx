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
			<div {...stylex.attrs(styles.tabBar)} role="tablist" aria-label="Workbench captures">
				<For each={showcaseTabs}>
					{(tab) => (
						<button
							type="button"
							role="tab"
							id={`capture-tab-${tab.id}`}
							aria-controls={`capture-panel-${tab.id}`}
							tabindex={active() === tab.id ? 0 : -1}
							onKeyDown={(event) => {
								const index = showcaseTabs.findIndex(
									(entry) => entry.id === tab.id
								);
								const next =
									event.key === "ArrowRight"
										? (index + 1) % showcaseTabs.length
										: event.key === "ArrowLeft"
											? (index + showcaseTabs.length - 1) %
												showcaseTabs.length
											: event.key === "Home"
												? 0
												: event.key === "End"
													? showcaseTabs.length - 1
													: undefined;
								if (next === undefined) return;
								const target = showcaseTabs[next];
								if (!target) return;
								event.preventDefault();
								setActive(target.id);
								document.getElementById(`capture-tab-${target.id}`)?.focus();
							}}
							aria-selected={active() === tab.id ? "true" : "false"}
							onClick={() => setActive(tab.id)}
							{...stylex.attrs(styles.tab, active() === tab.id && styles.tabActive)}
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
							<div
								role="tabpanel"
								id={`capture-panel-${tab.id}`}
								aria-labelledby={`capture-tab-${tab.id}`}
							>
								<WindowFrame title={capture.title}>
									<img
										src={`/media/${capture.file}`}
										alt={tab.alt}
										{...stylex.attrs(styles.capture)}
									/>
								</WindowFrame>
							</div>
						</Show>
					);
				}}
			</For>
			<Show when={activeTab()}>
				{(tab) => (
					<div {...stylex.attrs(styles.caption)}>
						<p {...stylex.attrs(styles.note)}>{tab().note}</p>
						<a
							href={`/docs/${tab().id === "authoring" ? "data-authoring" : tab().id}`}
							{...stylex.attrs(styles.guideLink)}
						>
							Follow the walkthrough →
						</a>
						<div {...stylex.attrs(styles.chips)}>
							<For each={tab().chips}>
								{(chip) => <span {...stylex.attrs(styles.chip)}>{chip}</span>}
							</For>
						</div>
					</div>
				)}
			</Show>
		</div>
	);
}

const styles = stylex.create({
	guideLink: { color: tokens.colorAccent, fontSize: 12, textUnderlineOffset: 4 },
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
