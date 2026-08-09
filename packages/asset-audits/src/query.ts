import { maximumDimensionKey } from "./report.js";
import type {
	TextureAuditFinding,
	TextureAuditQuerySummary,
	TextureAuditRecord,
	TextureAuditReport,
	TextureAuditSearchPage,
	TextureAuditSearchRequest,
	TextureDistributionSelection,
	TextureRecord
} from "./schema.js";

type MetricComparison = TextureAuditRecord["comparisons"][number]["maximumDimension"];
type ComparisonKind = TextureAuditRecord["comparisons"][number]["kind"];

function textureFolder(objectPath: string): string {
	const slash = objectPath.lastIndexOf("/");
	return slash > 0 ? objectPath.slice(0, slash) : objectPath;
}

function maximumDimension(record: TextureRecord): number | undefined {
	return record.dimensions.status === "available"
		? Math.max(record.dimensions.value.width, record.dimensions.value.height)
		: undefined;
}

function packageFileBytes(record: TextureRecord): number | undefined {
	return record.packageFileBytes.status === "available"
		? record.packageFileBytes.value
		: undefined;
}

function metricComparison(
	selected: TextureRecord,
	members: readonly TextureRecord[],
	read: (record: TextureRecord) => number | undefined
): MetricComparison {
	const selectedValue = read(selected);
	const values = members
		.map(read)
		.filter((value): value is number => value !== undefined)
		.sort((left, right) => left - right);
	if (selectedValue === undefined || values.length === 0) {
		return { availableCount: values.length, status: "unavailable" };
	}
	const middle = Math.floor(values.length / 2);
	const median =
		values.length % 2 === 0
			? Math.round(((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2)
			: (values[middle] ?? 0);
	return {
		availableCount: values.length,
		maximum: values.at(-1) ?? selectedValue,
		median,
		minimum: values[0] ?? selectedValue,
		percentile: Math.round(
			(values.filter((value) => value <= selectedValue).length / values.length) * 100
		),
		selected: selectedValue,
		status: "available"
	};
}

function representativePeers(options: {
	readonly findingsByPath: ReadonlyMap<string, readonly TextureAuditFinding[]>;
	readonly members: readonly TextureRecord[];
	readonly selected: TextureRecord;
}): TextureAuditRecord["comparisons"][number]["peers"] {
	const candidates = options.members.filter(
		(record) => record.objectPath !== options.selected.objectPath
	);
	const dimensions = candidates
		.map(maximumDimension)
		.filter((value): value is number => value !== undefined)
		.sort((left, right) => left - right);
	const middle = Math.floor(dimensions.length / 2);
	const median = dimensions[middle] ?? maximumDimension(options.selected) ?? 0;
	const selectedDimension = maximumDimension(options.selected) ?? median;
	return [...candidates]
		.sort((left, right) => {
			const leftFinding = options.findingsByPath.get(left.objectPath)?.length ?? 0;
			const rightFinding = options.findingsByPath.get(right.objectPath)?.length ?? 0;
			const leftDimension = maximumDimension(left) ?? median;
			const rightDimension = maximumDimension(right) ?? median;
			const leftScore =
				Math.min(
					Math.abs(leftDimension - median),
					Math.abs(leftDimension - selectedDimension)
				) -
				leftFinding * 0.01;
			const rightScore =
				Math.min(
					Math.abs(rightDimension - median),
					Math.abs(rightDimension - selectedDimension)
				) -
				rightFinding * 0.01;
			return leftScore - rightScore || left.objectPath.localeCompare(right.objectPath);
		})
		.slice(0, 5)
		.map((record) => ({
			dimensions: record.dimensions,
			findingCount: options.findingsByPath.get(record.objectPath)?.length ?? 0,
			objectPath: record.objectPath,
			textureGroup: record.textureGroup
		}));
}

function comparisonLabel(kind: ComparisonKind, selected: TextureRecord): string {
	if (kind === "texture_group") {
		return selected.textureGroup.status === "available"
			? selected.textureGroup.value.replace("TEXTUREGROUP_", "")
			: "Texture group unavailable";
	}
	if (kind === "folder") return textureFolder(selected.objectPath);
	return "Whole project";
}

function comparisonsFor(options: {
	readonly findingsByPath: ReadonlyMap<string, readonly TextureAuditFinding[]>;
	readonly records: readonly TextureRecord[];
	readonly selected: TextureRecord;
}): TextureAuditRecord["comparisons"] {
	const selectedGroup =
		options.selected.textureGroup.status === "available"
			? options.selected.textureGroup.value
			: undefined;
	const group =
		selectedGroup !== undefined
			? options.records.filter(
					(record) =>
						record.textureGroup.status === "available" &&
						record.textureGroup.value === selectedGroup
				)
			: [];
	const folder = options.records.filter(
		(record) => textureFolder(record.objectPath) === textureFolder(options.selected.objectPath)
	);
	const cohorts: ReadonlyArray<readonly [ComparisonKind, readonly TextureRecord[]]> = [
		["texture_group", group],
		["folder", folder],
		["project", options.records]
	];
	return cohorts
		.filter(([, members]) => members.length > 0)
		.map(([kind, members]) => ({
			findingCount: members.reduce(
				(total, record) =>
					total + (options.findingsByPath.get(record.objectPath)?.length ?? 0),
				0
			),
			kind,
			label: comparisonLabel(kind, options.selected),
			maximumDimension: metricComparison(options.selected, members, maximumDimension),
			memberCount: members.length,
			packageFileBytes: metricComparison(options.selected, members, packageFileBytes),
			peers: representativePeers({ ...options, members })
		}));
}

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
			const comparisons = comparisonsFor({ findingsByPath, records, selected: record });
			const defaultComparison =
				comparisons.find(
					(comparison) =>
						comparison.kind === "texture_group" && comparison.memberCount >= 3
				)?.kind ??
				comparisons.find(
					(comparison) => comparison.kind === "folder" && comparison.memberCount >= 3
				)?.kind ??
				"project";
			return {
				comparisons,
				defaultComparison,
				record,
				findings: (findingsByPath.get(record.objectPath) ?? []).slice(0, 100)
			};
		}
	};
}
