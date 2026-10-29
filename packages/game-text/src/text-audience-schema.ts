import { Schema } from "effect";

/**
 * Who a piece of saved text is for. `player` text ships to players and needs writers and
 * localizers; `editor` text is Unreal editor text (tooltips, categories, graph nodes) or developer
 * content; `unknown` has no evidence either way.
 */
export const TextAudience = Schema.Literals(["player", "editor", "unknown"]);
export type TextAudience = typeof TextAudience.Type;

/** Why an occurrence has its audience, from the strongest evidence that applied. */
export const TextAudienceReason = Schema.Literals([
	// Unreal's saved gather table marked the text editor-only, or runtime.
	"gather_table_editor_only",
	"gather_table_runtime",
	// The fallback policy table in text-audience.ts.
	"developer_folder",
	"editor_namespace",
	"editor_object",
	"editor_property",
	"player_asset",
	"no_evidence",
	// The code scan found the text inside `#if WITH_EDITOR` or `#if WITH_EDITORONLY_DATA`.
	// Appended: a reason's position is its stored code.
	"code_editor_only"
]);
export type TextAudienceReason = typeof TextAudienceReason.Type;

/**
 * Why a selected target's gather would not collect a line: every saved place is outside the
 * target's include and exclude paths, or the text is editor text and the target does not gather
 * editor-only data (`ShouldGatherFromEditorOnlyData`).
 */
export const TextOutOfScopeReason = Schema.Literals([
	"outside_gather_paths",
	"editor_only_data_not_gathered"
]);
export type TextOutOfScopeReason = typeof TextOutOfScopeReason.Type;

/** The audience labels writers see. */
export const TEXT_AUDIENCE_LABELS = {
	player: "Player text",
	editor: "Editor text",
	unknown: "Unknown"
} as const satisfies Record<TextAudience, string>;
