import { ContractParseError } from "@ue-shed/protocol";
import { Predicate, Schema } from "effect";

function hasCode(cause: unknown, ...codes: ReadonlyArray<string>): boolean {
	return (
		cause instanceof Object &&
		"code" in cause &&
		Predicate.isString(cause.code) &&
		codes.includes(cause.code)
	);
}

/** The file or its directory does not exist. */
export const isMissingFile = (cause: unknown): boolean => hasCode(cause, "ENOENT", "ENOTDIR");

/** The document was read but is not JSON or does not match its schema; retrying cannot help. */
export const isMalformedDocument = (cause: unknown): boolean =>
	cause instanceof SyntaxError ||
	Schema.isSchemaError(cause) ||
	Schema.is(ContractParseError)(cause);

/**
 * Why a file read, write or parse failed, classified from the platform error code so a message can
 * say what went wrong without repeating the raw cause text. Completes "... because <reason>".
 */
export function fileFailureReason(cause: unknown): string {
	if (cause instanceof SyntaxError) return "it is not valid JSON";
	if (Schema.isSchemaError(cause) || Schema.is(ContractParseError)(cause))
		return "it does not match its schema";
	if (hasCode(cause, "ENOENT", "ENOTDIR")) return "it or its directory does not exist";
	if (hasCode(cause, "EACCES", "EPERM")) return "access was denied";
	if (hasCode(cause, "EEXIST")) return "it already exists";
	if (hasCode(cause, "EBUSY")) return "it is in use";
	if (hasCode(cause, "ENOSPC")) return "the disk is full";
	return "of an unexpected file-system error";
}
