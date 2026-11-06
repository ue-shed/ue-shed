import type { GameTextContract } from "../../../../packages/protocol/dist/index.js";
import { GameTextIndexConfiguration } from "../../../../packages/protocol/dist/index.js";
import { Schema } from "effect";
import { TextCorpusHeader } from "../../../../packages/game-text/src/index-reads.ts";
import {
	TextUnit,
	TextUnitSearchResult as UnitPreview
} from "../../../../packages/game-text/src/schema.ts";
import {
	LocalizationLine as Line,
	LocalizationLinePreview as LinePreview,
	LocalizationLineId
} from "../../../../packages/game-text/src/localization-schema.ts";
import { localizationLineFieldSchemas } from "../../../../packages/game-text/src/index-reads.ts";
import type {
	TextCorpus,
	TextUnitSearchResult
} from "../../../../packages/game-text/src/schema.ts";
import type {
	LocalizationLine,
	LocalizationLinePreview
} from "../../../../packages/game-text/src/localization-schema.ts";

export type Json = GameTextContract.JsonValue;
export type View = typeof LineRecordCodec.Type.view;
export interface RetainedInput {
	readonly settings: {
		readonly configuration: GameTextIndexConfiguration;
		readonly generation: string;
		readonly joinedKey: string;
	};
	readonly scale: number;
	readonly target: string;
	readonly nativeCulture: string | null;
	readonly cultures: readonly string[];
	readonly corpus: Omit<TextCorpus, "units">;
}
export const RetainedInputCodec = Schema.Struct({
	settings: Schema.Struct({
		configuration: GameTextIndexConfiguration,
		generation: Schema.String,
		joinedKey: Schema.String
	}),
	scale: Schema.Number,
	target: Schema.String,
	nativeCulture: Schema.NullOr(Schema.String),
	cultures: Schema.Array(Schema.String),
	corpus: TextCorpusHeader
});
export interface UnitRecord {
	readonly unit: TextCorpus["units"][number];
	readonly preview: TextUnitSearchResult | null;
}
export interface LineRecord {
	readonly line: LocalizationLine;
	readonly view: View;
	readonly preview: LocalizationLinePreview;
	readonly unitPreview?: TextUnitSearchResult;
}

/** Trusted objects from our own generated engine contract, after its process handshake. */
export const UnitRecordCodec = Schema.Struct({
	unit: TextUnit,
	preview: Schema.NullOr(UnitPreview)
});
export const LineRecordCodec = Schema.Struct({
	line: Line,
	view: Schema.Struct({ id: LocalizationLineId, ...localizationLineFieldSchemas }),
	preview: LinePreview,
	unitPreview: Schema.optionalKey(UnitPreview)
});

export const json = <A>(value: A): Json => {
	// SAFETY: callers pass domain values or SQLite reconstruction of those values; no external input.
	// Verified by: full/conformance.checks.ts compares recursive round trips and native complete answers.
	return value as Json;
};
