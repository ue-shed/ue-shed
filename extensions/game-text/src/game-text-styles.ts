import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";

export const styles = stylex.create({
	pageBody: {
		display: "flex",
		flexDirection: "column"
	},
	grow: { flex: 1 },
	calloutBox: { paddingInline: tokens.space4, paddingTop: tokens.space4 },
	operationPanel: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		flexShrink: 0,
		fontSize: 12,
		padding: 10,
		backgroundColor: tokens.colorSurface,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		maxHeight: 250,
		overflowY: "auto"
	},
	operationFiles: { maxHeight: 110, overflowY: "auto", margin: 0, paddingLeft: 18, fontSize: 11 },
	page: {
		display: "flex",
		flexDirection: "column",
		height: "100%",
		boxSizing: "border-box",
		overflow: "clip",
		minHeight: 0,
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	/** The title row: the workspace's views on the left, the project's scan state on the right. */
	titleRow: {
		display: "flex",
		alignItems: "center",
		gap: 16,
		flexShrink: 0,
		height: 40,
		// Lines up with the toolbar's search field below.
		paddingInline: 12,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	/** Which translations are shown, and what Unreal still has to take in. */
	contextBar: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 8,
		flexShrink: 0,
		minHeight: 36,
		paddingBlock: 2,
		paddingInline: 12,
		boxSizing: "border-box",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		fontSize: 12
	},
	contextLabel: { paddingInline: 4, fontSize: 12, color: tokens.colorText, whiteSpace: "nowrap" },
	contextActions: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		marginLeft: "auto"
	},
	heading: {
		margin: 0,
		fontSize: 14,
		color: tokens.colorTextStrong,
		fontWeight: 600,
		whiteSpace: "nowrap"
	},
	indexProgress: {
		display: "inline-flex",
		alignItems: "center",
		gap: 8,
		maxWidth: "100%",
		height: 18,
		verticalAlign: "top",
		color: tokens.colorTextMuted
	},
	scanReadout: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	browseActions: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: 4,
		minWidth: 0,
		flexGrow: 1,
		flexBasis: "auto"
	},
	browseBar: {
		padding: "8px 12px",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	// Takes the title row's free space, so changing scan text never moves the tabs or Rescan.
	coverage: {
		flexGrow: 1,
		flexShrink: 1,
		flexBasis: 0,
		minWidth: 0,
		height: 18,
		lineHeight: "18px",
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
		textAlign: "right",
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	muted: { color: tokens.colorTextMuted, fontSize: 12 },
	keyChange: {
		display: "grid",
		gap: 3,
		padding: "8px 10px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		fontSize: 12
	},
	warning: { color: tokens.colorWarning },
	/** What a finding observed: plain text, since findings are not severities. */
	findingFacts: { color: tokens.colorText, fontSize: 12 },
	accent: { color: tokens.colorAccent },
	danger: { color: tokens.colorDanger },
	gridCollapsed: { gridTemplateColumns: "minmax(0, 1fr)" },
	hiddenPane: { display: "none" },
	workspace: {
		display: "flex",
		flexDirection: "column",
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		overflow: "clip",
		gap: 0
	},
	bar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, flexShrink: 0 },
	exports: { marginLeft: "auto" },
	searchIcon: {
		width: 16,
		height: 16,
		fill: "none",
		stroke: tokens.colorTextMuted,
		strokeWidth: 1.5,
		flexShrink: 0
	},
	// Starts from its contents (the 150 px input, count and option), so the toolbar wraps only when
	// even those and the named tools cannot share a row; spare room then goes mostly to the search.
	search: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		flexGrow: 2,
		flexShrink: 1,
		flexBasis: 0,
		boxSizing: "border-box",
		height: 36,
		paddingBlock: 0,
		paddingInline: 8,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		":focus-within": { borderColor: tokens.colorAccent }
	},
	textarea: {
		minHeight: 56,
		resize: "vertical",
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		padding: tokens.space2,
		fontFamily: "inherit",
		fontSize: 13,
		lineHeight: 1.45,
		":focus-visible": { borderColor: tokens.colorAccent }
	},
	input: {
		flex: 1,
		minWidth: 150,
		backgroundColor: "transparent",
		borderWidth: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		outlineWidth: 0,
		"::placeholder": { color: tokens.colorTextMuted }
	},
	// The shortcut hint gives way first on narrow windows; the shortcut itself still works.
	shortcut: {
		display: { default: "inline", "@media (max-width: 1279px)": "none" }
	},
	divider: {
		alignSelf: "stretch",
		width: 1,
		marginBlock: 6,
		backgroundColor: tokens.colorBorder
	},
	count: {
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap"
	},
	grid: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) minmax(280px, 400px)",
			"@media (max-width: 1150px)": "minmax(0, 1fr) 280px"
		},
		gridTemplateRows: "minmax(0, 1fr)",
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		overflow: "clip",
		gap: 0
	},
	pane: {
		minHeight: 0,
		minWidth: 0,
		overscrollBehavior: "contain",
		overflow: "auto",
		backgroundColor: tokens.colorSurface,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: 0
	},
	row: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		width: "100%",
		padding: "7px 14px",
		borderWidth: 0,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		textAlign: "left",
		cursor: "pointer",
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		":focus-visible": { outline: `1px solid ${tokens.colorAccent}`, outlineOffset: -1 }
	},
	selected: { backgroundColor: tokens.colorAccentWash },
	rowText: {
		fontSize: 13,
		lineHeight: 1.4,
		fontWeight: 500,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
		maxWidth: "100%"
	},
	context: {
		fontSize: 11,
		color: tokens.colorTextMuted,
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
		maxWidth: "100%"
	},
	detail: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space3,
		padding: tokens.space4
	},
	title: {
		margin: 0,
		fontSize: 20,
		fontWeight: 500,
		lineHeight: 1.35,
		color: tokens.colorTextStrong,
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	},
	mono: { fontFamily: tokens.fontMono, fontSize: 11, overflowWrap: "anywhere" },
	section: { fontSize: 13, margin: 0, color: tokens.colorTextStrong },
	card: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2,
		padding: tokens.space3,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		fontSize: 12
	},
	notes: {
		margin: 0,
		padding: tokens.space2,
		backgroundColor: tokens.colorSurfaceRaised,
		borderRadius: tokens.radiusControl,
		whiteSpace: "pre-wrap",
		fontSize: 12
	},
	empty: {
		margin: 0,
		padding: tokens.space4,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.5
	},
	/** Quality without a rules file: what to do, centered where the findings would be. */
	rulesEmpty: { alignItems: "center", textAlign: "center", padding: tokens.space4 },
	rulesEmptyText: { margin: 0, maxWidth: 520, color: tokens.colorTextMuted, lineHeight: 1.5 },
	detailSection: { display: "flex", flexDirection: "column", gap: tokens.space2 },
	problemMessage: {
		margin: 0,
		fontSize: 12,
		lineHeight: 1.5,
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	},
	readProblems: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2,
		width: 420,
		maxWidth: "calc(100vw - 32px)",
		maxHeight: "70vh",
		boxSizing: "border-box",
		overflow: "auto",
		padding: tokens.space3,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorText,
		boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
		zIndex: 20
	},
	readProblemsTrigger: {
		height: 18,
		padding: "0 4px",
		lineHeight: "18px",
		verticalAlign: "top",
		borderWidth: 0,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		whiteSpace: "nowrap",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		cursor: "pointer",
		":focus-visible": { outline: `1px solid ${tokens.colorAccent}`, outlineOffset: 1 }
	},
	smallAction: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space1,
		minWidth: 0,
		maxWidth: "100%",
		overflowWrap: "anywhere"
	},
	inlineAction: { alignSelf: "flex-start" },
	copyButton: {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		flexShrink: 0,
		width: 26,
		height: 26,
		padding: 0,
		borderWidth: 0,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		":focus-visible": { outline: `1px solid ${tokens.colorAccent}`, outlineOffset: 1 }
	},
	copyIcon: { width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.5 },
	mark: {
		backgroundColor: `color-mix(in srgb, ${tokens.colorWarning} 15%, transparent)`,
		color: tokens.colorWarning,
		textDecoration: "underline"
	},
	reportPane: { flex: 1, padding: tokens.space3 },
	reportTable: {
		width: "100%",
		borderSpacing: "12px 8px",
		textAlign: "left",
		fontSize: 12,
		fontVariantNumeric: "tabular-nums"
	},
	table: { width: "100%", textAlign: "left", fontSize: 12, borderSpacing: 8 },
	pickerMenu: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		minWidth: 120,
		maxHeight: 320,
		overflowY: "auto",
		padding: 4,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
		zIndex: 20
	},
	button: {
		boxSizing: "border-box",
		height: 26,
		lineHeight: 1.35,
		padding: "3px 9px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12
	}
});
