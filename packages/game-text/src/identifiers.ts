import { Schema } from "effect";

export const TextUnitId = Schema.String.pipe(Schema.brand("TextUnitId"));
export type TextUnitId = typeof TextUnitId.Type;
export const TextOccurrenceId = Schema.String.pipe(Schema.brand("TextOccurrenceId"));
export type TextOccurrenceId = typeof TextOccurrenceId.Type;
export const makeTextUnitId = TextUnitId.make;
export const makeTextOccurrenceId = TextOccurrenceId.make;
