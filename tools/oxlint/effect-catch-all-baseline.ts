/**
 * Files that had Effect catch-all recovery when `anti-slop/no-effect-catch-all` was introduced.
 * The rule only warns in these files. Convert their catch-alls to tag-by-tag translation (see
 * docs/engineering/types-and-errors.md) when you work in one, then remove it from this list. Never add
 * a file here; disable the rule on the line, with a reason, at a deliberate boundary instead.
 */
export const effectCatchAllBaseline = [
	"apps/workbench/src/main/services/editor-responsiveness.ts",
	"apps/workbench/src/main/services/map-capture.ts",
	"apps/workbench/src/main/services/map-review.ts",
	"apps/workbench/src/main/services/niagara-preview.ts",
	"extensions/game-text/src/game-text-preferences.ts",
	"packages/authoring/src/session-service.ts",
	"packages/cameras/src/camera-render.ts",
	"packages/cameras/src/camera-setup-host.ts",
	"packages/cameras/src/map-tile-capture.ts",
	"packages/cameras/src/review-capture.ts",
	"packages/game-text/src/native-index-builder.ts",
	"packages/game-text/src/workspace-id-repairs.ts",
	"packages/game-text/src/workspace-investigation.ts",
	"packages/game-text/src/workspace-localization.ts",
	"packages/game-text/src/workspace.ts",
	"packages/world/src/preparation.ts"
];
