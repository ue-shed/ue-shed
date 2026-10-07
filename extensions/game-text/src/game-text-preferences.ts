import { Effect, Option, Schema } from "effect";
import {
	TextCapabilityFilter,
	TextReviewLens,
	TextUnitId,
	TextQualityFindingId,
	TextQualityFilter,
	TextQualityRuleDocument
} from "@ue-shed/game-text/browser";
import type { RuleEditorState } from "./game-text-rule-state.js";

const StoredPreferences = Schema.Struct({
	query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
	capability: Schema.optionalKey(TextCapabilityFilter),
	lens: Schema.optionalKey(TextReviewLens),
	withoutNotes: Schema.optionalKey(Schema.Boolean),
	mode: Schema.optionalKey(Schema.Literals(["corpus", "quality"])),
	qualityFilter: Schema.optionalKey(TextQualityFilter),
	selectedId: Schema.optionalKey(TextUnitId),
	selectedFindingId: Schema.optionalKey(TextQualityFindingId),
	qualityDocument: Schema.optionalKey(TextQualityRuleDocument)
});

export interface GameTextPreferences {
	readonly query: string;
	readonly capability: Schema.Schema.Type<typeof TextCapabilityFilter>;
	readonly lens: Schema.Schema.Type<typeof TextReviewLens>;
	readonly withoutNotes?: boolean;
	readonly mode?: "corpus" | "quality";
	readonly qualityFilter?: Schema.Schema.Type<typeof TextQualityFilter>;
	readonly selectedId: Schema.Schema.Type<typeof TextUnitId> | undefined;
	readonly selectedFindingId?: Schema.Schema.Type<typeof TextQualityFindingId> | undefined;
	readonly qualityDocument?: Schema.Schema.Type<typeof TextQualityRuleDocument> | undefined;
	readonly qualityEditor?: RuleEditorState | undefined;
}

const decodeStoredPreferences = Schema.decodeUnknownOption(
	Schema.fromJsonString(StoredPreferences)
);

export function decodeGameTextPreferences(contents: string): GameTextPreferences {
	const decoded = decodeStoredPreferences(contents.length <= 1_048_576 ? contents : "{}");
	const value: Schema.Schema.Type<typeof StoredPreferences> = Option.isSome(decoded)
		? decoded.value
		: {};
	return {
		...value,
		query: value.query ?? "",
		capability: value.capability ?? "all",
		lens: value.lens ?? "all",
		withoutNotes: value.withoutNotes ?? false,
		selectedId: value.selectedId
	};
}

export const readGameTextPreferences = Effect.fn("GameText.preferences.read")((key: string) =>
	Effect.try({
		try: () => {
			const contents = window.localStorage.getItem("ue-shed:game-text:" + key) ?? "{}";
			return decodeGameTextPreferences(contents);
		},
		catch: () => undefined
	}).pipe(Effect.catch(() => Effect.succeed(decodeGameTextPreferences("{}"))))
);

export const saveGameTextPreferences = Effect.fn("GameText.preferences.save")(
	(key: string, preferences: GameTextPreferences) =>
		Effect.try({
			try: () => {
				const { qualityEditor: _editor, ...stored } = preferences;
				window.localStorage.setItem("ue-shed:game-text:" + key, JSON.stringify(stored));
			},
			catch: () => undefined
		}).pipe(Effect.catch(() => Effect.void))
);
