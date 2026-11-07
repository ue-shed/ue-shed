import { Schema } from "effect";
import { snapshotCheck } from "./snapshot-format.js";
export const JoinedSourcePatch = Schema.Struct({
    rows: Schema.String,
    starts: Schema.String,
    values: Schema.String
});
export const JoinedSourcePatches = Schema.Struct({
    raw: Schema.optionalKey(JoinedSourcePatch),
    slice: Schema.optionalKey(JoinedSourcePatch)
});
export function sourcePatchKind(name, patches) {
    for (const kind of ["raw", "slice"])
        if (patches?.[kind] &&
            ["sources", "source_start", "source_end"].some((field) => name === `query.${kind}.${field}`))
            return kind;
    return undefined;
}
/** Replace bounded row lists while retaining the full join's packed logical columns. */
export function spliceJoinedSources(starts, ends, sources, rows, patchStarts, values) {
    const operation = "join.source-patch";
    snapshotCheck(starts.length === ends.length &&
        rows.length <= 8192 &&
        values.length <= 8192 &&
        patchStarts.length === rows.length + 1 &&
        patchStarts[0] === 0 &&
        patchStarts[rows.length] === values.length, operation, "Invalid source patch lengths");
    let length = sources.length;
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        snapshotCheck(row < starts.length &&
            (index === 0 || row > rows[index - 1]) &&
            ends[row] >= starts[row] &&
            ends[row] <= sources.length &&
            patchStarts[index + 1] > patchStarts[index] &&
            patchStarts[index + 1] <= values.length, operation, "Invalid source patch row");
        length += patchStarts[index + 1] - patchStarts[index] - (ends[row] - starts[row]);
    }
    snapshotCheck(Number.isSafeInteger(length) && length >= 0 && length <= 0xffffffff, operation, "Source arena exceeds u32 range");
    const result = {
        source_start: new Uint32Array(starts.length),
        source_end: new Uint32Array(ends.length),
        sources: new Uint32Array(length)
    };
    let originalPosition = 0, copyStart = 0, delta = 0, patch = 0;
    for (let row = 0; row < starts.length; row++) {
        snapshotCheck(starts[row] === originalPosition &&
            ends[row] >= originalPosition &&
            ends[row] <= sources.length, operation, "Invalid base source ranges");
        result.source_start[row] = starts[row] + delta;
        if (rows[patch] === row) {
            // Copy each unchanged run once; do not allocate a typed view per query row.
            result.sources.set(sources.subarray(copyStart, starts[row]), copyStart + delta);
            const selected = values.subarray(patchStarts[patch], patchStarts[patch + 1]);
            result.sources.set(selected, starts[row] + delta);
            delta += selected.length - (ends[row] - starts[row]);
            copyStart = ends[row];
            patch++;
        }
        result.source_end[row] = ends[row] + delta;
        originalPosition = ends[row];
    }
    result.sources.set(sources.subarray(copyStart), copyStart + delta);
    snapshotCheck(originalPosition === sources.length && sources.length + delta === length, operation, "Source ranges do not exhaust arena");
    return result;
}
