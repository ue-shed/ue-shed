import { Effect, Result, Schema } from "effect";
import {
	ArchiveEntry,
	ManifestEntry,
	POEntry,
	LocalizationError,
	LocalizationFileAccess,
	defaultLocalizationLimits,
	localizationError,
	localizationIdentityDiagnostics,
	parseLocmeta,
	parseWordCountCSV,
	type LocalizationTargetEvidence
} from "@ue-shed/localization";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import { IndexedPolicyData } from "./indexed-policy-data.js";
import { decodeLocalizationSnapshot } from "./localization-columns.js";
import { runJoinedQuery } from "./joined-query-node.js";
import { registerEvidenceRead } from "./evidence-reads.js";
import {
	localizationEvidenceFileStatuses,
	type LocalizationStatusReport
} from "./localization-status.js";
import type { TextCorpusSearchPage } from "./schema.js";

/** Counts scan numeric columns; report strings are limited to the existing 200-item contract. */
export function indexedLocalizationStatusReport(
	joined: JoinedTargetReader,
	evidence: LocalizationTargetEvidence,
	page: TextCorpusSearchPage
): LocalizationStatusReport {
	const data = new IndexedPolicyData(joined);
	return {
		schemaVersion: 1,
		target: evidence.target.name,
		counts: page.localization?.counts ?? [],
		coverage: data.metadata().coverage,
		...data.metadataReport(),
		files: localizationEvidenceFileStatuses(evidence),
		page
	};
}

type Entry = ManifestEntry | ArchiveEntry | POEntry;
const isManifestEntry = (entry: Entry): entry is ManifestEntry => "path" in entry;
const isArchiveEntry = (entry: Entry): entry is ArchiveEntry => "translation" in entry;
const isPOEntry = (entry: Entry): entry is POEntry => "msgid" in entry;

/** The query whose lines are the indexed join's lines: every visible line of the target. */
export function indexedLocalizationLinesRequest(joined: JoinedTargetReader) {
	return {
		query: "",
		capability: "all" as const,
		localization: { target: joined.meta.input.target.name }
	};
}

/**
 * Reads retained localization evidence from a pinned joined index using LocalizationFileAccess.
 * Keep the reader scope alive for lazy entries; malformed or unavailable cache inputs retain
 * their typed failures.
 */
export const readIndexedLocalizationEvidence = Effect.fn("GameTextIndex.evidence")(function* (
	joined: JoinedTargetReader
) {
	const data = new IndexedPolicyData(joined),
		reader = data.joined.reader;
	const target = joined.meta.input.target,
		root = joined.meta.input.projectRoot;
	const files = yield* LocalizationFileAccess;
	/**
	 * The file's entries in parser order. The importer validated them against their format's schema
	 * when it wrote the index, so they are not decoded again: that took most of an archive's read.
	 * A yielding read lets other work run between pages.
	 */
	function readEntries<A extends Entry>(
		path: string,
		format: "manifest" | "archive" | "po",
		is: (entry: Entry) => entry is A,
		yieldPages: boolean
	) {
		return Effect.gen(function* () {
			const file = yield* reader.layer(path);
			const result: { value: A; ordinal: number }[] = [];
			for (let start = 0; ; start += 10000) {
				if (yieldPages) yield* Effect.yieldNow;
				const page = yield* decodeLocalizationSnapshot(file, start, 10000);
				if (page.format !== format)
					return yield* Effect.die(new Error(`${path} is not a ${format} snapshot`));
				for (let row = 0; row < page.entries.length; row++) {
					const value = page.entries[row]!;
					if (is(value)) result.push({ value, ordinal: page.ordinals[row]! });
				}
				if (start + page.entries.length >= page.count) break;
			}
			return result
				.sort((left, right) => left.ordinal - right.ordinal)
				.map((item) => item.value);
		}).pipe(Effect.scoped);
	}
	function entries<A extends Entry>(
		path: string,
		format: "manifest" | "archive" | "po",
		is: (entry: Entry) => entry is A
	): readonly A[] {
		return runJoinedQuery(readEntries(path, format, is, false));
	}
	function file<A>(
		path: string | null | undefined,
		value: () => A,
		read?: (path: string) => Effect.Effect<A>
	) {
		const provenance = path ? joined.meta.input.fileProvenances?.[path] : undefined;
		const error = path ? joined.meta.input.fileDiagnostics?.[path] : undefined;
		if (!path || !provenance || error || !reader.manifest.active[path])
			return {
				status: "failed" as const,
				relativePath: path ?? null,
				error: error ?? localizationError("file_missing")
			};
		const evidence = {
			status: "read" as const,
			provenance,
			get value() {
				return value();
			}
		};
		if (read) registerEvidenceRead(evidence, read(path));
		return evidence;
	}
	function sorted<A extends { namespace: string; key: string }>(values: readonly A[]) {
		return [...values].sort((left, right) =>
			left.namespace < right.namespace
				? -1
				: left.namespace > right.namespace
					? 1
					: left.key < right.key
						? -1
						: left.key > right.key
							? 1
							: 0
		);
	}
	const manifestOf = (entries: readonly ManifestEntry[]) => {
		const values = sorted(entries);
		return {
			formatVersion: 1 as const,
			entries: values,
			diagnostics: localizationIdentityDiagnostics(values)
		};
	};
	const archiveOf = (entries: readonly ArchiveEntry[]) => {
		const values = sorted(entries);
		return {
			formatVersion: 2 as const,
			entries: values,
			diagnostics: localizationIdentityDiagnostics(values)
		};
	};
	const manifest = file(
		target.outputPaths.manifest,
		() => manifestOf(entries(target.outputPaths.manifest!, "manifest", isManifestEntry)),
		(path) =>
			readEntries(path, "manifest", isManifestEntry, true).pipe(
				Effect.tap(() => Effect.yieldNow),
				Effect.map(manifestOf),
				Effect.orDie
			)
	);
	const cultures = target.cultures.map((culture) => ({
		culture,
		archive: file(
			target.outputPaths.archives[culture],
			() =>
				archiveOf(
					entries(target.outputPaths.archives[culture]!, "archive", isArchiveEntry)
				),
			(path) =>
				readEntries(path, "archive", isArchiveEntry, true).pipe(
					Effect.tap(() => Effect.yieldNow),
					Effect.map(archiveOf),
					Effect.orDie
				)
		),
		po: file(target.outputPaths.portableObjects[culture], () => ({
			format: target.poFormat,
			hasSourceText:
				target.poFormat !== "Crowdin" || target.collapseMode !== "IdenticalTextIdAndSource",
			entries: entries(target.outputPaths.portableObjects[culture]!, "po", isPOEntry)
		}))
	}));
	const small = <A>(
		path: string | null,
		parse: (bytes: Uint8Array) => Result.Result<A, LocalizationError>
	) =>
		Effect.gen(function* () {
			const failed = (error: LocalizationError) => ({
				status: "failed" as const,
				relativePath: path,
				error
			});
			if (path === null) return failed(localizationError("file_missing"));
			const read = yield* files
				.read(root, path, defaultLocalizationLimits)
				.pipe(Effect.result);
			if (Result.isFailure(read)) return failed(read.failure);
			const decoded = parse(read.success.bytes);
			return Result.isFailure(decoded)
				? { ...failed(decoded.failure), provenance: read.success.provenance }
				: {
						status: "read" as const,
						provenance: read.success.provenance,
						value: decoded.success
					};
		});
	const evidence: LocalizationTargetEvidence = {
		schemaVersion: 1,
		target,
		manifest,
		cultures,
		locmeta: yield* small(target.outputPaths.locmeta, parseLocmeta),
		wordCount: yield* small(target.outputPaths.wordCount, parseWordCountCSV)
	};
	return evidence;
});
