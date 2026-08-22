import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";

export const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		boxSizing: "border-box",
		padding: "14px 22px 24px",
		backgroundColor: tokens.colorCanvas,
		backgroundImage: "none",
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		paddingBottom: 8,
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	breadcrumb: {
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: ".04em"
	},
	title: { margin: "2px 0 0", fontSize: 22, fontWeight: 590, letterSpacing: "-0.02em" },
	headerSubtitle: { margin: "2px 0 0", color: tokens.colorTextMuted, fontSize: 12 },
	headerSignal: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		color: tokens.colorWarning,
		fontSize: 11
	},
	sectionKicker: {
		display: "block",
		color: tokens.colorWarning,
		fontSize: 11,
		fontWeight: 500
	},
	queryPanel: {
		display: "grid",
		gridTemplateColumns: "minmax(280px, 1fr) auto minmax(430px, auto)",
		alignItems: "end",
		gap: 10,
		marginTop: 8,
		padding: "8px 9px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		borderRadius: tokens.radiusPanel
	},
	queryLead: {
		gridRow: "span 2",
		display: "flex",
		flexDirection: "column",
		gap: 9,
		paddingRight: 18,
		borderRight: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.55
	},
	mapInputLabel: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	mapInput: {
		width: "100%",
		boxSizing: "border-box",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "10px 11px",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		borderRadius: tokens.radiusControl,
		outline: { default: "none", ":focus": `1px solid ${tokens.colorTextSubtle}` }
	},
	mapChoices: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: -10 },
	mapChoice: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "5px 7px",
		fontSize: 11,
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	mapChoiceActive: {
		borderColor: tokens.colorTextSubtle,
		color: tokens.colorTextStrong,
		backgroundColor: "rgba(255, 255, 255, 0.07)"
	},
	historyModes: {
		display: "flex",
		alignItems: "center",
		gap: 5,
		marginTop: 0,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	historyModeButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "7px 8px",
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	historyModeButtonActive: {
		borderColor: tokens.colorTextSubtle,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong
	},
	fastTargetPanel: {
		gridColumn: "1 / -1",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		gap: "8px 12px",
		padding: "9px 10px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.45
	},
	loadTargetsButton: {
		alignSelf: "start",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":disabled": "transparent"
		},
		color: { default: tokens.colorText, ":disabled": tokens.colorTextFaint },
		opacity: { default: 1, ":disabled": 0.5 },
		padding: "8px 10px",
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	fastTargetModes: {
		display: "flex",
		alignItems: "center",
		gap: 5,
		gridColumn: "1 / -1",
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	fastTargetMode: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "6px 8px",
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	fastTargetModeActive: {
		borderColor: tokens.colorTextSubtle,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong
	},
	targetSearchLabel: {
		display: "grid",
		gridColumn: "1 / -1",
		gap: 5,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	targetSearchInput: {
		width: "100%",
		boxSizing: "border-box",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "8px 9px",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		borderRadius: tokens.radiusControl,
		outline: { default: "none", ":focus": `1px solid ${tokens.colorTextSubtle}` }
	},
	targetList: {
		gridColumn: "1 / -1",
		maxHeight: 260,
		overflowY: "auto",
		listStyle: "none",
		margin: 0,
		padding: 0,
		borderTop: `1px solid ${tokens.colorBorder}`
	},
	targetRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(130px, .6fr) minmax(180px, 1fr) minmax(180px, 1.3fr)",
		gap: 8,
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		padding: "8px 9px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 12,
		"@media (max-width: 720px)": { gridTemplateColumns: "1fr" }
	},
	targetClassRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 8,
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		padding: "8px 9px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 12
	},
	targetRowActive: {
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong,
		boxShadow: `inset 2px 0 ${tokens.colorAccent}`
	},
	targetRowSmall: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono
	},
	targetEmpty: { gridColumn: "1 / -1", margin: 0, color: tokens.colorTextMuted },
	targetError: { gridColumn: "1 / -1", margin: 0, color: tokens.colorDanger },
	rangeControls: {
		display: "flex",
		alignItems: "center",
		justifyContent: "flex-end",
		gap: 5,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	rangeButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "7px 8px",
		fontSize: 11,
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	rangeButtonActive: {
		borderColor: tokens.colorTextSubtle,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong
	},
	runButton: {
		marginLeft: 8,
		border: `1px solid ${tokens.colorAccent}`,
		backgroundColor: { default: tokens.colorAccent, ":hover": tokens.colorAccentStrong },
		color: tokens.colorAccentText,
		opacity: { default: 1, ":disabled": 0.5 },
		padding: "8px 11px",
		fontWeight: 500,
		fontSize: 12,
		borderRadius: tokens.radiusControl,
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	advancedButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":disabled": "transparent"
		},
		color: { default: tokens.colorTextMuted, ":disabled": tokens.colorTextFaint },
		opacity: { default: 1, ":disabled": 0.5 },
		padding: "8px 9px",
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	scanLimits: {
		gridColumn: "1 / -1",
		display: "grid",
		gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
		gap: 9,
		margin: 0,
		padding: "12px 13px 13px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500,
		"@media (max-width: 820px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
		"@media (max-width: 480px)": { gridTemplateColumns: "1fr" }
	},
	scanLimitLabel: { display: "grid", gap: 5 },
	scanLimitInput: {
		width: "100%",
		boxSizing: "border-box",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "7px 8px",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		borderRadius: tokens.radiusControl,
		outline: { default: "none", ":focus": `1px solid ${tokens.colorTextSubtle}` }
	},
	centerState: {
		minHeight: 420,
		display: "grid",
		placeItems: "center",
		color: tokens.colorTextMuted
	},
	notConfigured: {
		maxWidth: 620,
		margin: "70px auto",
		padding: 28,
		borderLeft: `3px solid ${tokens.colorWarning}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorText,
		borderRadius: tokens.radiusPanel
	},
	runningState: {
		marginTop: 14,
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		padding: "16px 18px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		borderRadius: tokens.radiusPanel
	},
	runningSubprogress: {
		display: "block",
		marginTop: 6,
		color: tokens.colorTextMuted,
		fontSize: 11,
		letterSpacing: ".04em"
	},
	cancelButton: {
		border: `1px solid ${tokens.colorDanger}`,
		backgroundColor: "transparent",
		color: tokens.colorDanger,
		padding: "7px 9px",
		fontSize: 11,
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	notice: {
		marginTop: 14,
		padding: "12px 14px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorWarning,
		fontSize: 13
	},
	errorState: {
		marginTop: 14,
		padding: 18,
		border: `1px solid ${tokens.colorDanger}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorDanger
	},
	playbackUnavailable: {
		marginTop: 14,
		padding: 18,
		border: `1px solid ${tokens.colorDanger}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorDanger,
		fontSize: 11,
		lineHeight: 1.5
	},
	staleResult: {
		marginTop: 14,
		padding: "12px 14px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorWarning,
		fontSize: 12,
		lineHeight: 1.5
	},
	fastCoverageNotice: {
		marginTop: 14,
		padding: "13px 14px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorWarning,
		fontSize: 12,
		lineHeight: 1.5
	},
	worldLogTargetLoading: {
		marginTop: 14,
		display: "grid",
		gap: 5,
		padding: "15px 16px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		fontSize: 11
	},
	worldLogTargetLoadingCopy: { margin: 0, color: tokens.colorTextMuted, fontSize: 12 },
	investigationBar: {
		display: "flex",
		alignItems: "stretch",
		justifyContent: "space-between",
		gap: 12,
		marginTop: 8,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		borderRadius: tokens.radiusPanel
	},
	lensTabs: { display: "flex" },
	lensTab: {
		border: 0,
		borderRight: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorTextMuted,
		padding: "8px 12px",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		fontWeight: 500,
		cursor: "pointer"
	},
	lensTabActive: {
		color: tokens.colorTextStrong,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		borderRadius: tokens.radiusBadge,
		boxShadow: `inset 0 -2px ${tokens.colorAccent}`
	},
	investigationFacts: {
		display: "flex",
		alignItems: "center",
		gap: 14,
		padding: "0 10px",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		whiteSpace: "nowrap"
	},
	investigationWarning: { color: tokens.colorWarning },
	actorAtlasPath: {
		display: "block",
		maxWidth: "min(70vw, 720px)",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	actorAtlas: {
		marginTop: 8,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		boxShadow: `inset 3px 0 ${tokens.colorAccent}`,
		borderRadius: tokens.radiusPanel
	},
	actorAtlasHeader: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 18,
		padding: "10px 12px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	snapshotSummary: {
		display: "grid",
		gridTemplateColumns: "auto auto",
		columnGap: 7,
		alignItems: "baseline",
		color: tokens.colorTextMuted,
		fontSize: 11,
		textAlign: "right"
	},
	playbackFrames: {
		display: "flex",
		gap: 5,
		overflowX: "auto",
		padding: "6px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	playbackFrameButton: {
		flexShrink: 0,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "5px 7px",
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	playbackFrameButtonActive: {
		borderColor: tokens.colorTextSubtle,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong
	},
	frameNotice: {
		padding: "8px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 11,
		lineHeight: 1.5
	},
	frameNoticePartial: { backgroundColor: tokens.colorSurfaceRaised, color: tokens.colorWarning },
	frameNoticeUnclassified: {
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorWarning
	},
	snapshotUnavailable: {
		minHeight: 180,
		display: "grid",
		placeItems: "center",
		padding: 24,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.6,
		textAlign: "center"
	},
	actorAtlasWorkspace: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(210px, 260px) minmax(0, 1fr) minmax(220px, 270px)",
			"@media (max-width: 1020px)": "minmax(190px, .8fr) minmax(0, 1.4fr)",
			"@media (max-width: 720px)": "1fr"
		},
		gridTemplateRows: {
			default: "500px",
			"@media (max-width: 1020px)": "500px auto",
			"@media (max-width: 720px)": "420px auto auto"
		},
		minWidth: 0
	},
	actorOutliner: {
		minWidth: 0,
		borderRight: { default: `1px solid ${tokens.colorBorder}`, "@media (max-width: 720px)": 0 },
		borderBottom: {
			default: 0,
			"@media (max-width: 720px)": `1px solid ${tokens.colorBorder}`
		},
		backgroundColor: tokens.colorSurface
	},
	actorSearch: {
		display: "grid",
		gap: 6,
		padding: 13,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	actorSearchHelp: {
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 400,
		letterSpacing: 0,
		lineHeight: 1.4
	},
	actorSearchInput: {
		width: "100%",
		boxSizing: "border-box",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "8px 9px",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		borderRadius: tokens.radiusControl,
		outline: { default: "none", ":focus": `1px solid ${tokens.colorTextSubtle}` }
	},
	actorFilterBar: {
		display: "flex",
		flexWrap: "wrap",
		gap: 4,
		padding: "0 13px 11px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	actorFilterButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "4px 5px",
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	actorFilterButtonActive: {
		borderColor: tokens.colorTextSubtle,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong
	},
	actorFilterSelect: {
		maxWidth: "100%",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		padding: "4px 5px",
		fontFamily: tokens.fontMono,
		fontSize: 11,
		borderRadius: tokens.radiusControl
	},
	outlinerCount: {
		display: "flex",
		justifyContent: "space-between",
		gap: 7,
		padding: "0 13px 10px",
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	actorList: {
		maxHeight: 340,
		overflowY: "auto",
		listStyle: "none",
		margin: 0,
		padding: 0,
		borderTop: `1px solid ${tokens.colorBorder}`
	},
	actorListItem: { margin: 0, padding: 0 },
	actorRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "25px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 8,
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		borderLeft: "2px solid transparent",
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		padding: "8px 10px",
		textAlign: "left",
		cursor: "pointer"
	},
	actorRowSelected: {
		borderLeftColor: tokens.colorAccent,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong
	},
	actorRowHistorical: { opacity: 0.62 },
	actorEventCount: {
		display: "grid",
		placeItems: "center",
		width: 20,
		height: 20,
		border: `1px solid ${tokens.colorBorderStrong}`,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusBadge
	},
	actorRowCopy: { display: "grid", minWidth: 0, gap: 2, fontSize: 12 },
	pointMapFrame: {
		position: "relative",
		height: "100%",
		minHeight: 360,
		overflow: "hidden",
		backgroundColor: tokens.colorSurfaceInset,
		backgroundImage:
			"radial-gradient(circle at 50% 45%, rgba(255, 255, 255, 0.02), transparent 46%), linear-gradient(135deg, rgba(255, 255, 255, 0.02) 25%, transparent 25%)",
		backgroundSize: "auto, 18px 18px"
	},
	pointMap: { width: "100%", height: "100%", minHeight: 360, display: "block", outline: "none" },
	northMarker: {
		position: "absolute",
		top: 12,
		left: 14,
		zIndex: 2,
		color: "#02b8cc",
		fontSize: 11,
		fontWeight: 500
	},
	pointMapLegend: {
		position: "absolute",
		display: "flex",
		maxWidth: "68%",
		gap: 10,
		alignItems: "center",
		right: 13,
		bottom: 12,
		zIndex: 2,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "rgba(22, 23, 24, 0.87)",
		color: tokens.colorTextMuted,
		padding: "5px 7px",
		fontSize: 11,
		overflow: "hidden",
		whiteSpace: "nowrap"
	},
	pointMapOverlayLegend: {
		position: "absolute",
		display: "flex",
		flexWrap: "wrap",
		maxWidth: "62%",
		gap: 8,
		alignItems: "center",
		left: 13,
		bottom: 12,
		zIndex: 2,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "rgba(22, 23, 24, 0.91)",
		color: tokens.colorWarning,
		padding: "5px 7px",
		fontSize: 11,
		overflow: "hidden"
	},
	pointMapClassDot: {
		display: "inline-block",
		width: 7,
		height: 7,
		marginRight: 4,
		borderRadius: "50%"
	},
	pointMapReset: {
		position: "absolute",
		left: "50%",
		bottom: 12,
		zIndex: 2,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "rgba(22, 23, 24, 0.85)", ":hover": "rgba(26, 27, 30, 0.95)" },
		color: tokens.colorText,
		padding: "5px 8px",
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		transform: "translateX(-50%)",
		cursor: "pointer"
	},
	noResolvedActors: {
		minHeight: 360,
		display: "grid",
		placeItems: "center",
		padding: 24,
		color: tokens.colorTextMuted,
		fontSize: 12,
		textAlign: "center"
	},
	actorInspector: {
		minWidth: 0,
		minHeight: 0,
		height: "100%",
		overflowY: "auto",
		padding: 17,
		borderLeft: { default: `1px solid ${tokens.colorBorder}`, "@media (max-width: 1020px)": 0 },
		borderTop: { default: 0, "@media (max-width: 1020px)": `1px solid ${tokens.colorBorder}` },
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		"@media (max-width: 1020px)": { gridColumn: "1 / -1" }
	},
	actorInspectorEmpty: {
		minHeight: 180,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.6
	},
	actorFacts: {
		display: "grid",
		gap: 8,
		margin: "17px 0",
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontFamily: tokens.fontMono
	},
	actorEventSection: { marginTop: 16 },
	actorEventList: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		margin: "7px 0 0",
		padding: 0,
		listStyle: "none",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		lineHeight: 1.45
	},
	actorEventButton: {
		width: "100%",
		display: "flex",
		flexDirection: "column",
		gap: 2,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: {
			default: tokens.colorSurfaceInset,
			":hover": "rgba(255, 255, 255, 0.03)"
		},
		color: tokens.colorText,
		padding: "7px 8px",
		textAlign: "left",
		font: "inherit",
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	clearActorSelection: {
		width: "100%",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "9px 10px",
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusControl,
		cursor: "pointer"
	},
	timelineShell: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 340px)",
		gap: 14,
		marginTop: 8,
		"@media (max-width: 900px)": { gridTemplateColumns: "1fr" }
	},
	timeline: {
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		borderRadius: tokens.radiusPanel
	},
	timelineHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "start",
		padding: "17px 18px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	timelineSubhead: {
		margin: "5px 0 0",
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.45
	},
	completePill: {
		border: `1px solid ${tokens.colorSuccess}`,
		color: tokens.colorSuccess,
		padding: "4px 6px",
		fontSize: 11,
		borderRadius: tokens.radiusBadge
	},
	partialPill: { borderColor: tokens.colorWarning, color: tokens.colorWarning },
	filters: {
		display: "flex",
		gap: 5,
		overflowX: "auto",
		padding: "11px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	filterButton: {
		flexShrink: 0,
		border: 0,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "5px 6px",
		fontSize: 11,
		cursor: "pointer"
	},
	filterButtonActive: {
		color: tokens.colorTextStrong,
		borderRadius: tokens.radiusBadge,
		boxShadow: `inset 0 -2px ${tokens.colorAccent}`
	},
	timelineList: { padding: 14 },
	revision: {
		display: "grid",
		gridTemplateColumns: "72px minmax(0, 1fr)",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		paddingBottom: 11,
		marginBottom: 11
	},
	revisionSelected: {
		marginLeft: -5,
		paddingLeft: 5,
		borderLeft: `2px solid ${tokens.colorAccent}`
	},
	changeMarker: {
		display: "grid",
		alignContent: "start",
		justifyItems: "start",
		gap: 5,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	changeMarkerLabel: {
		display: "flex",
		alignItems: "baseline",
		gap: 4,
		fontFamily: tokens.fontMono,
		whiteSpace: "nowrap"
	},
	changelistSelect: {
		marginTop: 3,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: {
			default: "rgba(255, 255, 255, 0.05)",
			":hover": "rgba(255, 255, 255, 0.07)"
		},
		color: tokens.colorTextMuted,
		padding: "4px 5px",
		fontFamily: tokens.fontMono,
		fontSize: 11,
		fontWeight: 500,
		borderRadius: tokens.radiusBadge,
		cursor: "pointer"
	},
	changelistSelectActive: {
		borderColor: tokens.colorAccent,
		backgroundColor: tokens.colorAccentWash,
		color: tokens.colorTextStrong
	},
	revisionBody: { minWidth: 0 },
	revisionHeader: {
		display: "grid",
		gridTemplateColumns: "minmax(180px, .38fr) minmax(0, 1fr)",
		gap: 10,
		marginBottom: 7,
		color: tokens.colorTextMuted,
		fontSize: 12,
		minWidth: 0
	},
	revisionMeta: {
		display: "grid",
		gap: 3,
		minWidth: 0,
		color: tokens.colorText,
		fontFamily: tokens.fontMono
	},
	revisionDescription: {
		minWidth: 0,
		margin: 0,
		color: tokens.colorText,
		lineHeight: 1.35,
		overflowWrap: "anywhere"
	},
	revisionSummary: {
		marginBottom: 8,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	revisionEmpty: {
		margin: "5px 0",
		color: tokens.colorTextMuted,
		fontSize: 11,
		lineHeight: 1.35
	},
	changeRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(92px, .38fr) minmax(120px, .8fr) minmax(0, 1.5fr)",
		gap: 8,
		alignItems: "center",
		border: `1px solid ${tokens.colorBorder}`,
		borderLeftWidth: 3,
		backgroundColor: {
			default: tokens.colorSurfaceInset,
			":hover": "rgba(255, 255, 255, 0.03)"
		},
		color: tokens.colorText,
		padding: "9px 10px",
		marginTop: 5,
		textAlign: "left",
		cursor: "pointer",
		minWidth: 0,
		borderRadius: tokens.radiusControl
	},
	changeRowSelected: {
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		borderColor: tokens.colorAccent,
		color: tokens.colorTextStrong
	},
	added: { borderLeftColor: tokens.colorSuccess },
	removed: { borderLeftColor: tokens.colorDanger },
	changed: { borderLeftColor: "#02b8cc" },
	warning: { borderLeftColor: tokens.colorWarning },
	changeType: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	changeTitle: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontSize: 12
	},
	changeDetail: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	unclassifiedNotice: {
		display: "grid",
		gridTemplateColumns: "1fr auto",
		gap: "4px 8px",
		marginTop: 8,
		padding: "10px 11px",
		border: `1px dashed ${tokens.colorBorderStrong}`,
		color: tokens.colorWarning,
		fontSize: 12,
		borderRadius: tokens.radiusControl
	},
	unclassifiedNoticeCopy: { gridColumn: "1 / -1", margin: 0, lineHeight: 1.35 },
	evidencePanel: {
		alignSelf: "start",
		position: "sticky",
		top: 70,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		padding: 18,
		borderRadius: tokens.radiusPanel,
		boxShadow: tokens.shadowCard
	},
	evidenceEmpty: {
		minHeight: 180,
		display: "flex",
		alignItems: "center",
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.6
	},
	evidenceKind: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		marginTop: 18,
		padding: "11px 0",
		borderTop: `1px solid ${tokens.colorBorder}`,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorText,
		fontSize: 12
	},
	evidenceSummary: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		marginTop: 14,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	packageList: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		margin: "16px 0",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 12,
		minWidth: 0
	},
	packageEntry: { minWidth: 0 },
	packageAction: { display: "block", color: tokens.colorWarning, fontSize: 11 },
	packagePath: {
		margin: "3px 0 0",
		color: tokens.colorTextMuted,
		overflowWrap: "anywhere",
		lineHeight: 1.35
	},
	coverageFooter: {
		display: "flex",
		justifyContent: "space-between",
		paddingTop: 12,
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 11
	}
});
