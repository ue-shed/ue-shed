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
import type { TextCorpus } from "./schema.js";
import type { LocalizationJoin } from "./localization-schema.js";
import type { TextCorpusQuery } from "./query.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import { JoinedQueryData } from "./joined-query-data.js";
import { decodeLocalizationSnapshot } from "./localization-columns.js";
import { runJoinedQuery } from "./joined-query-node.js";
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
	const data = new JoinedQueryData(joined);
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

/** Legacy report inputs are projections of a pinned index; bulk fields decode on explicit access. */
export function indexedTextCorpus(joined: JoinedTargetReader, query: TextCorpusQuery): TextCorpus {
	const data = new JoinedQueryData(joined),
		summary = query.summary();
	let metadata: ReturnType<JoinedQueryData["exportMetadata"]> | undefined;
	let units: TextCorpus["units"] | undefined;
	const readMetadata = () => (metadata ??= data.exportMetadata());
	return {
		schemaVersion: 1,
		status: summary.status,
		coverage: summary.coverage,
		get units() {
			return (units ??= Array.from(data.column("query.raw.order"), (row) =>
				data.unit("raw", row)
			));
		},
		get diagnostics() {
			return readMetadata().diagnostics;
		},
		get packageCoverage() {
			return readMetadata().packageCoverage ?? [];
		}
	};
}

/** The query whose lines are the indexed join's lines: every visible line of the target. */
export function indexedLocalizationLinesRequest(joined: JoinedTargetReader) {
	return {
		query: "",
		capability: "all" as const,
		localization: { target: joined.meta.input.target.name }
	};
}

/**
 * Lazy localization view over a pinned joined index. Lines materialize on first access through
 * the supplied query, so the owning reader scope must remain open while the view is used.
 */
export function indexedLocalizationJoin(
	joined: JoinedTargetReader,
	query: TextCorpusQuery
): LocalizationJoin {
	const target = joined.meta.input.target;
	let lines: LocalizationJoin["lines"] | undefined;
	return {
		schemaVersion: 1,
		target: target.name,
		nativeCulture: target.nativeCulture,
		cultures: target.cultures,
		get lines() {
			return (lines ??= query.localizationLines(indexedLocalizationLinesRequest(joined)));
		}
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
	const data = new JoinedQueryData(joined),
		reader = data.joined.reader;
	const target = joined.meta.input.target,
		root = joined.meta.input.projectRoot;
	const files = yield* LocalizationFileAccess;
	function entries<A>(path: string, schema: Schema.ConstraintDecoder<A>): readonly A[] {
		return runJoinedQuery(
			Effect.gen(function* () {
				const file = yield* reader.layer(path);
				const result: { value: A; ordinal: number }[] = [];
				for (let start = 0; ; start += 10000) {
					const page = yield* decodeLocalizationSnapshot(file, start, 10000);
					const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(schema))(
						page.entries
					);
					for (let row = 0; row < decoded.length; row++)
						result.push({ value: decoded[row]!, ordinal: page.ordinals[row]! });
					if (start + decoded.length >= page.count) break;
				}
				return result
					.sort((left, right) => left.ordinal - right.ordinal)
					.map((item) => item.value);
			}).pipe(Effect.scoped)
		);
	}
	function file<A>(path: string | null | undefined, value: () => A) {
		const provenance = path ? joined.meta.input.fileProvenances?.[path] : undefined;
		const error = path ? joined.meta.input.fileDiagnostics?.[path] : undefined;
		if (!path || !provenance || error || !reader.manifest.active[path])
			return {
				status: "failed" as const,
				relativePath: path ?? null,
				error: error ?? localizationError("file_missing")
			};
		return {
			status: "read" as const,
			provenance,
			get value() {
				return value();
			}
		};
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
	const manifest = file(target.outputPaths.manifest, () => {
		const values = sorted(entries(target.outputPaths.manifest!, ManifestEntry));
		return {
			formatVersion: 1 as const,
			entries: values,
			diagnostics: localizationIdentityDiagnostics(values)
		};
	});
	const cultures = target.cultures.map((culture) => ({
		culture,
		archive: file(target.outputPaths.archives[culture], () => {
			const values = sorted(entries(target.outputPaths.archives[culture]!, ArchiveEntry));
			return {
				formatVersion: 2 as const,
				entries: values,
				diagnostics: localizationIdentityDiagnostics(values)
			};
		}),
		po: file(target.outputPaths.portableObjects[culture], () => ({
			format: target.poFormat,
			hasSourceText:
				target.poFormat !== "Crowdin" || target.collapseMode !== "IdenticalTextIdAndSource",
			entries: entries(target.outputPaths.portableObjects[culture]!, POEntry)
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
