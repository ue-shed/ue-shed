import type { AuthoringTableSnapshot, AuthoringValue } from "@ue-shed/protocol";
import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RowReferenceSource = Schema.Struct({
	fieldName: Schema.String,
	rowId: Schema.String,
	rowName: Schema.String,
	tableObjectPath: Schema.String,
	valuePath: Schema.Array(Schema.String)
});
export type RowReferenceSource = Schema.Schema.Type<typeof RowReferenceSource>;

export const RowReferenceTarget = Schema.Struct({
	rowName: Schema.String,
	tableObjectPath: Schema.NullOr(Schema.String)
});
export type RowReferenceTarget = Schema.Schema.Type<typeof RowReferenceTarget>;

const RowReferenceEdgeFields = {
	source: RowReferenceSource,
	target: RowReferenceTarget
};
export const RowReferenceEdge = Schema.Union([
	Schema.Struct({
		...RowReferenceEdgeFields,
		status: Schema.Literal("resolved"),
		targetRowId: Schema.String
	}),
	Schema.Struct({ ...RowReferenceEdgeFields, status: Schema.Literal("unassigned") }),
	Schema.Struct({ ...RowReferenceEdgeFields, status: Schema.Literal("missing_table") }),
	Schema.Struct({
		...RowReferenceEdgeFields,
		matchCount: NonNegativeInt,
		status: Schema.Literal("ambiguous_table")
	}),
	Schema.Struct({ ...RowReferenceEdgeFields, status: Schema.Literal("missing_row") }),
	Schema.Struct({
		...RowReferenceEdgeFields,
		matchCount: NonNegativeInt,
		status: Schema.Literal("ambiguous_row")
	})
]);
export type RowReferenceEdge = Schema.Schema.Type<typeof RowReferenceEdge>;

export const RowReferenceDiagnostic = Schema.Struct({
	code: Schema.Literals([
		"row_reference_unassigned",
		"row_reference_missing_table",
		"row_reference_ambiguous_table",
		"row_reference_missing_row",
		"row_reference_ambiguous_row"
	]),
	message: Schema.String,
	recovery: Schema.String,
	source: RowReferenceSource,
	target: RowReferenceTarget
});
export type RowReferenceDiagnostic = Schema.Schema.Type<typeof RowReferenceDiagnostic>;

export const RowReferenceReport = Schema.Struct({
	contract: Schema.Struct({
		name: Schema.Literal("unreal-authoring-row-references"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
	}),
	diagnostics: Schema.Array(RowReferenceDiagnostic),
	edges: Schema.Array(RowReferenceEdge),
	summary: Schema.Struct({
		issueCount: NonNegativeInt,
		referenceCount: NonNegativeInt,
		resolvedCount: NonNegativeInt,
		snapshotCount: NonNegativeInt
	})
});
export type RowReferenceReport = Schema.Schema.Type<typeof RowReferenceReport>;

interface LocatedRowReference {
	readonly path: readonly string[];
	readonly target: RowReferenceTarget;
}

function findRowReferences(
	value: AuthoringValue,
	path: readonly string[] = []
): readonly LocatedRowReference[] {
	switch (value.kind) {
		case "row_reference":
			return [
				{
					path,
					target: {
						rowName: value.rowName,
						tableObjectPath: value.tableObjectPath
					}
				}
			];
		case "array":
		case "set":
			return value.values.flatMap((entry, index) =>
				findRowReferences(entry, [...path, `${value.kind}:${index}`])
			);
		case "map":
			return value.entries.flatMap((entry, index) => [
				...findRowReferences(entry.key, [...path, `map:${index}:key`]),
				...findRowReferences(entry.value, [...path, `map:${index}:value`])
			]);
		case "struct":
			return value.fields.flatMap((field) =>
				findRowReferences(field.value, [...path, `field:${field.name}`])
			);
		default:
			return [];
	}
}

export function inspectRowReferences(
	snapshots: readonly AuthoringTableSnapshot[]
): readonly RowReferenceEdge[] {
	const tables = new Map<string, AuthoringTableSnapshot[]>();
	for (const snapshot of snapshots) {
		const matches = tables.get(snapshot.table.objectPath) ?? [];
		matches.push(snapshot);
		tables.set(snapshot.table.objectPath, matches);
	}

	return snapshots.flatMap((snapshot) =>
		snapshot.table.rows.flatMap((row) =>
			row.fields.flatMap((field) =>
				findRowReferences(field.value).map(({ path, target }): RowReferenceEdge => {
					const source: RowReferenceSource = {
						fieldName: field.name,
						rowId: row.id,
						rowName: row.name,
						tableObjectPath: snapshot.table.objectPath,
						valuePath: path
					};
					if (target.tableObjectPath === null) {
						return { source, status: "unassigned", target };
					}
					const targetTables = tables.get(target.tableObjectPath) ?? [];
					if (targetTables.length === 0) {
						return { source, status: "missing_table", target };
					}
					if (targetTables.length > 1) {
						return {
							matchCount: targetTables.length,
							source,
							status: "ambiguous_table",
							target
						};
					}
					const targetRows = targetTables[0]!.table.rows.filter(
						(candidate) => candidate.name === target.rowName
					);
					if (targetRows.length === 0) {
						return { source, status: "missing_row", target };
					}
					if (targetRows.length > 1) {
						return {
							matchCount: targetRows.length,
							source,
							status: "ambiguous_row",
							target
						};
					}
					return {
						source,
						status: "resolved",
						target,
						targetRowId: targetRows[0]!.id
					};
				})
			)
		)
	);
}

export function rowReferenceDiagnostics(
	edges: readonly RowReferenceEdge[]
): readonly RowReferenceDiagnostic[] {
	return edges.flatMap((edge): RowReferenceDiagnostic[] => {
		const location = `${edge.source.tableObjectPath}/${edge.source.rowName}/${edge.source.fieldName}`;
		switch (edge.status) {
			case "resolved":
				return [];
			case "unassigned":
				return [
					{
						code: "row_reference_unassigned",
						message: `${location} has no target table.`,
						recovery:
							"Choose a target table and row, or leave the field intentionally empty.",
						source: edge.source,
						target: edge.target
					}
				];
			case "missing_table":
				return [
					{
						code: "row_reference_missing_table",
						message: `${location} references unavailable table ${edge.target.tableObjectPath}.`,
						recovery: "Load the referenced table or choose another target.",
						source: edge.source,
						target: edge.target
					}
				];
			case "ambiguous_table":
				return [
					{
						code: "row_reference_ambiguous_table",
						message: `${location} matched ${edge.matchCount} snapshots for ${edge.target.tableObjectPath}.`,
						recovery: "Select one authority before resolving relationships.",
						source: edge.source,
						target: edge.target
					}
				];
			case "missing_row":
				return [
					{
						code: "row_reference_missing_row",
						message: `${location} references missing row ${edge.target.rowName}.`,
						recovery: "Choose an existing target row or restore the referenced row.",
						source: edge.source,
						target: edge.target
					}
				];
			case "ambiguous_row":
				return [
					{
						code: "row_reference_ambiguous_row",
						message: `${location} matched ${edge.matchCount} rows named ${edge.target.rowName}.`,
						recovery: "Repair duplicate row names before resolving relationships.",
						source: edge.source,
						target: edge.target
					}
				];
		}
	});
}

export function makeRowReferenceReport(
	snapshots: readonly AuthoringTableSnapshot[]
): RowReferenceReport {
	const edges = inspectRowReferences(snapshots);
	const diagnostics = rowReferenceDiagnostics(edges);
	return {
		contract: {
			name: "unreal-authoring-row-references",
			version: { major: 1, minor: 0 }
		},
		diagnostics,
		edges,
		summary: {
			issueCount: diagnostics.length,
			referenceCount: edges.length,
			resolvedCount: edges.filter((edge) => edge.status === "resolved").length,
			snapshotCount: snapshots.length
		}
	};
}
