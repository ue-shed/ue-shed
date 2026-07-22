import type {
	AuthoringApplyRequest,
	AuthoringApplyResult,
	AuthoringSaveRequest,
	AuthoringSaveResult
} from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import { workingTable, type DraftSession, type SaveReceipt } from "./draft.js";
import { fingerprintTable } from "./fingerprint.js";

export interface AuthoringLivePort<E> {
	readonly apply: (request: AuthoringApplyRequest) => Effect.Effect<AuthoringApplyResult, E>;
	readonly lookupApplyResult: (operationId: string) => Effect.Effect<AuthoringApplyResult, E>;
	readonly save: (request: AuthoringSaveRequest) => Effect.Effect<AuthoringSaveResult, E>;
}

export class ApplyWorkflowError extends Schema.TaggedErrorClass<ApplyWorkflowError>()(
	"ApplyWorkflowError",
	{
		code: Schema.String,
		operationId: Schema.String,
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface AuthoringMutationLimits {
	readonly maxCommands: number;
	readonly maxPayloadBytes: number;
	readonly maxTables: number;
}

export const defaultAuthoringMutationLimits: AuthoringMutationLimits = {
	maxCommands: 1_024,
	maxPayloadBytes: 1_048_576,
	maxTables: 16
};

function workflowError(operationId: string, code: string, message: string): ApplyWorkflowError {
	return new ApplyWorkflowError({
		code,
		message,
		operationId,
		recovery: "Refresh the live tables, review the draft, and start a new Apply operation.",
		retrySafe: false
	});
}

export type ApplyDispatchOutcome<E> =
	| {
			readonly kind: "known";
			readonly result: AuthoringApplyResult;
			readonly session: DraftSession;
	  }
	| {
			readonly kind: "indeterminate";
			readonly cause: E;
			readonly session: DraftSession;
	  };

function activeCommands(session: DraftSession) {
	return session.commands.slice(0, session.undoPointer);
}

export function buildApplyRequest(
	session: DraftSession,
	operationId: string,
	limits: AuthoringMutationLimits = defaultAuthoringMutationLimits
): AuthoringApplyRequest {
	const commands = activeCommands(session);
	const tableObjectPaths = [...new Set(commands.map((command) => command.tableObjectPath))];
	if (tableObjectPaths.length === 0) {
		throw workflowError(operationId, "empty_draft", "Draft has no active commands");
	}
	if (tableObjectPaths.length > limits.maxTables) {
		throw workflowError(
			operationId,
			"table_limit_exceeded",
			`Apply contains ${tableObjectPaths.length} tables; the editor limit is ${limits.maxTables}`
		);
	}
	if (commands.length > limits.maxCommands) {
		throw workflowError(
			operationId,
			"command_limit_exceeded",
			`Apply contains ${commands.length} commands; the editor limit is ${limits.maxCommands}`
		);
	}
	const request: AuthoringApplyRequest = {
		commands: commands.map((command) => ({
			body: command.body,
			id: command.id,
			tableObjectPath: command.tableObjectPath
		})),
		contract: {
			name: "unreal-authoring-apply",
			version: { major: 1, minor: 0 }
		},
		operationId,
		tables: tableObjectPaths.map((objectPath) => {
			const expectedFingerprint = session.fingerprints[objectPath];
			if (!expectedFingerprint) {
				throw workflowError(
					operationId,
					"missing_fingerprint",
					`Draft has no base fingerprint for ${objectPath}`
				);
			}
			return { expectedFingerprint, objectPath };
		})
	};
	const payloadBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
	if (payloadBytes > limits.maxPayloadBytes) {
		throw workflowError(
			operationId,
			"payload_limit_exceeded",
			`Apply payload is ${payloadBytes} bytes; the editor limit is ${limits.maxPayloadBytes}`
		);
	}
	for (const objectPath of tableObjectPaths) workingTable(session, objectPath);
	return request;
}

function assertExactPaths(
	operationId: string,
	expected: readonly string[],
	actual: readonly string[],
	code: string
): void {
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	if (
		expectedSet.size !== expected.length ||
		actualSet.size !== actual.length ||
		expectedSet.size !== actualSet.size ||
		[...expectedSet].some((path) => !actualSet.has(path))
	) {
		throw workflowError(operationId, code, "Response table set does not match the request");
	}
}

export function acceptApplyResult(
	session: DraftSession,
	request: AuthoringApplyRequest,
	result: AuthoringApplyResult,
	appliedAt: string
): DraftSession {
	if (result.operationId !== request.operationId) {
		throw workflowError(
			request.operationId,
			"operation_mismatch",
			`Expected operation ${request.operationId}, received ${result.operationId}`
		);
	}
	const tableObjectPaths = result.snapshots.map((snapshot) => snapshot.table.objectPath);
	const receipt = {
		appliedAt,
		errors: result.errors,
		operationId: result.operationId,
		status: result.status,
		tableObjectPaths
	} as const;
	if (result.status === "rejected") {
		if (result.snapshots.length > 0) {
			throw workflowError(
				request.operationId,
				"snapshot_set_mismatch",
				"Rejected Apply returned snapshots"
			);
		}
		return { ...session, applyReceipts: [...session.applyReceipts, receipt] };
	}
	const requestedPaths = request.tables.map((table) => table.objectPath);
	assertExactPaths(
		request.operationId,
		requestedPaths,
		tableObjectPaths,
		"snapshot_set_mismatch"
	);
	if (result.status === "rolled_back") {
		return { ...session, applyReceipts: [...session.applyReceipts, receipt] };
	}
	const snapshots = new Map(
		result.snapshots.map((snapshot) => [snapshot.table.objectPath, snapshot])
	);
	for (const objectPath of requestedPaths) {
		const expected = fingerprintTable(workingTable(session, objectPath));
		const actual = fingerprintTable(snapshots.get(objectPath)!);
		if (actual !== expected) {
			throw workflowError(
				request.operationId,
				"snapshot_fingerprint_mismatch",
				`Committed snapshot for ${objectPath} does not match the drafted result`
			);
		}
	}
	const base = { ...session.base };
	const fingerprints = { ...session.fingerprints };
	for (const [objectPath, snapshot] of snapshots) {
		base[objectPath] = snapshot;
		fingerprints[objectPath] = fingerprintTable(snapshot);
	}
	return {
		...session,
		applyReceipts: [...session.applyReceipts, receipt],
		awaitingSave: [...new Set([...session.awaitingSave, ...requestedPaths])],
		base,
		commands: [],
		fingerprints,
		undoPointer: 0
	};
}

function markIndeterminate(
	session: DraftSession,
	operationId: string,
	appliedAt: string,
	tableObjectPaths: readonly string[]
): DraftSession {
	return {
		...session,
		applyReceipts: [
			...session.applyReceipts,
			{ appliedAt, operationId, status: "indeterminate", tableObjectPaths }
		]
	};
}

export function dispatchApply<E>(args: {
	readonly session: DraftSession;
	readonly operationId: string;
	readonly appliedAt: string;
	readonly port: AuthoringLivePort<E>;
}): Effect.Effect<ApplyDispatchOutcome<E>, ApplyWorkflowError> {
	return Effect.try({
		try: () => buildApplyRequest(args.session, args.operationId),
		catch: (cause) =>
			cause instanceof ApplyWorkflowError
				? cause
				: workflowError(args.operationId, "invalid_apply", String(cause))
	}).pipe(
		Effect.flatMap((request) =>
			args.port.apply(request).pipe(
				Effect.flatMap((result) =>
					Effect.try({
						try: () => ({
							kind: "known" as const,
							result,
							session: acceptApplyResult(
								args.session,
								request,
								result,
								args.appliedAt
							)
						}),
						catch: (cause) =>
							cause instanceof ApplyWorkflowError
								? cause
								: workflowError(
										args.operationId,
										"invalid_apply_result",
										String(cause)
									)
					})
				),
				Effect.catch((cause) =>
					cause instanceof ApplyWorkflowError
						? Effect.fail(cause)
						: Effect.succeed({
								cause: cause as E,
								kind: "indeterminate" as const,
								session: markIndeterminate(
									args.session,
									args.operationId,
									args.appliedAt,
									request.tables.map((table) => table.objectPath)
								)
							})
				)
			)
		),
		Effect.withSpan("authoring.apply", {
			attributes: { "authoring.operation_id": args.operationId }
		})
	);
}

export function buildSaveRequest(session: DraftSession, requestId: string): AuthoringSaveRequest {
	const latestResults = new Map(
		session.saveReceipts
			.flatMap((receipt) => receipt.packages)
			.map((result) => [result.objectPath, result])
	);
	const objectPaths = session.awaitingSave.filter((objectPath) => {
		const previous = latestResults.get(objectPath);
		return previous === undefined || previous.status === "saved" || previous.retrySafe;
	});
	if (objectPaths.length === 0) {
		throw new Error("Draft has no applied assets awaiting Save");
	}
	return {
		contract: { name: "unreal-authoring-save", version: { major: 1, minor: 0 } },
		objectPaths,
		requestId
	};
}

export function acceptSaveResult(
	session: DraftSession,
	request: AuthoringSaveRequest,
	result: AuthoringSaveResult,
	savedAt: string
): DraftSession {
	if (result.requestId !== request.requestId) {
		throw workflowError(
			request.requestId,
			"save_request_mismatch",
			`Expected Save ${request.requestId}, received ${result.requestId}`
		);
	}
	assertExactPaths(
		request.requestId,
		request.objectPaths,
		result.packages.map((entry) => entry.objectPath),
		"save_package_set_mismatch"
	);
	const savedPaths = new Set(
		result.packages
			.filter((packageResult) => packageResult.status === "saved")
			.map((packageResult) => packageResult.objectPath)
	);
	const receipt: SaveReceipt = {
		packages: result.packages,
		requestId: result.requestId,
		savedAt,
		status: result.status
	};
	return {
		...session,
		awaitingSave: session.awaitingSave.filter((objectPath) => !savedPaths.has(objectPath)),
		saveReceipts: [...session.saveReceipts, receipt]
	};
}
