import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";

export const styles = stylex.create({
	searchWrap: {
		position: "relative",
		zIndex: 3,
		flex: "1 1 260px",
		minWidth: 200,
		maxWidth: 420
	},
	searchField: { position: "relative", display: "block" },
	searchInput: {
		boxSizing: "border-box",
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
		width: { default: "max(100%, 460px)", "@media (max-width: 899px)": "100%" },
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
		width: "100%",
		marginTop: 16,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	browserHeader: {
		flexWrap: "wrap",
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
		backgroundColor: tokens.colorSurfaceRaised,
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
	}
});
