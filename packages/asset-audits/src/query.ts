import { maximumDimensionKey } from "./report.js";
import type {
	TextureAuditQuerySummary,
	TextureAuditRecord,
	TextureAuditReport,
	TextureAuditSearchPage,
	TextureAuditSearchRequest,
	TextureDistributionSelection,
	TextureRecord
} from "./schema.js";

function matchesSelection(record: TextureRecord, selection: TextureDistributionSelection): boolean {
	if (selection.kind === "maximumDimension") {
		return maximumDimensionKey(record) === selection.key;
	}
	const evidence = record[selection.kind];
	const key = evidence.status === "available" ? String(evidence.value) : "Unavailable";
	return key === selection.key;
}

/**
 * In-memory, query-scoped view of compact Texture2D facts. Rules and distributions are folded at
 * refresh, while object rows and their details cross the boundary only on demand.
 */
export interface TextureAuditQuery {
	readonly record: (objectPath: string) => TextureAuditRecord | undefined;
	readonly search: (request: TextureAuditSearchRequest) => TextureAuditSearchPage;
	readonly summary: () => TextureAuditQuerySummary;
}

export function textureAuditQuery(report: TextureAuditReport): TextureAuditQuery {
	const records = [...report.records].sort((left, right) =>
		left.objectPath.localeCompare(right.objectPath)
	);
	const findingsByPath = new Map<string, typeof report.findings>();
	for (const finding of report.findings) {
		findingsByPath.set(finding.objectPath, [
			...(findingsByPath.get(finding.objectPath) ?? []),
			finding
		]);
	}
	const summary: TextureAuditQuerySummary = {
		schemaVersion: 1,
		status: report.status,
		ruleSetName: report.ruleSetName,
		coverage: report.coverage,
		diagnosticCount: report.diagnostics.length,
		findingCount: report.findings.length,
		distributions: report.distributions
	};

	return {
		summary: () => summary,
		search: (request) => {
			const query = request.query.toLocaleLowerCase().trim();
			const matched = records.filter((record) => {
				if (request.findingsOnly && !findingsByPath.has(record.objectPath)) return false;
				if (request.selection && !matchesSelection(record, request.selection)) return false;
				return query.length === 0 || record.objectPath.toLocaleLowerCase().includes(query);
			});
			const afterCursor = request.cursor
				? matched.findIndex((record) => record.objectPath === request.cursor) + 1
				: 0;
			const page = matched.slice(Math.max(0, afterCursor), afterCursor + request.pageSize);
			const final = page.at(-1)?.objectPath;
			return {
				findings: page.flatMap((record) => findingsByPath.get(record.objectPath) ?? []),
				records: page,
				total: matched.length,
				...(final !== undefined && afterCursor + page.length < matched.length
					? { nextCursor: final }
					: {})
			};
		},
		record: (objectPath) => {
			const record = records.find((candidate) => candidate.objectPath === objectPath);
			if (!record) return undefined;
			return {
				record,
				findings: (findingsByPath.get(record.objectPath) ?? []).slice(0, 100)
			};
		}
	};
}
