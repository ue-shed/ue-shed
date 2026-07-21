import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For } from "solid-js";
import { auditDimensionChips, auditFindings } from "./data.js";
import { WindowFrame } from "./WindowFrame.js";

export function AuditMock() {
	return (
		<WindowFrame title="Texture Asset Audit — fixture corpus" badge="real fixture findings">
			<div {...stylex.props(styles.toolbar)}>
				<span {...stylex.props(styles.chip)}>19 packages inspected</span>
				<span {...stylex.props(styles.chip)}>5 textures</span>
				<span {...stylex.props(styles.chipWarning)}>2 findings</span>
				<span {...stylex.props(styles.chip)}>0 failed</span>
			</div>
			<div {...stylex.props(styles.body)}>
				<div {...stylex.props(styles.panel)}>
					<p {...stylex.props(styles.panelLabel)}>Source formats</p>
					<div {...stylex.props(styles.barRow)}>
						<span {...stylex.props(styles.barLabel)}>TSF_BGRA8</span>
						<span {...stylex.props(styles.barTrack)}>
							<span {...stylex.props(styles.barFill)} style={{ width: "100%" }} />
						</span>
						<span {...stylex.props(styles.barCount)}>5</span>
					</div>
					<p {...stylex.props(styles.panelLabel)}>Dimensions</p>
					<div {...stylex.props(styles.dimChips)}>
						<For each={auditDimensionChips}>
							{(chip) => <span {...stylex.props(styles.dimChip)}>{chip}</span>}
						</For>
					</div>
					<p {...stylex.props(styles.hint)}>
						Distributions are read from serialized properties — compression and sRGB
						report as not_serialized and stay visible instead of being guessed.
					</p>
				</div>
				<div {...stylex.props(styles.panel)}>
					<p {...stylex.props(styles.panelLabel)}>Findings</p>
					<For each={auditFindings}>
						{(finding) => (
							<article {...stylex.props(styles.finding)}>
								<header {...stylex.props(styles.findingHead)}>
									<span {...stylex.props(styles.severity)}>
										{finding.severity}
									</span>
									<span {...stylex.props(styles.ruleId)}>{finding.ruleId}</span>
								</header>
								<p {...stylex.props(styles.findingPath)}>{finding.objectPath}</p>
								<p {...stylex.props(styles.findingText)}>{finding.explanation}</p>
								<p {...stylex.props(styles.findingMeta)}>
									{finding.actual} · expected: {finding.expected}
								</p>
							</article>
						)}
					</For>
				</div>
			</div>
			<div {...stylex.props(styles.footer)}>
				Rules are data: texture-rules.json in the fixture repo. The same scan runs from the
				CLI with ue-shed audit textures.
			</div>
		</WindowFrame>
	);
}

const styles = stylex.create({
	toolbar: {
		alignItems: "center",
		backgroundColor: tokens.colorSurface,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		flexWrap: "wrap",
		gap: 8,
		padding: "8px 12px"
	},
	chip: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 9,
		letterSpacing: ".08em",
		padding: "3px 8px"
	},
	chipWarning: {
		borderColor: tokens.colorWarning,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorWarning,
		fontSize: 9,
		letterSpacing: ".08em",
		padding: "3px 8px"
	},
	body: {
		display: "grid",
		gap: 1,
		gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))"
	},
	panel: {
		backgroundColor: tokens.colorSurfaceInset,
		padding: "14px 16px"
	},
	panelLabel: {
		color: tokens.colorTextSubtle,
		fontSize: 9,
		letterSpacing: ".16em",
		margin: "0 0 10px",
		textTransform: "uppercase"
	},
	barRow: {
		alignItems: "center",
		display: "flex",
		gap: 10,
		marginBottom: 18
	},
	barLabel: {
		color: tokens.colorTextMuted,
		fontSize: 10,
		width: 76
	},
	barTrack: {
		backgroundColor: tokens.colorSurfaceHover,
		borderRadius: tokens.radiusControl,
		flexGrow: 1,
		height: 8,
		overflow: "hidden"
	},
	barFill: {
		backgroundColor: tokens.colorAccent,
		display: "block",
		height: "100%"
	},
	barCount: {
		color: tokens.colorTextMuted,
		fontSize: 10
	},
	dimChips: {
		display: "flex",
		flexWrap: "wrap",
		gap: 6,
		marginBottom: 18
	},
	dimChip: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 10,
		padding: "3px 8px"
	},
	hint: {
		color: tokens.colorTextFaint,
		fontSize: 10,
		lineHeight: 1.6,
		margin: 0
	},
	finding: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderLeftColor: tokens.colorWarning,
		borderLeftWidth: 2,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		marginBottom: 10,
		padding: "10px 12px"
	},
	findingHead: {
		alignItems: "center",
		display: "flex",
		gap: 8,
		marginBottom: 4
	},
	severity: {
		backgroundColor: tokens.colorWarning,
		borderRadius: tokens.radiusControl,
		color: tokens.colorAccentText,
		fontSize: 9,
		fontWeight: 700,
		letterSpacing: ".08em",
		padding: "2px 6px",
		textTransform: "uppercase"
	},
	ruleId: {
		color: tokens.colorTextMuted,
		fontSize: 10
	},
	findingPath: {
		color: tokens.colorTextFaint,
		fontSize: 9,
		margin: "0 0 6px",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	findingText: {
		color: tokens.colorText,
		fontSize: 11,
		margin: "0 0 4px"
	},
	findingMeta: {
		color: tokens.colorTextSubtle,
		fontSize: 10,
		margin: 0
	},
	footer: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextFaint,
		fontSize: 10,
		padding: "8px 12px"
	}
});
