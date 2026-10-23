import type { SnapshotStoreError } from "./snapshot-store-error.js";
import type { SnapshotFormatError } from "./snapshot-format.js";
import type { GameTextIndexError } from "./index-error.js";

/** Failures returned by reads of a pinned Game Text snapshot. */
export type IndexFailure = SnapshotStoreError | SnapshotFormatError | GameTextIndexError;
