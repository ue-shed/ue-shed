import { AuthoringRow, type AuthoringTableSnapshot } from "@ue-shed/protocol";
import { Schema } from "effect";
import { inspectRowReferences } from "./relationships.js";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const JoinedViewQuery = Schema.Struct({
	referenceFieldName: Schema.String,
	sourceTableObjectPath: Schema.String
});
export type JoinedViewQuery = Schema.Schema.Type<typeof JoinedViewQuery>;

const JoinedViewSource = Schema.Struct({
	fieldName: Schema.String,
	rowId: Schema.String,
	rowName: Schema.String,
	tableObjectPath: Schema.String
});

const JoinedViewTarget = Schema.Struct({
	rowId: Schema.String,
	rowName: Schema.String,
	tableObjectPath: Schema.String
});

export const JoinedViewRow = Schema.Union([
	Schema.Struct({
		source: JoinedViewSource,
		sourceRow: AuthoringRow,
		status: Schema.Literal("resolved"),
		target: JoinedViewTarget,
		targetRow: AuthoringRow
	}),
	Schema.Struct({
		reason: Schema.Literals([
			"not_reference",
			"unassigned",
			"missing_table",
			"ambiguous_table",
			"missing_row",
			"ambiguous_row"
		]),
		source: JoinedViewSource,
		sourceRow: AuthoringRow,
		status: Schema.Literal("unresolved")
	})
]);
export type JoinedViewRow = Schema.Schema.Type<typeof JoinedViewRow>;

const JoinedViewContract = Schema.Struct({
	name: Schema.Literal("unreal-authoring-joined-view"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});

export const JoinedView = Schema.Union([
	Schema.Struct({
		contract: JoinedViewContract,
		editability: Schema.Struct({ kind: Schema.Literal("read_only"), reason: Schema.String }),
		query: JoinedViewQuery,
		rows: Schema.Array(JoinedViewRow),
		status: Schema.Literal("ready"),
		summary: Schema.Struct({
			resolvedCount: NonNegativeInt,
			rowCount: NonNegativeInt,
			unresolvedCount: NonNegativeInt
		})
	}),
	Schema.Struct({
		contract: JoinedViewContract,
		query: JoinedViewQuery,
		reason: Schema.Literals(["source_table_missing", "source_table_ambiguous"]),
		status: Schema.Literal("unavailable")
	})
]);
export type JoinedView = Schema.Schema.Type<typeof JoinedView>;

export function buildJoinedView(args: {
	readonly query: JoinedViewQuery;
	readonly snapshots: readonly AuthoringTableSnapshot[];
}): JoinedView {
	const contract = {
		name: "unreal-authoring-joined-view" as const,
		version: { major: 1 as const, minor: 0 as const }
	};
	const sources = args.snapshots.filter(
		(snapshot) => snapshot.table.objectPath === args.query.sourceTableObjectPath
	);
	if (sources.length !== 1) {
		return {
			contract,
			query: args.query,
			reason: sources.length === 0 ? "source_table_missing" : "source_table_ambiguous",
			status: "unavailable"
		};
	}

	const sourceSnapshot = sources[0];
	if (sourceSnapshot === undefined) {
		return {
			contract,
			query: args.query,
			reason: "source_table_missing",
			status: "unavailable"
		};
	}
	const edges = inspectRowReferences(args.snapshots).filter(
		(edge) =>
			edge.source.tableObjectPath === args.query.sourceTableObjectPath &&
			edge.source.fieldName === args.query.referenceFieldName &&
			edge.source.valuePath.length === 0
	);
	const edgesByRow = new Map(edges.map((edge) => [edge.source.rowId, edge]));
	const snapshotsByPath = new Map(
		args.snapshots.map((snapshot) => [snapshot.table.objectPath, snapshot])
	);
	const rows: JoinedViewRow[] = sourceSnapshot.table.rows.map((sourceRow) => {
		const source = {
			fieldName: args.query.referenceFieldName,
			rowId: sourceRow.id,
			rowName: sourceRow.name,
			tableObjectPath: sourceSnapshot.table.objectPath
		};
		const edge = edgesByRow.get(sourceRow.id);
		if (!edge) {
			return { reason: "not_reference", source, sourceRow, status: "unresolved" };
		}
		if (edge.status !== "resolved") {
			return { reason: edge.status, source, sourceRow, status: "unresolved" };
		}
		const targetTableObjectPath = edge.target.tableObjectPath;
		if (targetTableObjectPath === null) {
			return { reason: "missing_table", source, sourceRow, status: "unresolved" };
		}
		const targetSnapshot = snapshotsByPath.get(targetTableObjectPath);
		const targetRow = targetSnapshot?.table.rows.find((row) => row.id === edge.targetRowId);
		if (!targetSnapshot || !targetRow) {
			return { reason: "missing_row", source, sourceRow, status: "unresolved" };
		}
		return {
			source,
			sourceRow,
			status: "resolved",
			target: {
				rowId: targetRow.id,
				rowName: targetRow.name,
				tableObjectPath: targetSnapshot.table.objectPath
			},
			targetRow
		};
	});
	const resolvedCount = rows.filter((row) => row.status === "resolved").length;
	return {
		contract,
		editability: {
			kind: "read_only",
			reason: "Joined views are projections. Draft through a canonical source table until one target cell is unambiguous."
		},
		query: args.query,
		rows,
		status: "ready",
		summary: {
			resolvedCount,
			rowCount: rows.length,
			unresolvedCount: rows.length - resolvedCount
		}
	};
}
