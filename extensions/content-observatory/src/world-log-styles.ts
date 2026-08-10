import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";

export const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		boxSizing: "border-box",
		padding: "14px 22px 24px",
		backgroundColor: "#100f0e",
		backgroundImage: "none",
		color: tokens.colorText,
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif'
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		paddingBottom: 8,
		borderBottom: "1px solid #2e3432"
	},
	breadcrumb: {
		color: "#9aa7a7",
		fontSize: 9,
		letterSpacing: ".04em",
		textTransform: "uppercase"
	},
	title: { margin: "2px 0 0", fontSize: 19, fontWeight: 650, letterSpacing: 0 },
	headerSubtitle: { margin: "2px 0 0", color: "#85908c", fontSize: 10 },
	headerSignal: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		color: "#d7b469",
		fontSize: 9,
		letterSpacing: ".06em"
	},
	sectionKicker: {
		display: "block",
		color: "#d7b469",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".15em",
		textTransform: "uppercase"
	},
	queryPanel: {
		display: "grid",
		gridTemplateColumns: "minmax(280px, 1fr) auto minmax(430px, auto)",
		alignItems: "end",
		gap: 10,
		marginTop: 8,
		padding: "8px 9px",
		border: "1px solid #323936",
		backgroundColor: "#151412"
	},
	queryLead: {
		gridRow: "span 2",
		display: "flex",
		flexDirection: "column",
		gap: 9,
		paddingRight: 18,
		borderRight: "1px solid #334044",
		color: "#91a0a1",
		fontSize: 12,
		lineHeight: 1.55
	},
	mapInputLabel: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		color: "#aeb7b7",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".1em"
	},
	mapInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #445155",
		backgroundColor: "#0a0e0f",
		color: "#e2e8e4",
		padding: "10px 11px",
		fontFamily: "monospace",
		fontSize: 12,
		outline: { default: "none", ":focus": "1px solid #e1b85e" }
	},
	mapChoices: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: -10 },
	mapChoice: {
		border: "1px solid #3c484c",
		backgroundColor: { default: "transparent", ":hover": "#1b2426" },
		color: "#9ba9ab",
		padding: "5px 7px",
		fontSize: 9,
		letterSpacing: ".07em",
		cursor: "pointer"
	},
	mapChoiceActive: { borderColor: "#e1b85e", color: "#f0d79c", backgroundColor: "#312819" },
	historyModes: {
		display: "flex",
		alignItems: "center",
		gap: 5,
		marginTop: 0,
		color: "#839092",
		fontSize: 9,
		letterSpacing: ".1em"
	},
	historyModeButton: {
		border: "1px solid #39464a",
		backgroundColor: { default: "transparent", ":hover": "#202a2d" },
		color: "#9aa6a8",
		padding: "7px 8px",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".08em",
		cursor: "pointer"
	},
	historyModeButtonActive: {
		borderColor: "#73c7d0",
		backgroundColor: "#153034",
		color: "#b7edf0"
	},
	fastTargetPanel: {
		gridColumn: "1 / -1",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		gap: "8px 12px",
		padding: "9px 10px",
		border: "1px solid #405053",
		backgroundColor: "#0d1516",
		color: "#98a8a8",
		fontSize: 10,
		lineHeight: 1.45
	},
	loadTargetsButton: {
		alignSelf: "start",
		border: "1px solid #73c7d0",
		backgroundColor: { default: "transparent", ":hover": "#17383b", ":disabled": "#172224" },
		color: { default: "#b7edf0", ":disabled": "#647678" },
		padding: "8px 10px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em",
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	fastTargetModes: {
		display: "flex",
		alignItems: "center",
		gap: 5,
		gridColumn: "1 / -1",
		color: "#839092",
		fontSize: 8,
		letterSpacing: ".08em"
	},
	fastTargetMode: {
		border: "1px solid #39464a",
		backgroundColor: { default: "transparent", ":hover": "#202a2d" },
		color: "#9aa6a8",
		padding: "6px 8px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".08em",
		cursor: "pointer"
	},
	fastTargetModeActive: {
		borderColor: "#73c7d0",
		backgroundColor: "#153034",
		color: "#b7edf0"
	},
	targetSearchLabel: {
		display: "grid",
		gridColumn: "1 / -1",
		gap: 5,
		color: "#849596",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em"
	},
	targetSearchInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #405053",
		backgroundColor: "#0a1011",
		color: "#e3edeb",
		padding: "8px 9px",
		fontFamily: "monospace",
		fontSize: 10,
		outline: { default: "none", ":focus": "1px solid #73c7d0" }
	},
	targetList: {
		gridColumn: "1 / -1",
		maxHeight: 260,
		overflowY: "auto",
		listStyle: "none",
		margin: 0,
		padding: 0,
		borderTop: "1px solid #2e3a3c"
	},
	targetRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(130px, .6fr) minmax(180px, 1fr) minmax(180px, 1.3fr)",
		gap: 8,
		border: 0,
		borderBottom: "1px solid #273336",
		backgroundColor: { default: "transparent", ":hover": "#1b282a" },
		color: "#aebcbb",
		padding: "8px 9px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 9,
		"@media (max-width: 720px)": { gridTemplateColumns: "1fr" }
	},
	targetClassRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 8,
		border: 0,
		borderBottom: "1px solid #273336",
		backgroundColor: { default: "transparent", ":hover": "#1b282a" },
		color: "#aebcbb",
		padding: "8px 9px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 9
	},
	targetRowActive: {
		backgroundColor: "#263337",
		color: "#f0f5f1",
		boxShadow: "inset 2px 0 #e1b85e"
	},
	targetRowSmall: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: "#718486",
		fontFamily: "monospace"
	},
	targetEmpty: { gridColumn: "1 / -1", margin: 0, color: "#7f9091" },
	targetError: { gridColumn: "1 / -1", margin: 0, color: "#e9aa97" },
	rangeControls: {
		display: "flex",
		alignItems: "center",
		justifyContent: "flex-end",
		gap: 5,
		color: "#839092",
		fontSize: 9,
		letterSpacing: ".1em"
	},
	rangeButton: {
		border: "1px solid #39464a",
		backgroundColor: { default: "transparent", ":hover": "#202a2d" },
		color: "#9aa6a8",
		padding: "7px 8px",
		fontSize: 9,
		cursor: "pointer"
	},
	rangeButtonActive: { borderColor: "#73c7d0", backgroundColor: "#153034", color: "#b7edf0" },
	runButton: {
		marginLeft: 8,
		border: "1px solid #e1b85e",
		backgroundColor: { default: "#e1b85e", ":hover": "#f1d282", ":disabled": "#5d5131" },
		color: "#16130c",
		padding: "8px 11px",
		fontWeight: 900,
		fontSize: 9,
		letterSpacing: ".12em",
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	advancedButton: {
		border: "1px solid #445356",
		backgroundColor: { default: "transparent", ":hover": "#202b2d", ":disabled": "#171c1d" },
		color: { default: "#a7b7b7", ":disabled": "#647072" },
		padding: "8px 9px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".09em",
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	scanLimits: {
		gridColumn: "1 / -1",
		display: "grid",
		gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
		gap: 9,
		margin: 0,
		padding: "12px 13px 13px",
		border: "1px solid #344447",
		backgroundColor: "#0d1415",
		color: "#94a5a5",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".08em",
		"@media (max-width: 820px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
		"@media (max-width: 480px)": { gridTemplateColumns: "1fr" }
	},
	scanLimitLabel: { display: "grid", gap: 5 },
	scanLimitInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #415155",
		backgroundColor: "#090e0f",
		color: "#d5e1df",
		padding: "7px 8px",
		fontFamily: "monospace",
		fontSize: 10,
		outline: { default: "none", ":focus": "1px solid #73c7d0" }
	},
	centerState: { minHeight: 420, display: "grid", placeItems: "center", color: "#96a2a2" },
	notConfigured: {
		maxWidth: 620,
		margin: "70px auto",
		padding: 28,
		borderLeft: "3px solid #d7b469",
		backgroundColor: "#151a1b",
		color: "#aeb8b9"
	},
	runningState: {
		marginTop: 14,
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		padding: "16px 18px",
		border: "1px solid #39747b",
		backgroundColor: "#0e2023",
		color: "#b7e4e6"
	},
	runningSubprogress: {
		display: "block",
		marginTop: 6,
		color: "#86a9ac",
		fontSize: 9,
		letterSpacing: ".04em"
	},
	cancelButton: {
		border: "1px solid #d77d5d",
		backgroundColor: "transparent",
		color: "#e39a81",
		padding: "7px 9px",
		fontSize: 9,
		letterSpacing: ".11em",
		cursor: "pointer"
	},
	notice: {
		marginTop: 14,
		padding: "12px 14px",
		border: "1px solid #5d5131",
		backgroundColor: "#211d12",
		color: "#d7c184",
		fontSize: 12
	},
	errorState: {
		marginTop: 14,
		padding: 18,
		border: "1px solid #8e564d",
		backgroundColor: "#291919",
		color: "#f1b2a3"
	},
	playbackUnavailable: {
		marginTop: 14,
		padding: 18,
		border: "1px solid #8e564d",
		backgroundColor: "#291919",
		color: "#f1b2a3",
		fontSize: 11,
		lineHeight: 1.5
	},
	staleResult: {
		marginTop: 14,
		padding: "12px 14px",
		border: "1px solid #826d3d",
		backgroundColor: "#211d12",
		color: "#ddca92",
		fontSize: 10,
		lineHeight: 1.5
	},
	fastCoverageNotice: {
		marginTop: 14,
		padding: "13px 14px",
		border: "1px solid #826d3d",
		backgroundColor: "#211d12",
		color: "#ddca92",
		fontSize: 10,
		lineHeight: 1.5
	},
	worldLogTargetLoading: {
		marginTop: 14,
		display: "grid",
		gap: 5,
		padding: "15px 16px",
		border: "1px solid #39747b",
		backgroundColor: "#0e2023",
		color: "#b7e4e6",
		fontSize: 11
	},
	worldLogTargetLoadingCopy: { margin: 0, color: "#86a9ac", fontSize: 10 },
	investigationBar: {
		display: "flex",
		alignItems: "stretch",
		justifyContent: "space-between",
		gap: 12,
		marginTop: 8,
		border: "1px solid #323936",
		backgroundColor: "#151412"
	},
	lensTabs: { display: "flex" },
	lensTab: {
		border: 0,
		borderRight: "1px solid #323936",
		backgroundColor: { default: "transparent", ":hover": "#22201d" },
		color: "#929b97",
		padding: "8px 12px",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 10,
		fontWeight: 600,
		cursor: "pointer"
	},
	lensTabActive: {
		color: "#f1ded3",
		backgroundColor: "#2c201b",
		boxShadow: "inset 0 -2px #e87655"
	},
	investigationFacts: {
		display: "flex",
		alignItems: "center",
		gap: 14,
		padding: "0 10px",
		color: "#7f8985",
		fontSize: 9,
		whiteSpace: "nowrap"
	},
	investigationWarning: { color: "#e0a06e" },
	actorAtlasPath: {
		display: "block",
		maxWidth: "min(70vw, 720px)",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: "#738889",
		fontSize: 9
	},
	actorAtlas: {
		marginTop: 8,
		border: "1px solid #3c4749",
		backgroundColor: "#0f1516",
		boxShadow: "inset 3px 0 #73c7d0"
	},
	actorAtlasHeader: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 18,
		padding: "10px 12px 9px",
		borderBottom: "1px solid #344043"
	},
	snapshotSummary: {
		display: "grid",
		gridTemplateColumns: "auto auto",
		columnGap: 7,
		alignItems: "baseline",
		color: "#87a5a8",
		fontSize: 8,
		letterSpacing: ".1em",
		textAlign: "right"
	},
	playbackFrames: {
		display: "flex",
		gap: 5,
		overflowX: "auto",
		padding: "6px 9px",
		borderBottom: "1px solid #2e3a3c",
		backgroundColor: "#0d1415"
	},
	playbackFrameButton: {
		flexShrink: 0,
		border: "1px solid #38484b",
		backgroundColor: { default: "transparent", ":hover": "#1b292b" },
		color: "#8ea0a1",
		padding: "5px 7px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".08em",
		cursor: "pointer"
	},
	playbackFrameButtonActive: {
		borderColor: "#73c7d0",
		backgroundColor: "#153438",
		color: "#c4eff0"
	},
	frameNotice: {
		padding: "8px 14px",
		borderBottom: "1px solid #2e3a3c",
		backgroundColor: "#152225",
		color: "#a9c7c9",
		fontSize: 9,
		lineHeight: 1.5
	},
	frameNoticePartial: { backgroundColor: "#2b2215", color: "#e2c185" },
	frameNoticeUnclassified: { backgroundColor: "#2b1f14", color: "#e2ad75" },
	snapshotUnavailable: {
		minHeight: 180,
		display: "grid",
		placeItems: "center",
		padding: 24,
		color: "#839193",
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
		borderRight: { default: "1px solid #2e3a3c", "@media (max-width: 720px)": 0 },
		borderBottom: { default: 0, "@media (max-width: 720px)": "1px solid #2e3a3c" },
		backgroundColor: "#11191a"
	},
	actorSearch: {
		display: "grid",
		gap: 6,
		padding: 13,
		color: "#96a6a8",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em"
	},
	actorSearchHelp: {
		color: "#64777a",
		fontSize: 8,
		fontWeight: 500,
		letterSpacing: 0,
		lineHeight: 1.4
	},
	actorSearchInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #405053",
		backgroundColor: "#0a1011",
		color: "#e3edeb",
		padding: "8px 9px",
		fontFamily: "monospace",
		fontSize: 10,
		outline: { default: "none", ":focus": "1px solid #73c7d0" }
	},
	actorFilterBar: {
		display: "flex",
		flexWrap: "wrap",
		gap: 4,
		padding: "0 13px 11px",
		borderBottom: "1px solid #2e3a3c"
	},
	actorFilterButton: {
		border: "1px solid #39484b",
		backgroundColor: { default: "transparent", ":hover": "#1b282a" },
		color: "#869597",
		padding: "4px 5px",
		fontSize: 7,
		fontWeight: 800,
		letterSpacing: ".08em",
		cursor: "pointer"
	},
	actorFilterButtonActive: {
		borderColor: "#73c7d0",
		backgroundColor: "#163438",
		color: "#c2eff0"
	},
	actorFilterSelect: {
		maxWidth: "100%",
		border: "1px solid #3a4b4d",
		backgroundColor: "#10191a",
		color: "#b4c4c4",
		padding: "4px 5px",
		fontFamily: "monospace",
		fontSize: 8
	},
	outlinerCount: {
		display: "flex",
		justifyContent: "space-between",
		gap: 7,
		padding: "0 13px 10px",
		color: "#708185",
		fontSize: 7,
		letterSpacing: ".09em"
	},
	actorList: {
		maxHeight: 340,
		overflowY: "auto",
		listStyle: "none",
		margin: 0,
		padding: 0,
		borderTop: "1px solid #2e3a3c"
	},
	actorListItem: { margin: 0, padding: 0 },
	actorRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "25px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 8,
		border: 0,
		borderBottom: "1px solid #273336",
		borderLeft: "2px solid transparent",
		backgroundColor: { default: "transparent", ":hover": "#1b282a" },
		color: "#b4c0c0",
		padding: "8px 10px",
		textAlign: "left",
		cursor: "pointer"
	},
	actorRowSelected: { borderLeftColor: "#e1b85e", backgroundColor: "#263337", color: "#f0f5f1" },
	actorRowHistorical: { opacity: 0.62 },
	actorEventCount: {
		display: "grid",
		placeItems: "center",
		width: 20,
		height: 20,
		border: "1px solid #416a70",
		color: "#8ad6dc",
		fontSize: 8,
		fontWeight: 800
	},
	actorRowCopy: { display: "grid", minWidth: 0, gap: 2, fontSize: 10 },
	pointMapFrame: {
		position: "relative",
		height: "100%",
		minHeight: 360,
		overflow: "hidden",
		backgroundColor: "#0a1112",
		backgroundImage:
			"radial-gradient(circle at 50% 45%, #2a56542b, transparent 46%), linear-gradient(135deg, #ffffff05 25%, transparent 25%)",
		backgroundSize: "auto, 18px 18px"
	},
	pointMap: { width: "100%", height: "100%", minHeight: 360, display: "block", outline: "none" },
	northMarker: {
		position: "absolute",
		top: 12,
		left: 14,
		zIndex: 2,
		color: "#73c7d0",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".12em"
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
		border: "1px solid #3a4a4c",
		backgroundColor: "#101819df",
		color: "#a8b8b8",
		padding: "5px 7px",
		fontSize: 7,
		letterSpacing: ".08em",
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
		border: "1px solid #806d3c",
		backgroundColor: "#211d12e8",
		color: "#ddca92",
		padding: "5px 7px",
		fontSize: 7,
		letterSpacing: ".08em",
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
		border: "1px solid #445557",
		backgroundColor: { default: "#10191ad9", ":hover": "#1d2d2e" },
		color: "#b5c5c4",
		padding: "5px 8px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em",
		transform: "translateX(-50%)",
		cursor: "pointer"
	},
	noResolvedActors: {
		minHeight: 360,
		display: "grid",
		placeItems: "center",
		padding: 24,
		color: "#819193",
		fontSize: 12,
		textAlign: "center"
	},
	actorInspector: {
		minWidth: 0,
		minHeight: 0,
		height: "100%",
		overflowY: "auto",
		padding: 17,
		borderLeft: { default: "1px solid #2e3a3c", "@media (max-width: 1020px)": 0 },
		borderTop: { default: 0, "@media (max-width: 1020px)": "1px solid #2e3a3c" },
		backgroundColor: "#11191a",
		color: "#c3cfcd",
		"@media (max-width: 1020px)": { gridColumn: "1 / -1" }
	},
	actorInspectorEmpty: {
		minHeight: 180,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		color: "#829193",
		fontSize: 10,
		lineHeight: 1.6
	},
	actorFacts: {
		display: "grid",
		gap: 8,
		margin: "17px 0",
		color: "#a7b7b6",
		fontSize: 9,
		fontFamily: "monospace"
	},
	actorEventSection: { marginTop: 16 },
	actorEventList: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		margin: "7px 0 0",
		padding: 0,
		listStyle: "none",
		color: "#94a5a5",
		fontFamily: "monospace",
		fontSize: 9,
		lineHeight: 1.45
	},
	actorEventButton: {
		width: "100%",
		display: "flex",
		flexDirection: "column",
		gap: 2,
		border: "1px solid #344346",
		backgroundColor: { default: "#10191a", ":hover": "#1c2b2d" },
		color: "#b3c3c2",
		padding: "7px 8px",
		textAlign: "left",
		font: "inherit",
		cursor: "pointer"
	},
	clearActorSelection: {
		width: "100%",
		border: "1px solid #496165",
		backgroundColor: { default: "transparent", ":hover": "#1f2d2f" },
		color: "#a9cdcf",
		padding: "9px 10px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em",
		cursor: "pointer"
	},
	timelineShell: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 340px)",
		gap: 14,
		marginTop: 8,
		"@media (max-width: 900px)": { gridTemplateColumns: "1fr" }
	},
	timeline: { border: "1px solid #3c4749", backgroundColor: "#101617" },
	timelineHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "start",
		padding: "17px 18px 14px",
		borderBottom: "1px solid #374144"
	},
	timelineSubhead: { margin: "5px 0 0", color: "#829193", fontSize: 10, lineHeight: 1.45 },
	completePill: {
		border: "1px solid #619270",
		color: "#a8dcaf",
		padding: "4px 6px",
		fontSize: 8,
		letterSpacing: ".1em",
		textTransform: "uppercase"
	},
	partialPill: { borderColor: "#d59457", color: "#f0c17f" },
	filters: {
		display: "flex",
		gap: 5,
		overflowX: "auto",
		padding: "11px 14px",
		borderBottom: "1px solid #303b3e"
	},
	filterButton: {
		flexShrink: 0,
		border: 0,
		backgroundColor: { default: "transparent", ":hover": "#202a2d" },
		color: "#859394",
		padding: "5px 6px",
		fontSize: 8,
		letterSpacing: ".11em",
		cursor: "pointer"
	},
	filterButtonActive: { color: "#f0d79c", boxShadow: "inset 0 -2px #e1b85e" },
	timelineList: { padding: 14 },
	revision: {
		display: "grid",
		gridTemplateColumns: "72px minmax(0, 1fr)",
		borderBottom: "1px solid #293438",
		paddingBottom: 11,
		marginBottom: 11
	},
	revisionSelected: { marginLeft: -5, paddingLeft: 5, borderLeft: "2px solid #e1b85e" },
	changeMarker: {
		display: "grid",
		alignContent: "start",
		justifyItems: "start",
		gap: 5,
		color: "#738588",
		fontSize: 8,
		letterSpacing: ".1em"
	},
	changeMarkerLabel: {
		display: "flex",
		alignItems: "baseline",
		gap: 4,
		whiteSpace: "nowrap"
	},
	changelistSelect: {
		marginTop: 3,
		border: "1px solid #405154",
		backgroundColor: { default: "transparent", ":hover": "#233033" },
		color: "#9dacac",
		padding: "4px 5px",
		fontSize: 7,
		fontWeight: 800,
		letterSpacing: ".08em",
		cursor: "pointer"
	},
	changelistSelectActive: {
		borderColor: "#e1b85e",
		backgroundColor: "#362d1b",
		color: "#f2dba4"
	},
	revisionBody: { minWidth: 0 },
	revisionHeader: {
		display: "grid",
		gridTemplateColumns: "minmax(180px, .38fr) minmax(0, 1fr)",
		gap: 10,
		marginBottom: 7,
		color: "#9ca9a9",
		fontSize: 10,
		minWidth: 0
	},
	revisionMeta: {
		display: "grid",
		gap: 3,
		minWidth: 0,
		color: "#aebbbb"
	},
	revisionDescription: {
		minWidth: 0,
		margin: 0,
		color: "#9ca9a9",
		lineHeight: 1.35,
		overflowWrap: "anywhere"
	},
	revisionSummary: {
		marginBottom: 8,
		color: "#718286",
		fontSize: 8,
		letterSpacing: ".08em"
	},
	revisionEmpty: { margin: "5px 0", color: "#78888a", fontSize: 9, lineHeight: 1.35 },
	changeRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(92px, .38fr) minmax(120px, .8fr) minmax(0, 1.5fr)",
		gap: 8,
		alignItems: "center",
		border: "1px solid #354145",
		borderLeftWidth: 3,
		backgroundColor: { default: "#141c1e", ":hover": "#1c272a" },
		color: "#a7b2b3",
		padding: "9px 10px",
		marginTop: 5,
		textAlign: "left",
		cursor: "pointer",
		minWidth: 0
	},
	changeRowSelected: { backgroundColor: "#243034", borderColor: "#e1b85e", color: "#e9efec" },
	added: { borderLeftColor: "#6ebd88" },
	removed: { borderLeftColor: "#d77d6a" },
	changed: { borderLeftColor: "#73c7d0" },
	warning: { borderLeftColor: "#e1b85e" },
	changeType: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: "#8ea0a1",
		fontSize: 8,
		letterSpacing: ".08em"
	},
	changeTitle: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontSize: 10
	},
	changeDetail: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: "#7e9091",
		fontSize: 9
	},
	unclassifiedNotice: {
		display: "grid",
		gridTemplateColumns: "1fr auto",
		gap: "4px 8px",
		marginTop: 8,
		padding: "10px 11px",
		border: "1px dashed #a27c45",
		color: "#dfbd7a",
		fontSize: 10
	},
	unclassifiedNoticeCopy: { gridColumn: "1 / -1", margin: 0, lineHeight: 1.35 },
	evidencePanel: {
		alignSelf: "start",
		position: "sticky",
		top: 70,
		border: "1px solid #3b474a",
		backgroundColor: "#111819",
		padding: 18
	},
	evidenceEmpty: {
		minHeight: 180,
		display: "flex",
		alignItems: "center",
		color: "#849294",
		fontSize: 12,
		lineHeight: 1.6
	},
	evidenceKind: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		marginTop: 18,
		padding: "11px 0",
		borderTop: "1px solid #344043",
		borderBottom: "1px solid #344043",
		color: "#d7e0dd",
		fontSize: 12
	},
	evidenceSummary: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		marginTop: 14,
		color: "#9ca9a9",
		fontSize: 10
	},
	packageList: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		margin: "16px 0",
		color: "#96a4a5",
		fontFamily: "monospace",
		fontSize: 10,
		minWidth: 0
	},
	packageEntry: { minWidth: 0 },
	packageAction: { display: "block", color: "#d7b469", fontSize: 8, letterSpacing: ".08em" },
	packagePath: {
		margin: "3px 0 0",
		color: "#96a4a5",
		overflowWrap: "anywhere",
		lineHeight: 1.35
	},
	coverageFooter: {
		display: "flex",
		justifyContent: "space-between",
		paddingTop: 12,
		borderTop: "1px solid #344043",
		color: "#9ba8a9",
		fontSize: 9,
		letterSpacing: ".1em"
	}
});
