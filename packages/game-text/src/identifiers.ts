import { Schema } from "effect";

/**
 * Opaque identity of a grouped text unit. Keep it with the corpus generation that produced it;
 * it is distinct from Unreal's namespace/key identity.
 */
export const TextUnitId = Schema.String.pipe(Schema.brand("TextUnitId"));
export type TextUnitId = typeof TextUnitId.Type;
/**
 * Opaque identity of one saved text place. It identifies an occurrence for focus and
 * pagination, not a filesystem path or an Unreal text key.
 */
export const TextOccurrenceId = Schema.String.pipe(Schema.brand("TextOccurrenceId"));
export type TextOccurrenceId = typeof TextOccurrenceId.Type;
/**
 * Brands an already constructed unit identifier. This constructor does not resolve an Unreal
 * namespace/key or look up a corpus generation.
 */
export const makeTextUnitId = TextUnitId.make;
/**
 * Brands an already constructed occurrence identifier. Callers constructing IDs remain
 * responsible for using the corpus identity convention.
 */
export const makeTextOccurrenceId = TextOccurrenceId.make;
