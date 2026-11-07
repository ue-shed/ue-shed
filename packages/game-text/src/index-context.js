import { Effect, Result } from "effect";
import { ArchiveEntry, ManifestEntry, POEntry, LocalizationError, LocalizationFileAccess, defaultLocalizationLimits, localizationError, localizationIdentityDiagnostics, parseLocmeta, parseWordCountCSV } from "@ue-shed/localization";
import { decodeLocalizationSnapshot } from "./localization-columns.js";
import { runJoinedQuery } from "./joined-query-node.js";
import { synchronousJoinedTarget } from "./joined-query-reader.js";
import { registerEvidenceRead } from "./evidence-reads.js";
import { localizationEvidenceFileStatuses } from "./localization-status.js";
/**
 * The status report of a search page: coverage and package diagnostics from the index's report
 * header, which keeps the 200-item report limit, and the evidence's file statuses.
 */
export const indexedLocalizationStatusReport = Effect.fn("GameTextIndex.statusReport")(function* (query, evidence, page) {
    const header = yield* query.readCorpusReportHeader;
    // The members in the order the report has always listed them.
    const report = {
        schemaVersion: 1,
        target: evidence.target.name,
        counts: page.localization?.counts ?? [],
        coverage: header.coverage,
        diagnostics: header.diagnostics,
        diagnosticCounts: header.diagnosticCounts,
        diagnosticCount: header.diagnosticCount,
        diagnosticsOmitted: header.diagnosticsOmitted,
        ...(header.packageCoverage ? { packageCoverage: header.packageCoverage } : undefined),
        files: localizationEvidenceFileStatuses(evidence),
        page
    };
    return report;
});
const isManifestEntry = (entry) => "path" in entry;
const isArchiveEntry = (entry) => "translation" in entry;
const isPOEntry = (entry) => "msgid" in entry;
/**
 * Whether a target's PO files carry each line's source text, as the index reads them: all but
 * keyed Crowdin files, whose msgid is the key.
 */
export function localizationPoHasSourceText(target) {
    return target.poFormat !== "Crowdin" || target.collapseMode !== "IdenticalTextIdAndSource";
}
/** The query whose lines are the indexed join's lines: every visible line of the target. */
export function indexedLocalizationLinesRequest(joined) {
    return {
        query: "",
        capability: "all",
        localization: { target: joined.meta.input.target.name }
    };
}
/**
 * Reads retained localization evidence from a pinned joined index using LocalizationFileAccess.
 * Keep the reader scope alive for lazy entries; malformed or unavailable cache inputs retain
 * their typed failures.
 */
export const readIndexedLocalizationEvidence = Effect.fn("GameTextIndex.evidence")(function* (joined) {
    // The evidence getters read synchronously, through the pinned reader's synchronous view.
    const reader = synchronousJoinedTarget(joined).reader;
    const target = joined.meta.input.target, root = joined.meta.input.projectRoot;
    const files = yield* LocalizationFileAccess;
    /**
     * The file's entries in parser order. The importer validated them against their format's schema
     * when it wrote the index, so they are not decoded again: that took most of an archive's read.
     * A yielding read lets other work run between pages.
     */
    const readEntries = Effect.fnUntraced(function* (path, format, is, yieldPages) {
        const file = yield* reader.layer(path);
        const result = [];
        for (let start = 0;; start += 10000) {
            if (yieldPages)
                yield* Effect.yieldNow;
            const page = yield* decodeLocalizationSnapshot(file, start, 10000);
            if (page.format !== format)
                return yield* Effect.die(new Error(`${path} is not a ${format} snapshot`));
            for (let row = 0; row < page.entries.length; row++) {
                const value = page.entries[row];
                if (is(value))
                    result.push({ value, ordinal: page.ordinals[row] });
            }
            if (start + page.entries.length >= page.count)
                break;
        }
        return result.sort((left, right) => left.ordinal - right.ordinal).map((item) => item.value);
    }, Effect.scoped);
    function entries(path, format, is) {
        return runJoinedQuery(readEntries(path, format, is, false));
    }
    function file(path, value, read) {
        const provenance = path ? joined.meta.input.fileProvenances?.[path] : undefined;
        const error = path ? joined.meta.input.fileDiagnostics?.[path] : undefined;
        if (!path || !provenance || error || !reader.manifest.active[path])
            return {
                status: "failed",
                relativePath: path ?? null,
                error: error ?? localizationError("file_missing")
            };
        const evidence = {
            status: "read",
            provenance,
            get value() {
                return value();
            }
        };
        if (read)
            registerEvidenceRead(evidence, read(path));
        return evidence;
    }
    function sorted(values) {
        return [...values].sort((left, right) => left.namespace < right.namespace
            ? -1
            : left.namespace > right.namespace
                ? 1
                : left.key < right.key
                    ? -1
                    : left.key > right.key
                        ? 1
                        : 0);
    }
    const manifestOf = (entries) => {
        const values = sorted(entries);
        return {
            formatVersion: 1,
            entries: values,
            diagnostics: localizationIdentityDiagnostics(values)
        };
    };
    const archiveOf = (entries) => {
        const values = sorted(entries);
        return {
            formatVersion: 2,
            entries: values,
            diagnostics: localizationIdentityDiagnostics(values)
        };
    };
    const manifest = file(target.outputPaths.manifest, () => manifestOf(entries(target.outputPaths.manifest, "manifest", isManifestEntry)), (path) => readEntries(path, "manifest", isManifestEntry, true).pipe(Effect.tap(() => Effect.yieldNow), Effect.map(manifestOf), Effect.orDie));
    const cultures = target.cultures.map((culture) => ({
        culture,
        archive: file(target.outputPaths.archives[culture], () => archiveOf(entries(target.outputPaths.archives[culture], "archive", isArchiveEntry)), (path) => readEntries(path, "archive", isArchiveEntry, true).pipe(Effect.tap(() => Effect.yieldNow), Effect.map(archiveOf), Effect.orDie)),
        po: file(target.outputPaths.portableObjects[culture], () => ({
            format: target.poFormat,
            hasSourceText: localizationPoHasSourceText(target),
            entries: entries(target.outputPaths.portableObjects[culture], "po", isPOEntry)
        }))
    }));
    const small = Effect.fn("GameTextIndex.evidence.readSmallFile")(function* (path, parse) {
        const failed = (error) => ({
            status: "failed",
            relativePath: path,
            error
        });
        if (path === null)
            return failed(localizationError("file_missing"));
        const read = yield* files.read(root, path, defaultLocalizationLimits).pipe(Effect.result);
        if (Result.isFailure(read))
            return failed(read.failure);
        const decoded = parse(read.success.bytes);
        return Result.isFailure(decoded)
            ? { ...failed(decoded.failure), provenance: read.success.provenance }
            : {
                status: "read",
                provenance: read.success.provenance,
                value: decoded.success
            };
    });
    const evidence = {
        schemaVersion: 1,
        target,
        manifest,
        cultures,
        locmeta: yield* small(target.outputPaths.locmeta, parseLocmeta),
        wordCount: yield* small(target.outputPaths.wordCount, parseWordCountCSV)
    };
    return evidence;
});
