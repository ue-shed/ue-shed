import { snapshotStoreGuidance } from "./snapshot-store.js";
import { Schema } from "effect";
import { CultureCode, LocalizationTargetName } from "@ue-shed/localization/browser";
import { TextCorpus, TextUnitId } from "./schema.js";
import { TextQualityFindingId } from "./quality-query.js";
import { TextQualityFinding, TextQualityRuleSummary } from "./quality-schema.js";
import {
	LocalizationCheckDiagnostic,
	LocalizationCheckOptions,
	LocalizationCustomFinding,
	LocalizationPolicyFinding,
	LocalizationQualityFinding
} from "./localization-quality-schema.js";
import { LocalizationLine } from "./localization-schema.js";
import { GameTextRuleDocument } from "./game-text-rules.js";
import { CheckSeverity } from "./localization-check-ids.js";
import { WorkspaceFinding, WorkspaceQualityFilter } from "./localization-workspace.js";
import { SearchWorkerInput } from "./search-worker-protocol.js";
import { GameTextIndexProgress } from "./index-progress.js";
import { SnapshotStoreError } from "./snapshot-store.js";
import { SnapshotFormatError } from "./snapshot-format.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const RuleId = TextQualityRuleSummary.fields.ruleId;

/** The generation a quality worker opens; the same pin a search worker takes. */
export const QualityWorkerInput = SearchWorkerInput;
export type QualityWorkerInput = typeof QualityWorkerInput.Type;

export const QualityWorkerFailure = Schema.Union([SnapshotStoreError, SnapshotFormatError]);
export type QualityWorkerFailure = typeof QualityWorkerFailure.Type;

/** Host to worker on the worker's port. */
export const QualityWorkerTask = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("scan"),
		id: Count,
		corpus: Schema.Struct({
			status: TextCorpus.fields.status,
			coverage: TextCorpus.fields.coverage
		}),
		/** The join's line rows the scan checks, in the join's order. */
		rows: Schema.instanceOf(Uint32Array),
		options: LocalizationCheckOptions,
		ruleDocument: Schema.optionalKey(GameTextRuleDocument)
	}),
	/** Stops a running scan; its host has stopped waiting for it. */
	Schema.Struct({ kind: Schema.Literal("cancel"), id: Count }),
	/** Forgets a finished scan; no host object reads it any more. */
	Schema.Struct({ kind: Schema.Literal("release"), id: Count })
]);
export type QualityWorkerTask = typeof QualityWorkerTask.Type;

/** A scan's findings as the host keeps them: groups of positions that share their facts. */
export const QualityWorkerFindings = Schema.Struct({
	length: Count,
	groups: Schema.Array(
		Schema.Struct({
			culture: CultureCode,
			filter: WorkspaceQualityFilter,
			severity: CheckSeverity,
			ruleId: RuleId,
			eligible: Schema.Boolean,
			reportedBySource: Schema.Boolean,
			positions: Schema.instanceOf(Uint32Array)
		})
	),
	/** Each position's index in `groups`. */
	groupOf: Schema.instanceOf(Uint32Array),
	/** Check diagnostic counts per culture; the empty culture is the whole target's. */
	limits: Schema.Array(
		Schema.Struct({
			culture: Schema.String,
			counts: Schema.Array(
				Schema.Struct({ code: LocalizationCheckDiagnostic.fields.code, count: Count })
			)
		})
	),
	metadata: Schema.Struct({
		join: Schema.Struct({
			target: LocalizationTargetName,
			nativeCulture: Schema.NullOr(CultureCode),
			cultures: Schema.Array(CultureCode)
		}),
		rules: Schema.Array(RuleId),
		customChecks: Schema.optionalKey(
			Schema.Array(Schema.Struct({ ruleId: RuleId, label: Schema.String }))
		),
		unsupportedRuleCultures: Count,
		status: TextCorpus.fields.status,
		coverage: TextCorpus.fields.coverage,
		sourceKeys: Schema.Boolean
	})
});
export type QualityWorkerFindings = typeof QualityWorkerFindings.Type;

/** Worker to host on the worker's port. */
export const QualityWorkerReply = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("ready") }),
	Schema.Struct({
		kind: Schema.Literal("progress"),
		id: Count,
		progress: GameTextIndexProgress
	}),
	Schema.Struct({ kind: Schema.Literal("done"), id: Count, findings: QualityWorkerFindings }),
	Schema.Struct({ kind: Schema.Literal("cancelled"), id: Count }),
	Schema.Struct({
		kind: Schema.Literal("failed"),
		id: Schema.optionalKey(Count),
		error: QualityWorkerFailure
	})
]);
export type QualityWorkerReply = typeof QualityWorkerReply.Type;

/** Synchronous reads of a finished scan, served between the worker's slices. */
export const QualityWorkerCall = Schema.Union([
	Schema.Struct({
		id: Count,
		scan: Count,
		method: Schema.Literal("items"),
		positions: Schema.Array(Count)
	}),
	Schema.Struct({
		id: Count,
		scan: Count,
		method: Schema.Literal("find"),
		findingId: TextQualityFindingId,
		culture: Schema.optionalKey(CultureCode)
	}),
	Schema.Struct({
		id: Count,
		scan: Count,
		method: Schema.Literals(["lineOfUnit", "sourceKeyOfUnit"]),
		unitId: TextUnitId
	})
]);
export type QualityWorkerCall = typeof QualityWorkerCall.Type;
export const QualityWorkerCallReply = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("value"), id: Count, value: Schema.Unknown }),
	Schema.Struct({ kind: Schema.Literal("failed"), id: Count, error: QualityWorkerFailure })
]);
export type QualityWorkerCallReply = typeof QualityWorkerCallReply.Type;

/** The value schema of each call. */
export const qualityWorkerCallValues = {
	items: Schema.Array(
		Schema.Struct({
			finding: Schema.Union([
				LocalizationQualityFinding,
				LocalizationPolicyFinding,
				LocalizationCustomFinding,
				TextQualityFinding
			]),
			line: Schema.UndefinedOr(LocalizationLine),
			summary: WorkspaceFinding
		})
	),
	find: Schema.UndefinedOr(Count),
	lineOfUnit: Schema.UndefinedOr(LocalizationLine),
	sourceKeyOfUnit: Schema.UndefinedOr(Schema.String)
} as const;

export function qualityWorkerFailure(operation: string, cause: unknown): QualityWorkerFailure {
	return Schema.is(SnapshotStoreError)(cause) || Schema.is(SnapshotFormatError)(cause)
		? cause
		: new SnapshotStoreError({
				retrySafe: snapshotStoreGuidance("unavailable").retrySafe,
				nextStep: snapshotStoreGuidance("unavailable").nextStep,
				operation,
				code: "unavailable",
				message: `The Game Text quality worker could not complete ${operation}.`,
				cause,
				recovery: "Refresh the Game Text index and run the quality scan again."
			});
}
