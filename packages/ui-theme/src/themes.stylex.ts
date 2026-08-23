import * as stylex from "@stylexjs/stylex";
import { tokens } from "./tokens.stylex.js";

export const ueShedDarkTheme = stylex.createTheme(tokens, {
	colorCanvas: "#08090a",
	colorCanvasTranslucent: "#08090ae6",
	colorSurface: "#0f1011",
	colorSurfaceRaised: "#161718",
	colorSurfaceHover: "#1a1b1e",
	colorSurfaceInset: "#0c0d0e",
	colorBorder: "#23252a",
	colorBorderStrong: "#383b3f",
	colorBorderInteractive: "#383b3f",
	colorText: "#d0d6e0",
	colorTextStrong: "#f7f8f8",
	colorTextMuted: "#8a8f98",
	colorTextSubtle: "#858a93",
	colorTextFaint: "#80858e",
	colorAccent: "#e4f222",
	colorAccentStrong: "#f0fa54",
	colorAccentText: "#08090a",
	colorAccentWash: "rgba(228, 242, 34, 0.09)",
	colorSuccess: "#4cb782",
	colorWarning: "#f2994a",
	colorWarningStrong: "#e08a3c",
	colorDanger: "#eb5757",
	fontBody:
		'"Inter", "Inter Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
	fontDisplay:
		'"Inter", "Inter Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
	fontMono:
		'"Berkeley Mono", ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace',
	radiusControl: "6px",
	radiusPanel: "12px",
	radiusBadge: "4px",
	radiusPill: "999px",
	space1: "4px",
	space2: "8px",
	space3: "12px",
	space4: "16px",
	space5: "24px",
	space6: "32px",
	motionFast: "120ms",
	motionStandard: "180ms",
	motionEaseOut: "cubic-bezier(0.23, 1, 0.32, 1)",
	shadowOverlay: "0 16px 40px rgba(8, 9, 10, 0.7), 0 4px 12px rgba(8, 9, 10, 0.5)",
	shadowCard: "rgba(35, 37, 42, 0.6) 0 0 0 1px inset"
});

// Compatibility alias for existing Workbench consumers. New hosts should use the product-level name.
export const workbenchDarkTheme = ueShedDarkTheme;
