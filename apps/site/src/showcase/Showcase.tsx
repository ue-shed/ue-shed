import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createSignal, For, Show, type Component } from "solid-js";
import { AuditMock } from "./AuditMock.js";
import { AuthoringMock } from "./AuthoringMock.js";
import { ObservatoryMock } from "./ObservatoryMock.js";
import { ReviewMock } from "./ReviewMock.js";

type ShowcaseTab = {
	readonly id: string;
	readonly label: string;
	readonly component: Component;
	readonly note: string;
	readonly chips: readonly string[];
};

const tabs: readonly ShowcaseTab[] = [
	{
		id: "authoring",
		label: "Data Authoring",
		component: AuthoringMock,
		note: "The maintained DataTable grid, mocked with the fixture's real rows. Click a cell.",
		chips: ["saved package · no editor", "typed drafts + undo/redo", "same API as the CLI"]
	},
	{
		id: "audit",
		label: "Texture Audit",
		component: AuditMock,
		note: "A whole content corpus rule-checked from saved packages. Findings below are real.",
		chips: ["whole corpus from disk", "rules as data", "serialized evidence"]
	},
	{
		id: "review",
		label: "Map Review",
		component: ReviewMock,
		note: "Approve a set, capture immutable runs, drag to compare before and after.",
		chips: ["immutable capture runs", "before/after history", "live editor capture"]
	},
	{
		id: "observatory",
		label: "Actor Observatory",
		component: ObservatoryMock,
		note: "Stationary cubes, flying spheres, intermittent cylinders — the fixture's families, simulated live.",
		chips: ["bounded subscriptions", "stable actor identity", "focus in Unreal"]
	}
];

export function Showcase() {
	const [active, setActive] = createSignal("authoring");

	const activeTab = () => tabs.find((tab) => tab.id === active()) ?? tabs[0];

	return (
		<div>
			<div {...stylex.props(styles.tabBar)} role="tablist" aria-label="Tool showcase">
				<For each={tabs}>
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
			<For each={tabs}>
				{(tab) => (
					<Show when={active() === tab.id}>
						<div role="tabpanel">
							<tab.component />
						</div>
					</Show>
				)}
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
