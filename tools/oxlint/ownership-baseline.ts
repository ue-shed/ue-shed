/**
 * Files that broke the ownership rules when they were introduced. In these files each rule only
 * warns. Move the state onto the Effect primitive that owns it when you work in one (the rule's
 * message says which), then remove the file from its list. Never add a file here.
 */
export const ownershipBaseline = {
	"anti-slop/no-check-yield-write": [
		"apps/cli/src/commands/camera-authoring.ts",
		"apps/workbench/src/main/services/camera-workspace.ts",
		"apps/workbench/src/main/services/content-observatory.ts",
		"extensions/game-text/src/game-text-group-pages.ts",
		"packages/cameras/src/camera-setup-host.ts",
		"packages/game-text/src/disk-changes.ts",
		"packages/game-text/src/index-retained.ts",
		"packages/game-text/src/workspace-localization.ts",
		"packages/game-text/src/workspace-operations.ts",
		"packages/game-text/src/workspace.ts",
		"packages/map-history/src/historical-project-tree.ts"
	],
	"anti-slop/no-shared-let-in-effect": [
		"apps/workbench/src/main/services/map-review.ts",
		"packages/cameras/src/index.ts",
		"packages/cameras/src/map-tile-capture.ts",
		"packages/game-text/src/native-index-builder.ts",
		"packages/game-text/src/shared-index.ts",
		"packages/game-text/src/snapshot-store.ts",
		"packages/localization/src/operations.ts",
		"packages/observatory/src/actor-feed.ts",
		"scripts/test-game-text-packaged-journey.ts"
	],
	"anti-slop/no-unguarded-owner-clear": [
		"packages/game-text/src/workspace-operations.ts",
		"scripts/benchmark-game-text-engine.ts"
	]
} as const;
