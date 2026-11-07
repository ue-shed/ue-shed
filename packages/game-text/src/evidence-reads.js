import { Effect } from "effect";
/**
 * Index-backed evidence files decode their entries on every read of `value`, synchronously, which
 * holds the event loop for as long as a whole archive takes to decode. An index registers here a
 * read of the same value that yields between pages, so callers that may wait can read without
 * blocking other work.
 */
const reads = new WeakMap();
/** Registers the yielding read of an evidence file whose `value` decodes synchronously. */
export function registerEvidenceRead(file, read) {
    reads.set(file, read);
}
/** The file's value, read without blocking when its source registered a yielding read. */
export function readEvidenceValue(file) {
    const read = reads.get(file);
    // SAFETY: `registerEvidenceRead` stores only reads of the file's own value type.
    // Verified by: index-reads.test.ts "answers aggregates, line fields, the header and
    // fingerprint, and the reports built on them", whose indexed report (these reads) equals the
    // whole-input report (each file's `value`).
    return read === undefined ? Effect.sync(() => file.value) : read;
}
