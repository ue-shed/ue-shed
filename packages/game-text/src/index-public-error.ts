import { Schema } from "effect";
import { AssetReaderError } from "@ue-shed/unreal-assets";
import { TextCorpusScanError } from "./corpus.js";
import { isGameTextIndexError, type IndexFailure } from "./index-contract.js";
import type { TextCorpusPublicError } from "./schema.js";

const isCorpusScanError = Schema.is(TextCorpusScanError);
const isReaderError = Schema.is(AssetReaderError);

/** Preserve classified scan/reader failures; other preparation failures belong to the index. */
export function indexPublicFailure(error: IndexFailure): TextCorpusPublicError {
	const cause = isGameTextIndexError(error) ? error.cause : undefined;
	const source =
		isCorpusScanError(cause) ||
		(isGameTextIndexError(error) &&
			error.operation === "reader_failure" &&
			isReaderError(cause))
			? cause
			: error;
	const code = isCorpusScanError(source)
		? source.code
		: isReaderError(source)
			? source.kind === "discovery"
				? "invalid_project"
				: source.kind === "resource_limit"
					? "scan_limit_exceeded"
					: "reader_failed"
			: isGameTextIndexError(error) && error.operation === "reader_failure"
				? "reader_failed"
				: "index_failed";
	return {
		code,
		message: source.message,
		recovery: source.recovery,
		retrySafe: source.retrySafe
	};
}
