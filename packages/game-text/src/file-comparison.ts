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
 * What a change means for the text and its translations, in the order changes are listed:
 * - `rekeyed`: the text moved to a new key, so translations made for the old key no longer apply;
 * - `source`: the source changed, so a translation made for the old source is out of date;
 * - `removed`, `added`;
 * - `translation`: a translation, translator comment or flag changed, and the source did not;
 * - `context`: only notes, references or a manifest path changed.
 */
export const LocalizationFileGroup = Schema.Literals([
	"rekeyed",
	"source",
	"removed",
	"added",
	"translation",
	"context"
]);
export type LocalizationFileGroup = typeof LocalizationFileGroup.Type;

/** `chooseLocalizationFile`: which side the person is choosing a file for. */
export const LocalizationFileChoiceRequest = Schema.Struct({
	side: Schema.Literals(["before", "after"])
});
export type LocalizationFileChoiceRequest = typeof LocalizationFileChoiceRequest.Type;

export const LocalizationFileChoiceResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		code: Schema.String,
		message: Schema.String,
		recovery: Schema.String
	}),
	Schema.Struct({
		status: Schema.Literal("selected"),
		path: Schema.String,
		format: LocalizationFileFormat
	})
]);
export type LocalizationFileChoiceResult = typeof LocalizationFileChoiceResult.Type;

/**
 * `compareLocalizationFiles`: two files chosen with `chooseLocalizationFile`, which changes to
 * list, and a page of them.
 */
export const LocalizationFileComparisonRequest = Schema.Struct({
	files: LocalizationFilePair,
	/** Only these groups, and only changes holding this text; every change when absent. */
	filter: Schema.optionalKey(
		Schema.Struct({
			groups: Schema.Array(LocalizationFileGroup),
			query: Schema.String.check(Schema.isMaxLength(1000))
		})
	),
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

/** One entry that differs, with what that means for its translations. */
export const LocalizationFileChange = Schema.Struct({
	kind: Schema.Literals(["added", "removed", "rekeyed", "edited"]),
	group: LocalizationFileGroup,
	before: Schema.optionalKey(FileKey),
	after: Schema.optionalKey(FileKey),
	/** Every field the entry has on either side, changed or not, the source first. */
	fields: Schema.Array(LocalizationFileField)
});
export type LocalizationFileChange = typeof LocalizationFileChange.Type;

/** Changes per group, and the entries both files have alike. */
export const LocalizationFileCounts = Schema.Struct({
	rekeyed: Count,
	source: Count,
	removed: Count,
	added: Count,
	translation: Count,
	context: Count,
	unchanged: Count
});
export type LocalizationFileCounts = typeof LocalizationFileCounts.Type;

/**
 * `compareLocalizationFiles`: the files compared, counts of every change, and the requested page
 * of the changes the filter lists, `total` in all; `failed` with the reason.
 */
export const LocalizationFileComparisonResult = Schema.Union([
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
		counts: LocalizationFileCounts,
		total: Count,
		changes: Schema.Array(LocalizationFileChange).check(Schema.isMaxLength(MAX_CHANGE_PAGE))
	})
]);
export type LocalizationFileComparisonResult = typeof LocalizationFileComparisonResult.Type;
