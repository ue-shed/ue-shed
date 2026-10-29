import { Schema } from "effect";
import { MAX_CHANGE_PAGE } from "./change-comparison.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const LocalizationFileFormat = Schema.Literals(["po", "archive", "manifest"]);
export type LocalizationFileFormat = typeof LocalizationFileFormat.Type;

/** A file's format from its extension; none for a file that is not one of them. */
export function localizationFileFormat(path: string): LocalizationFileFormat | undefined {
	const extension = /\.([^./\\]+)$/u.exec(path)?.[1]?.toLowerCase();
	return extension === "po" || extension === "archive" || extension === "manifest"
		? extension
		: undefined;
}

/** Two files compared: the older and the newer. A side is absent for a file added or deleted. */
export const LocalizationFilePair = Schema.Struct({
	before: Schema.optionalKey(Schema.String),
	after: Schema.optionalKey(Schema.String)
});
export type LocalizationFilePair = typeof LocalizationFilePair.Type;

/**
 * `compareLocalizationFiles`: the files, or none to have the person choose them, and a page. A
 * later page names the files the first answer returned.
 */
export const LocalizationFileComparisonRequest = Schema.Struct({
	files: Schema.optionalKey(LocalizationFilePair),
	changes: Schema.Struct({
		offset: Count,
		limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHANGE_PAGE }))
	})
});
export type LocalizationFileComparisonRequest = typeof LocalizationFileComparisonRequest.Type;

const FileKey = Schema.Struct({ namespace: Schema.String, key: Schema.String });

/** One field of a changed entry, on each side that has it. */
export const LocalizationFileField = Schema.Struct({
	name: Schema.Literals([
		"source",
		"source_plural",
		"translation",
		"path",
		"notes",
		"comments",
		"references",
		"flags"
	]),
	/** A PO translation's plural form. */
	form: Schema.optionalKey(Count),
	before: Schema.optionalKey(Schema.String),
	after: Schema.optionalKey(Schema.String)
});
export type LocalizationFileField = typeof LocalizationFileField.Type;

/** One entry that differs: added, removed, moved to a new key, or edited. */
export const LocalizationFileChange = Schema.Struct({
	kind: Schema.Literals(["added", "removed", "rekeyed", "edited"]),
	before: Schema.optionalKey(FileKey),
	after: Schema.optionalKey(FileKey),
	/** Every field the entry has on either side, the source first. */
	fields: Schema.Array(LocalizationFileField)
});
export type LocalizationFileChange = typeof LocalizationFileChange.Type;

/**
 * `compareLocalizationFiles`: the files compared, whole counts and the requested page of changes;
 * `cancelled` when the person chose no file; `failed` with the reason.
 */
export const LocalizationFileComparisonResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		code: Schema.String,
		message: Schema.String,
		recovery: Schema.String
	}),
	Schema.Struct({
		status: Schema.Literal("ready"),
		files: LocalizationFilePair,
		format: LocalizationFileFormat,
		counts: Schema.Struct({
			added: Count,
			removed: Count,
			rekeyed: Count,
			edited: Count,
			unchanged: Count
		}),
		/** Changes in all, of which `changes` is the requested page. */
		total: Count,
		changes: Schema.Array(LocalizationFileChange).check(Schema.isMaxLength(MAX_CHANGE_PAGE))
	})
]);
export type LocalizationFileComparisonResult = typeof LocalizationFileComparisonResult.Type;
