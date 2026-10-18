import { Schema } from "effect";
import type { PackedStrings } from "./shared-string-codec.js";

export const maximumSourceCacheBytes = 96 * 1024 ** 2;
const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const JoinedSourceCacheMeta = Schema.Struct({
	version: Schema.Literal(1),
	count: Natural.check(Schema.isLessThanOrEqualTo(0xffffffff / 4 - 1)),
	bytes: Natural.check(Schema.isLessThanOrEqualTo(maximumSourceCacheBytes)),
	trigramVersion: Schema.optionalKey(Schema.Literal(1)),
	flagsVersion: Schema.optionalKey(Schema.Literal(1))
});
export interface JoinedSourceCacheMeta extends Schema.Schema.Type<typeof JoinedSourceCacheMeta> {}
export interface JoinedSourceCache {
	readonly packed: PackedStrings;
	readonly index: Uint32Array;
	readonly ids: Uint32Array;
	readonly simple: Uint8Array;
	readonly trigrams?: Uint8Array;
}
