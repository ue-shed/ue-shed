import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";

// StyleX needs literal geometry; these mirror BLUEPRINT_LAYOUT, which drives wire endpoints.
// The node's 1px top border sits above the header, so pin rows start at the 43px layout offset.
const NODE_HEADER_INNER_HEIGHT = 42;
const PIN_ROW_HEIGHT = 25;
const GRAPH_MARGIN = 72;

export const styles = stylex.create({
	route: {
		minHeight: "100%",
		padding: { default: "24px 28px 40px", "@media (max-width: 899px)": "20px 16px 32px" },
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	header: {
		display: "flex",
		flexWrap: { default: "nowrap", "@media (max-width: 899px)": "wrap" },
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: { default: 30, "@media (max-width: 899px)": 4 },
		paddingBottom: 16
	},
	titleBlock: { minWidth: 0 },
	title: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 24,
		fontWeight: 590,
		letterSpacing: "-0.02em"
	},
	intro: { margin: "4px 0 0", color: tokens.colorTextMuted, fontSize: 13, lineHeight: 1.5 },
	scopeStamp: { flexShrink: 0, color: tokens.colorTextSubtle, fontSize: 12 },

	searchWrap: {
		position: "relative",
		zIndex: 3,
		flex: "1 1 260px",
		minWidth: 200,
		maxWidth: 420
	},
	searchField: { position: "relative", display: "block" },
	searchInput: {
		width: "100%",
		height: 32,
		padding: "0 32px 0 32px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: {
			default: tokens.colorBorder,
			":hover": tokens.colorBorderStrong,
			":focus": tokens.colorTextFaint
		},
		borderRadius: tokens.radiusControl,
		outline: "none",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		fontSize: 13,
		transitionProperty: "border-color",
		transitionDuration: tokens.motionFast,
		"::placeholder": { color: tokens.colorTextFaint }
	},
	searchSpinner: { position: "absolute", right: 10, top: 10 },
	searchGlyph: {
		position: "absolute",
		left: 10,
		top: "50%",
		color: tokens.colorTextMuted,
		fontSize: 16,
		lineHeight: 1,
		pointerEvents: "none",
		transform: "translateY(-55%)"
	},
	pickerMenu: {
		position: "absolute",
		top: "calc(100% + 6px)",
		left: 0,
		width: "max(100%, 460px)",
		overflow: "hidden",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: tokens.shadowOverlay
	},

	browser: { display: "grid" },
	browserInline: {
		marginTop: 16,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	browserHeader: {
		display: "flex",
		alignItems: "center",
		gap: 16,
		padding: "10px 16px",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		color: tokens.colorTextStrong,
		fontSize: 13
	},
	browserTitle: { flexShrink: 0 },
	browserCount: {
		marginLeft: "auto",
		flexShrink: 0,
		color: tokens.colorTextMuted,
		fontSize: 12,
		fontWeight: 400
	},
	browserNote: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		margin: 0,
		padding: "12px 16px",
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	browserError: {
		justifyContent: "space-between",
		borderColor: tokens.colorDanger,
		borderStyle: "solid",
		borderWidth: 1
	},
	browserErrorCopy: { display: "grid", gap: 2 },
	browserFooter: {
		margin: 0,
		padding: "8px 14px",
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: tokens.colorBorder,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	results: { display: "grid", maxHeight: 340, overflowY: "auto" },
	resultsInline: { maxHeight: "calc(100vh - 290px)", minHeight: 0 },
	result: {
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorAccent },
		outlineOffset: -1,
		outlineStyle: "solid",
		outlineWidth: 1,
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 16,
		padding: "8px 16px",
		borderWidth: 0,
		borderBottomWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		backgroundColor: {
			default: "transparent",
			":hover": tokens.colorSurfaceHover,
			":focus-visible": tokens.colorSurfaceHover
		},
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left",
		transitionProperty: "background-color",
		transitionDuration: tokens.motionFast
	},
	resultIdentity: { minWidth: 0, display: "grid", gap: 2 },
	resultName: {
		overflow: "hidden",
		color: tokens.colorTextStrong,
		fontSize: 13,
		fontWeight: 510,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	resultPackage: {
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	chip: {
		maxWidth: 180,
		padding: "2px 7px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: "rgba(255, 255, 255, 0.05)",
		color: tokens.colorTextMuted,
		fontSize: 11,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},

	emptyState: {
		display: "grid",
		justifyItems: "center",
		gap: 8,
		padding: "56px 32px",
		textAlign: "center"
	},
	emptyTitle: { margin: 0, color: tokens.colorTextStrong, fontSize: 15, fontWeight: 590 },
	emptyText: {
		maxWidth: 460,
		margin: 0,
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.55
	},

	notice: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		marginTop: 12,
		padding: "9px 12px",
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		fontSize: 12
	},
	noticeDetail: { color: tokens.colorTextMuted },
	spinner: {
		width: 12,
		height: 12,
		flex: "0 0 auto",
		borderWidth: 2,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderTopColor: tokens.colorAccent,
		borderRadius: "50%",
		animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
		animationDuration: "700ms",
		animationIterationCount: "infinite",
		animationTimingFunction: "linear"
	},

	callout: {
		display: "grid",
		gridTemplateColumns: "auto minmax(0, 1fr)",
		alignItems: "start",
		gap: 10,
		marginTop: 12,
		padding: "10px 12px",
		borderWidth: 1,
		borderStyle: "solid",
		borderRadius: tokens.radiusControl,
		color: tokens.colorText,
		fontSize: 12
	},
	danger: { borderColor: "rgba(235,87,87,.3)", backgroundColor: "rgba(235,87,87,.06)" },
	warning: { borderColor: "rgba(242,153,74,.28)", backgroundColor: "rgba(242,153,74,.055)" },
	calloutMark: {
		width: 18,
		height: 18,
		display: "grid",
		placeItems: "center",
		borderRadius: "50%",
		fontSize: 11,
		fontWeight: 700
	},
	dangerMark: { backgroundColor: "rgba(235,87,87,.16)", color: tokens.colorDanger },
	warningMark: { backgroundColor: "rgba(242,153,74,.15)", color: tokens.colorWarning },
	calloutCopy: { minWidth: 0, display: "grid", gap: 3 },
	calloutTitle: { color: tokens.colorTextStrong, fontSize: 12, fontWeight: 590 },
	calloutText: { margin: 0, color: tokens.colorTextMuted, lineHeight: 1.5 },
	calloutCode: {
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		overflowWrap: "anywhere"
	},
	detailList: {
		display: "grid",
		gap: 4,
		margin: "4px 0 0",
		paddingLeft: 16,
		color: tokens.colorTextMuted
	},
	diagnosticCode: { color: tokens.colorWarning, fontFamily: tokens.fontMono, fontSize: 11 },
	gapDetails: { marginTop: 2 },
	gapSummary: { color: tokens.colorText, cursor: "pointer", fontSize: 12 },
	gapItem: { display: "grid", gap: 2, lineHeight: 1.45 },

	summary: {
		position: "relative",
		zIndex: 3,
		display: "flex",
		flexWrap: { default: "nowrap", "@media (max-width: 899px)": "wrap" },
		alignItems: "center",
		gap: { default: 24, "@media (max-width: 899px)": 16 },
		marginTop: 16,
		padding: "12px 16px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface
	},
	identity: { minWidth: 0, flex: "0 1 auto", display: "grid", gap: 2 },
	assetTitle: {
		margin: 0,
		overflow: "hidden",
		color: tokens.colorTextStrong,
		fontSize: 15,
		fontWeight: 590,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	assetMeta: {
		minWidth: 0,
		display: "flex",
		alignItems: "baseline",
		gap: 10,
		overflow: "hidden",
		color: tokens.colorTextMuted,
		fontSize: 12,
		whiteSpace: "nowrap"
	},
	assetPackage: {
		minWidth: 0,
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis"
	},
	metrics: {
		display: "flex",
		gap: { default: 20, "@media (max-width: 899px)": 12 },
		flexShrink: 0,
		flexWrap: { default: "nowrap", "@media (max-width: 899px)": "wrap" },
		marginLeft: { default: "auto", "@media (max-width: 899px)": 0 }
	},
	metric: { display: "flex", alignItems: "baseline", gap: 5 },
	metricValue: {
		color: tokens.colorTextStrong,
		fontSize: 14,
		fontVariantNumeric: "tabular-nums"
	},
	metricLabel: { color: tokens.colorTextMuted, fontSize: 12 },
	coverageChip: {
		display: "inline-flex",
		alignItems: "center",
		gap: 7,
		flexShrink: 0,
		padding: "4px 10px",
		borderRadius: tokens.radiusPill,
		backgroundColor: "rgba(76,183,130,.1)",
		color: tokens.colorSuccess,
		fontSize: 12,
		fontWeight: 510,
		whiteSpace: "nowrap"
	},
	coverageChipPartial: { backgroundColor: "rgba(242,153,74,.1)", color: tokens.colorWarning },
	coverageDot: { width: 6, height: 6, borderRadius: "50%" },
	coverageDotReady: { backgroundColor: tokens.colorSuccess },
	coverageDotGap: { backgroundColor: tokens.colorWarning },

	workspace: {
		marginTop: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	toolbar: {
		position: "relative",
		zIndex: 2,
		height: { default: 42, "@media (max-width: 899px)": "auto" },
		minHeight: { default: 0, "@media (max-width: 899px)": 42 },
		display: "flex",
		flexWrap: { default: "nowrap", "@media (max-width: 899px)": "wrap" },
		alignItems: "stretch",
		justifyContent: "space-between",
		gap: 16,
		paddingRight: 8,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	toolbarNote: {
		alignSelf: "center",
		paddingLeft: 16,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	tabs: {
		minWidth: 0,
		minHeight: { default: 0, "@media (max-width: 899px)": 42 },
		display: "flex",
		alignItems: "stretch",
		overflowX: "auto"
	},
	tab: {
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorAccent },
		outlineOffset: -1,
		outlineStyle: "solid",
		outlineWidth: 1,
		minWidth: 0,
		maxWidth: 260,
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "0 14px",
		borderWidth: 0,
		borderBottomWidth: 2,
		borderStyle: "solid",
		borderColor: "transparent",
		backgroundColor: "transparent",
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorText },
		cursor: "pointer",
		fontSize: 12,
		transitionProperty: "color, border-color",
		transitionDuration: tokens.motionFast
	},
	tabActive: { borderBottomColor: tokens.colorAccent, color: tokens.colorTextStrong },
	tabName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	tabCount: {
		padding: "0 5px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: "rgba(255,255,255,.06)",
		color: tokens.colorTextMuted,
		fontSize: 10,
		fontVariantNumeric: "tabular-nums",
		lineHeight: "16px"
	},
	graphSearch: {
		position: "relative",
		alignSelf: "center",
		width: { default: 260, "@media (max-width: 899px)": "100%" },
		margin: { default: 0, "@media (max-width: 899px)": "0 0 8px 8px" },
		flexShrink: { default: 0, "@media (max-width: 899px)": 1 }
	},
	graphSearchField: { position: "relative", display: "block" },
	graphSearchInput: {
		width: "100%",
		height: 28,
		padding: "0 10px 0 30px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":focus": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		outline: "none",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		fontSize: 12,
		"::placeholder": { color: tokens.colorTextFaint }
	},
	graphSearchMenu: {
		position: "absolute",
		top: "calc(100% + 6px)",
		right: 0,
		width: { default: 360, "@media (max-width: 899px)": "100%" },
		maxHeight: 380,
		overflowY: "auto",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: tokens.shadowOverlay
	},
	menuNote: { margin: 0, padding: "10px 12px", color: tokens.colorTextMuted, fontSize: 12 },
	hitList: { margin: 0, padding: 4, listStyle: "none" },
	hit: {
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorAccent },
		outlineOffset: -1,
		outlineStyle: "solid",
		outlineWidth: 1,
		width: "100%",
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "34px minmax(0, 1fr) minmax(0, auto)",
		alignItems: "center",
		gap: 8,
		padding: "6px 8px",
		borderWidth: 0,
		borderRadius: tokens.radiusBadge,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		cursor: "pointer",
		fontSize: 12,
		textAlign: "left"
	},
	hitKind: {
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 10,
		textTransform: "uppercase"
	},
	hitLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	hitContext: {
		maxWidth: 140,
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},

	workspaceBody: {
		height: { default: "calc(100vh - 250px)", "@media (max-width: 899px)": "auto" },
		minHeight: 480,
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 360px",
			"@media (min-width: 900px) and (max-width: 1180px)": "minmax(0, 1fr) 300px",
			"@media (max-width: 899px)": "minmax(0, 1fr)"
		},
		gridTemplateRows: { default: "auto", "@media (max-width: 899px)": "420px auto" }
	},
	canvasFrame: { position: "relative", minWidth: 0, minHeight: 0, display: "grid" },
	viewport: {
		overflow: "auto",
		outlineWidth: { default: 0, ":focus-visible": 1 },
		outlineStyle: "solid",
		outlineColor: tokens.colorAccent,
		outlineOffset: -2,
		cursor: "grab",
		touchAction: "none",
		backgroundColor: "#0a0c0f",
		backgroundImage:
			"linear-gradient(rgba(103,113,126,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(103,113,126,.08) 1px, transparent 1px), linear-gradient(rgba(103,113,126,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(103,113,126,.035) 1px, transparent 1px)",
		backgroundSize: "80px 80px, 80px 80px, 16px 16px, 16px 16px"
	},
	viewportPanning: { cursor: "grabbing", userSelect: "none" },
	canvas: { position: "relative", transformOrigin: "top left" },
	wires: {
		position: "absolute",
		zIndex: 1,
		inset: 0,
		overflow: "visible",
		pointerEvents: "none",
		fill: "none"
	},
	wire: {
		strokeLinecap: "round",
		vectorEffect: "non-scaling-stroke",
		transitionProperty: "opacity, stroke-width",
		transitionDuration: tokens.motionFast
	},
	panHint: {
		position: "absolute",
		left: 14,
		bottom: 14,
		color: tokens.colorTextFaint,
		fontSize: 11,
		pointerEvents: "none",
		display: { default: "block", "@media (max-width: 1180px)": "none" }
	},
	zoomCluster: {
		position: "absolute",
		right: 12,
		bottom: 12,
		display: "flex",
		alignItems: "center",
		gap: 2,
		padding: 3,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(15,16,17,.92)",
		boxShadow: "0 6px 18px rgba(0,0,0,.4)"
	},
	zoomButton: {
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorAccent },
		outlineOffset: -1,
		outlineStyle: "solid",
		outlineWidth: 1,
		height: 26,
		minWidth: 26,
		padding: 0,
		borderWidth: 0,
		borderRadius: tokens.radiusBadge,
		backgroundColor: { default: "transparent", ":hover": "rgba(255,255,255,.07)" },
		color: tokens.colorText,
		cursor: "pointer",
		fontSize: 14,
		transitionProperty: "background-color, transform",
		transitionDuration: tokens.motionFast,
		transform: { default: "none", ":active": "scale(0.95)" }
	},
	zoomText: { padding: "0 8px", fontSize: 11 },
	zoomOutput: {
		minWidth: 42,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontVariantNumeric: "tabular-nums",
		textAlign: "center"
	},
	zoomDivider: {
		width: 1,
		height: 16,
		marginLeft: 3,
		marginRight: 3,
		backgroundColor: tokens.colorBorder
	},
	emptyGraphCanvas: {
		position: "absolute",
		left: GRAPH_MARGIN,
		top: GRAPH_MARGIN,
		display: "grid",
		gap: 5,
		padding: "12px 14px",
		borderWidth: 1,
		borderStyle: "dashed",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		color: tokens.colorTextMuted,
		fontSize: 12
	},

	node: {
		position: "absolute",
		zIndex: 2,
		// Buttons centre their content; pin rows must start at the layout offset wires target.
		display: "flex",
		flexDirection: "column",
		justifyContent: "flex-start",
		padding: 0,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: "#2f343c", ":hover": "#4d5460" },
		borderRadius: 8,
		backgroundColor: "rgba(20,23,28,.96)",
		color: tokens.colorText,
		boxShadow: "0 8px 22px rgba(0,0,0,.38)",
		overflow: "visible",
		textAlign: "left",
		cursor: "pointer",
		transitionProperty: "border-color, box-shadow",
		transitionDuration: tokens.motionFast,
		transitionTimingFunction: tokens.motionEaseOut
	},
	comment: {
		position: "absolute",
		zIndex: 0,
		display: "flex",
		flexDirection: "column",
		justifyContent: "flex-start",
		padding: 0,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: "rgba(255,255,255,.12)", ":hover": "rgba(255,255,255,.22)" },
		borderRadius: 8,
		backgroundColor: "rgba(255,255,255,.025)",
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left",
		transitionProperty: "border-color",
		transitionDuration: tokens.motionFast
	},
	commentSelected: {
		borderColor: { default: tokens.colorAccent, ":hover": tokens.colorAccent }
	},
	commentHeader: {
		display: "block",
		padding: "7px 12px",
		overflow: "hidden",
		borderTopLeftRadius: 7,
		borderTopRightRadius: 7,
		backgroundColor: "rgba(255,255,255,.06)",
		color: tokens.colorTextStrong,
		fontSize: 13,
		fontWeight: 510,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	nodeSelected: {
		borderColor: { default: tokens.colorAccent, ":hover": tokens.colorAccent },
		boxShadow: "0 0 0 1px rgba(124, 192, 255, .3), 0 12px 30px rgba(0,0,0,.5)"
	},
	nodeHeader: {
		height: NODE_HEADER_INNER_HEIGHT,
		display: "grid",
		alignContent: "center",
		gap: 1,
		padding: "0 12px",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: "rgba(255,255,255,.06)",
		borderTopLeftRadius: 7,
		borderTopRightRadius: 7,
		backgroundImage: "linear-gradient(90deg, rgba(138,145,156,.2), rgba(138,145,156,.03))"
	},
	nodeHeaderEvent: {
		backgroundImage: "linear-gradient(90deg, rgba(239,106,103,.32), rgba(239,106,103,.04))"
	},
	nodeHeaderFunction: {
		backgroundImage: "linear-gradient(90deg, rgba(79,157,223,.32), rgba(79,157,223,.04))"
	},
	nodeHeaderVariable: {
		backgroundImage: "linear-gradient(90deg, rgba(96,181,141,.3), rgba(96,181,141,.04))"
	},
	nodeTitle: {
		minWidth: 0,
		overflow: "hidden",
		color: tokens.colorTextStrong,
		fontSize: 12,
		fontWeight: 590,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	nodeClass: { color: "rgba(208,214,224,.6)", fontSize: 10 },
	pinRow: {
		position: "relative",
		height: PIN_ROW_HEIGHT,
		display: "grid",
		gridTemplateColumns: "1fr 1fr",
		alignItems: "center",
		color: "#b7bdc7",
		fontSize: 11
	},
	pinSide: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	pinInput: { paddingLeft: 13 },
	pinOutput: { paddingRight: 13, textAlign: "right" },
	pinData: {
		width: 10,
		height: 10,
		flex: "0 0 auto",
		borderWidth: 2,
		borderStyle: "solid",
		borderRadius: "50%"
	},
	pinExec: {
		width: 9,
		height: 11,
		flex: "0 0 auto",
		clipPath: "polygon(0 0, 55% 0, 100% 50%, 55% 100%, 0 100%)"
	},
	pinEdgeInput: { position: "absolute", top: "50%", left: -6, transform: "translateY(-50%)" },
	pinEdgeOutput: { position: "absolute", top: "50%", right: -6, transform: "translateY(-50%)" },

	inspector: {
		minWidth: 0,
		minHeight: 0,
		display: "flex",
		flexDirection: "column",
		borderLeftWidth: { default: 1, "@media (max-width: 899px)": 0 },
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorBorder,
		borderTopWidth: { default: 0, "@media (max-width: 899px)": 1 },
		borderTopStyle: "solid",
		borderTopColor: tokens.colorBorder,
		maxHeight: { default: "none", "@media (max-width: 899px)": 600 },
		backgroundColor: tokens.colorSurface
	},
	inspectorTabs: {
		flexShrink: 0,
		height: 38,
		paddingLeft: 4,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	inspectorBody: { minHeight: 0, flex: "1 1 auto", overflowY: "auto", padding: "14px 16px 20px" },
	inspectorContent: { display: "grid", alignContent: "start" },
	nodeHeading: { minWidth: 0, display: "grid", justifyItems: "start", gap: 4, marginBottom: 8 },
	inspectorTitle: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontSize: 15,
		fontWeight: 590,
		lineHeight: 1.3,
		overflowWrap: "anywhere"
	},
	kindChip: {
		padding: "1px 6px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: "rgba(138,145,156,.14)",
		color: tokens.colorTextMuted,
		fontSize: 11,
		textTransform: "capitalize"
	},
	kindEvent: { backgroundColor: "rgba(239,106,103,.14)", color: "#f08c8a" },
	kindFunction: { backgroundColor: "rgba(79,157,223,.15)", color: "#7db7ea" },
	kindVariable: { backgroundColor: "rgba(96,181,141,.15)", color: "#80d9ad" },
	emptyNote: { margin: 0, padding: "6px 0", color: tokens.colorTextFaint, fontSize: 12 },
	sectionHeading: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "baseline",
		margin: "18px 0 4px",
		paddingBottom: 6,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		color: tokens.colorText,
		fontSize: 12,
		fontWeight: 590
	},
	sectionCount: {
		color: tokens.colorTextFaint,
		fontSize: 11,
		fontWeight: 400,
		fontVariantNumeric: "tabular-nums"
	},
	facts: { display: "grid", margin: 0 },
	fact: {
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "76px minmax(0, 1fr)",
		gap: 10,
		padding: "5px 0",
		fontSize: 12,
		lineHeight: 1.45
	},
	factLabel: { color: tokens.colorTextMuted },
	factValue: { minWidth: 0, margin: 0, color: tokens.colorText, overflowWrap: "anywhere" },
	mono: { fontFamily: tokens.fontMono, fontSize: 11 },
	objectPath: {
		display: "block",
		maxWidth: "100%",
		padding: "2px 0",
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},

	pinEvidenceList: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
	pinEvidence: {
		minWidth: 0,
		display: "grid",
		gap: 4,
		padding: "8px 0",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	pinEvidenceHeader: {
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "12px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 8
	},
	pinEvidenceName: {
		overflow: "hidden",
		color: tokens.colorTextStrong,
		fontSize: 12,
		fontWeight: 510,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	pinDirection: { color: tokens.colorTextFaint, fontSize: 11 },
	pinEvidenceMeta: {
		display: "flex",
		flexWrap: "wrap",
		gap: "2px 10px",
		paddingLeft: 20,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	pinType: { color: tokens.colorTextMuted, fontFamily: tokens.fontMono, fontSize: 11 },
	pinDefaults: { display: "grid", gap: 2, margin: 0, paddingLeft: 20 },
	pinDefaultRow: {
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "112px minmax(0, 1fr)",
		gap: 8,
		fontSize: 11
	},
	pinDefaultValue: {
		minWidth: 0,
		margin: 0,
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	pinTooltip: {
		margin: 0,
		paddingLeft: 20,
		color: tokens.colorTextMuted,
		fontSize: 11,
		lineHeight: 1.45
	},

	properties: { display: "grid" },
	property: {
		minWidth: 0,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	propertySummary: {
		minWidth: 0,
		display: "flex",
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: 10,
		padding: "6px 0",
		color: { default: tokens.colorText, ":hover": tokens.colorTextStrong },
		cursor: "pointer",
		fontSize: 12,
		listStyle: "none"
	},
	propertyName: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
	propertyType: {
		flexShrink: 0,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	codeBlock: {
		display: "block",
		maxHeight: 180,
		margin: "0 0 8px",
		padding: "8px 10px",
		overflow: "auto",
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		lineHeight: 1.5,
		overflowWrap: "anywhere",
		whiteSpace: "pre-wrap"
	},
	entry: {
		minWidth: 0,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	entrySummary: {
		padding: "7px 0",
		overflow: "hidden",
		color: { default: tokens.colorTextStrong, ":hover": tokens.colorAccent },
		cursor: "pointer",
		fontSize: 12,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	entryMeta: { color: tokens.colorTextFaint, fontSize: 11 },
	entryBody: { display: "grid", gap: 4, padding: "0 0 10px 14px" }
});
