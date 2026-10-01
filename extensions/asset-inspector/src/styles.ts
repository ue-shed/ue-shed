import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";

export const styles = stylex.create({
	main: {
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		lineHeight: 1.6,
		margin: "0 auto",
		maxWidth: 1400,
		minWidth: 0,
		padding: { default: "28px 32px", "@media (max-width: 899px)": "22px 16px" }
	},
	header: {
		display: "flex",
		flexWrap: "wrap",
		gap: { default: 12, "@media (max-width: 899px)": 4 },
		justifyContent: "space-between"
	},
	title: { color: tokens.colorTextStrong, fontSize: 24, fontWeight: 600, margin: 0 },
	intro: {
		color: tokens.colorTextMuted,
		margin: { default: "6px 0 18px", "@media (max-width: 899px)": "4px 0 0" }
	},
	scopeStamp: {
		color: tokens.colorTextSubtle,
		fontSize: 12,
		margin: { default: "6px 0", "@media (max-width: 899px)": 0 }
	},
	quiet: { color: tokens.colorTextSubtle, fontSize: 12, margin: "6px 0" },
	summary: {
		alignItems: "center",
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		display: "flex",
		flexWrap: "wrap",
		gap: 10,
		margin: "16px 0",
		padding: "10px 12px"
	},
	identity: { flex: "1 1 220px", minWidth: 0 },
	assetTitle: { color: tokens.colorTextStrong, fontSize: 15, fontWeight: 600 },
	stats: { color: tokens.colorTextSubtle, fontSize: 11, overflowWrap: "anywhere" },
	chip: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderRadius: tokens.radiusControl,
		color: tokens.colorAccent,
		fontSize: 12,
		padding: "2px 8px"
	},
	detail: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		borderStyle: "solid",
		borderWidth: 1,
		minWidth: 0,
		overflowWrap: "anywhere",
		padding: 12
	},
	detailHeader: {
		alignItems: "center",
		display: "flex",
		gap: 8,
		marginBottom: 12,
		minWidth: 0
	},
	classChip: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderRadius: tokens.radiusControl,
		color: tokens.colorTextMuted,
		flexShrink: 0,
		fontSize: 11,
		maxWidth: "45%",
		overflow: "hidden",
		padding: "2px 6px",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	truncate: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	exportHeader: {
		alignItems: "center",
		display: "flex",
		flexWrap: "wrap",
		gap: 8,
		justifyContent: "space-between",
		margin: "16px 0 8px"
	},
	exportTitle: { color: tokens.colorTextMuted, fontSize: 12, fontWeight: 500, margin: 0 },
	panes: { display: "grid", gap: 12, minWidth: 0 },
	navigatorPane: { minWidth: 0 },
	withNavigator: {
		gridTemplateColumns: {
			default: "240px minmax(0, 1fr)",
			"@media (max-width: 899px)": "minmax(0, 1fr)"
		}
	},
	navigator: {
		display: { default: "grid", "@media (max-width: 899px)": "none" },
		gridTemplateColumns: "minmax(0, 1fr)",
		alignContent: "start",
		gap: 2,
		maxHeight: "65vh",
		minWidth: 0,
		overflowY: "auto"
	},
	exportButton: {
		alignItems: "center",
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		borderRadius: tokens.radiusControl,
		borderWidth: 0,
		boxSizing: "border-box",
		color: tokens.colorText,
		cursor: "pointer",
		display: "flex",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		gap: 8,
		minWidth: 0,
		padding: "8px 10px",
		textAlign: "left",
		width: "100%"
	},
	selectedExport: { backgroundColor: tokens.colorSurfaceRaised, color: tokens.colorAccent },
	exportIdentity: { flex: "1 1 0", minWidth: 0, overflow: "hidden" },
	exportName: {
		display: "block",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	exportClass: { color: tokens.colorTextSubtle, display: "block", fontSize: 11 },
	count: { color: tokens.colorTextSubtle, fontSize: 11, whiteSpace: "nowrap" },
	countBadge: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderRadius: tokens.radiusControl,
		flexShrink: 0,
		padding: "1px 5px"
	},
	mobileNavigator: {
		display: { default: "none", "@media (max-width: 899px)": "block" },
		marginBottom: 8
	},
	select: {
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		boxSizing: "border-box",
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12,
		minWidth: 0,
		padding: "7px 10px",
		width: "100%"
	},
	mono: { fontFamily: tokens.fontMono, overflowWrap: "anywhere", minWidth: 0 },
	filter: {
		backgroundColor: tokens.colorSurfaceInset,
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		boxSizing: "border-box",
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		maxWidth: "100%",
		minWidth: 0,
		padding: "6px 10px",
		width: { default: 300, "@media (max-width: 599px)": 240 }
	},
	alert: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorAccent,
		borderStyle: "solid",
		borderWidth: 1,
		margin: "16px 0",
		overflowWrap: "anywhere",
		padding: "12px 16px"
	},
	scroll: { maxWidth: "100%", minWidth: 0, overflowX: "auto" },
	table: { borderCollapse: "collapse", fontSize: 12, textAlign: "left", width: "auto" },
	cell: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		maxWidth: 360,
		minWidth: 80,
		overflowWrap: "anywhere",
		padding: "7px 10px",
		verticalAlign: "top"
	},
	scalarCell: { overflowWrap: "normal", whiteSpace: "nowrap" },
	textCell: { minWidth: 220, overflowWrap: "anywhere", whiteSpace: "normal" },
	property: {
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		minWidth: 0,
		overflowWrap: "anywhere",
		padding: "6px 0"
	},
	propertyRow: {
		alignItems: "baseline",
		display: "grid",
		gap: 12,
		gridTemplateColumns: {
			default: "minmax(180px, 30%) minmax(0, 1fr)",
			"@media (max-width: 899px)": "minmax(0, 40%) minmax(0, 1fr)"
		},
		minWidth: 0
	},
	propertyLabel: {
		alignItems: "baseline",
		display: "flex",
		flexWrap: "wrap",
		gap: 6,
		minWidth: 0
	},
	propertyName: {
		fontWeight: 500,
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	typeTag: { color: tokens.colorTextSubtle, fontSize: 10, fontWeight: 400 },
	referenceName: { color: tokens.colorTextStrong, fontWeight: 500 },
	cellValue: { minWidth: 0, overflowWrap: "anywhere" },
	cellHeading: { alignItems: "baseline", display: "flex", gap: 6, minWidth: 0 },
	propertySummary: {
		cursor: "pointer",
		display: "block",
		listStyle: "none",
		overflowWrap: "anywhere"
	},
	value: {
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		minWidth: 0,
		overflowWrap: "anywhere"
	},
	children: {
		borderLeftWidth: 1,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorBorder,
		margin: "4px 0 0 4px",
		paddingLeft: 12
	},
	childrenFlat: { marginLeft: 0, paddingLeft: 0 },
	viewAction: {
		alignItems: "center",
		backgroundColor: { default: tokens.colorAccent, ":hover": tokens.colorAccentStrong },
		borderRadius: tokens.radiusControl,
		boxSizing: "border-box",
		color: tokens.colorAccentText,
		display: "inline-flex",
		fontSize: 12,
		fontWeight: 600,
		gap: 8,
		maxWidth: "100%",
		overflowWrap: "anywhere",
		padding: "8px 12px",
		textDecoration: "none"
	},
	packageDetails: { display: "flex", flexWrap: "wrap", gap: 20, marginTop: 16, minWidth: 0 },
	disclosure: { color: tokens.colorTextSubtle, fontSize: 12, maxWidth: "100%", minWidth: 0 }
});
