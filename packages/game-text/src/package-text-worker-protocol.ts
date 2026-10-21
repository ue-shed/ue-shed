import { Schema } from "effect";
import { PreparedColdStrings } from "./shared-string-sort.js";
import { SnapshotFormatError } from "./snapshot-format.js";
import { SnapshotStoreError } from "./snapshot-store.js";

/** Private worker messages preserve classified failures across the structured-clone boundary. */
export const PackageTextWorkerReply = Schema.Union([
	/** A staging group's shards, in request order. Before the single-shard reply it extends. */
	Schema.Struct({
		ok: Schema.Literal(true),
		shards: Schema.Array(
			Schema.Struct({
				name: Schema.String,
				preparedStrings: Schema.optional(PreparedColdStrings)
			})
		)
	}),
	Schema.Struct({
		ok: Schema.Literal(true),
		preparedStrings: Schema.optional(PreparedColdStrings)
	}),
	Schema.Struct({
		ok: Schema.Literal(false),
		error: Schema.Union([SnapshotFormatError, SnapshotStoreError])
	})
]);
