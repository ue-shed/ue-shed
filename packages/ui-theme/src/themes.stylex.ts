import * as stylex from "@stylexjs/stylex";
import { tokens } from "./tokens.stylex.js";

export const ueShedDarkTheme = stylex.createTheme(tokens, {
	colorCanvas: "#0b0d0d",
	colorCanvasTranslucent: "#0b0d0df2",
	colorSurface: "#111412",
	colorSurfaceRaised: "#171b18",
	colorSurfaceHover: "#202720",
	colorSurfaceInset: "#090b0a",
	colorBorder: "#303632",
	colorBorderStrong: "#39403b",
	colorBorderInteractive: "#39413b",
	colorText: "#e8ebe5",
	colorTextStrong: "#eef0e9",
	colorTextMuted: "#89938c",
	colorTextSubtle: "#7f8982",
	colorTextFaint: "#59615b",
	colorAccent: "#b7e26d",
	colorAccentStrong: "#b9f227",
	colorAccentText: "#10140d",
	colorSuccess: "#91c976",
	colorWarning: "#d6a363",
	colorWarningStrong: "#d7894a",
	colorDanger: "#d16b5e",
	fontBody: '"Cascadia Mono", Consolas, monospace',
	fontDisplay: "Georgia, serif",
	radiusControl: "2px",
	radiusPanel: "2px",
	space1: "4px",
	space2: "8px",
	space3: "12px",
	space4: "16px",
	space5: "24px",
	space6: "32px",
	motionFast: "120ms",
	motionStandard: "180ms"
});

// Compatibility alias for existing Workbench consumers. New hosts should use the product-level name.
export const workbenchDarkTheme = ueShedDarkTheme;
