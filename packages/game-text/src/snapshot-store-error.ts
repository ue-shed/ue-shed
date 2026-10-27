import { ErrorNextStep } from "@ue-shed/protocol/errors";
import { Schema } from "effect";

/**
 * Classified cache filesystem, lease, native-process or generation failure. retrySafe and
 * nextStep distinguish waiting for another writer from reopening an uncertain session or
 * rebuilding invalid disposable data.
 */
export class SnapshotStoreError extends Schema.TaggedError<SnapshotStoreError>()(
	"SnapshotStoreError",
	{
		retrySafe: Schema.Boolean,
		nextStep: ErrorNextStep,
		operation: Schema.String,
		code: Schema.Literals([
			"unavailable",
			"executable_missing",
			"busy",
			"missing",
			"invalid_input",
			"invalid_cache",
			"stale_generation",
			"resource_limit",
			"invalid_response",
			"io_error",
			"timeout",
			"native_failed"
		]),
		message: Schema.String,
		recovery: Schema.String,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}
/** Tag guard for snapshot store failures; match by tag, not `instanceof`. */
export const isSnapshotStoreError = Schema.is(SnapshotStoreError);
