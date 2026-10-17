import { Schema } from "effect";
import { PreparedColdStrings } from "./shared-string-sort.js";
import { SnapshotFormatError } from "./snapshot-format.js";
import { SnapshotStoreError } from "./snapshot-store.js";

/** Private worker messages preserve classified failures across the structured-clone boundary. */
export const PackageTextWorkerReply = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), preparedStrings: PreparedColdStrings }),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([SnapshotFormatError, SnapshotStoreError])
	})
]);
