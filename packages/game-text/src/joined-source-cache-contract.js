import { Schema } from "effect";
export const maximumSourceCacheBytes = 96 * 1024 ** 2;
const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const JoinedSourceCacheMeta = Schema.Struct({
    version: Schema.Literal(1),
    count: Natural.check(Schema.isLessThanOrEqualTo(0xffffffff / 4 - 1)),
    bytes: Natural.check(Schema.isLessThanOrEqualTo(maximumSourceCacheBytes)),
    trigramVersion: Schema.optionalKey(Schema.Literal(1)),
    flagsVersion: Schema.optionalKey(Schema.Literal(1))
});
