import { Schema } from "effect";
import { MAX_CHANGE_PAGE } from "./change-comparison.js";
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** A localization file a comparison reads: a `.po`, an `.archive` or a `.manifest`. */
export const LocalizationFileFormat = Schema.Literals(["po", "archive", "manifest"]);
/** A file's format from its extension; none for a file that is not one of them. */
export function localizationFileFormat(path) {
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
/**
 * What a change means for the text and its translations, in listing order: `rekeyed` (new key, no
 * translation; any new key in a manifest), `reworded` (translation needs redoing), `retouched`
 * (case, punctuation or spacing only), `removed`, `added`, `translation` (source unchanged),
 * `carried` (new key, translation kept or none) and `context` (notes, references or path only).
 */
export const LocalizationFileGroup = Schema.Literals([
    "rekeyed",
    "reworded",
    "retouched",
    "removed",
    "added",
    "translation",
    "carried",
    "context"
]);
/** `chooseLocalizationFile`: which side the person is choosing a file for. */
export const LocalizationFileChoiceRequest = Schema.Struct({
    side: Schema.Literals(["before", "after"])
});
/**
 * `chooseLocalizationFile`: the file chosen and its format, or that the person cancelled, or why
 * the file cannot be compared.
 */
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
/**
 * `compareLocalizationFiles`: two files chosen with `chooseLocalizationFile`, which changes to
 * list, and a page of them.
 */
export const LocalizationFileComparisonRequest = Schema.Struct({
    files: LocalizationFilePair,
    /** Only these groups, and only changes holding this text; every change when absent. */
    filter: Schema.optionalKey(Schema.Struct({
        groups: Schema.Array(LocalizationFileGroup),
        query: Schema.String.check(Schema.isMaxLength(1000)),
        /** Only changes from this asset, as the rollup names it. */
        asset: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
        /** At most this many changes of each group, for an overview; all of them when 0. */
        preview: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })))
    })),
    changes: Schema.Struct({
        offset: Count,
        limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHANGE_PAGE }))
    })
});
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
/** One entry that differs, with what that means for its translations. */
export const LocalizationFileChange = Schema.Struct({
    kind: Schema.Literals(["added", "removed", "rekeyed", "edited"]),
    group: LocalizationFileGroup,
    before: Schema.optionalKey(FileKey),
    after: Schema.optionalKey(FileKey),
    /** Every field the entry has on either side, changed or not, the source first. */
    fields: Schema.Array(LocalizationFileField)
});
/** Changes per group, and the entries both files have alike. */
export const LocalizationFileCounts = Schema.Struct({
    rekeyed: Count,
    reworded: Count,
    retouched: Count,
    removed: Count,
    added: Count,
    translation: Count,
    carried: Count,
    context: Count,
    unchanged: Count
});
/** An asset many of a group's changes come from, and its older name when it was renamed. */
export const LocalizationFileAsset = Schema.Struct({
    group: LocalizationFileGroup,
    asset: Schema.String,
    previous: Schema.optionalKey(Schema.String),
    count: Count,
    /** New keys among them where a written key became a generated one. */
    generated: Count
});
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
        /** Per group, the changes that hold the filter's text. */
        listed: LocalizationFileCounts,
        total: Count,
        /** Per group, the assets most of its changes come from. */
        assets: Schema.Array(LocalizationFileAsset),
        changes: Schema.Array(LocalizationFileChange).check(Schema.isMaxLength(MAX_CHANGE_PAGE))
    })
]);
