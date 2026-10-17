import { Schema } from "effect";

/** Limits the editor enforces. A lease renewed at a third of its TTL survives two lost renewals. */
export const EDITOR_FOREGROUND_LEASE_LIMITS = {
	minTtlMs: 2_000,
	defaultTtlMs: 5_000,
	maxTtlMs: 30_000,
	maxLeases: 8
} as const;

const ProcessId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThan(4_294_967_295));

/** Identifies one foreground lease: 32 lowercase hexadecimal characters chosen by the editor. */
export const EditorForegroundLeaseId = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{32}$/u)
).pipe(Schema.brand("EditorForegroundLeaseId"));
export type EditorForegroundLeaseId = typeof EditorForegroundLeaseId.Type;

/**
 * How long a lease lasts without renewal, in milliseconds, within the editor's
 * `EDITOR_FOREGROUND_LEASE_LIMITS`.
 */
export const EditorForegroundLeaseTtlMs = Schema.Int.check(
	Schema.isBetween({
		minimum: EDITOR_FOREGROUND_LEASE_LIMITS.minTtlMs,
		maximum: EDITOR_FOREGROUND_LEASE_LIMITS.maxTtlMs
	})
);

const LeaseCount = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: EDITOR_FOREGROUND_LEASE_LIMITS.maxLeases })
);

const leaseTarget = { expectedProcessId: ProcessId, clientProcessId: ProcessId };

/**
 * Acquires, renews or releases a lease that keeps the editor responsive while another process
 * (`clientProcessId`) owns the foreground window. `expectedProcessId` guards against acting on a
 * different editor than the host connected to.
 */
export const EditorForegroundLeaseRequest = Schema.Union([
	Schema.Struct({
		operation: Schema.Literal("acquire"),
		...leaseTarget,
		ttlMs: Schema.optionalKey(EditorForegroundLeaseTtlMs)
	}),
	Schema.Struct({
		operation: Schema.Literal("renew"),
		...leaseTarget,
		leaseId: EditorForegroundLeaseId,
		ttlMs: Schema.optionalKey(EditorForegroundLeaseTtlMs)
	}),
	Schema.Struct({
		operation: Schema.Literal("release"),
		...leaseTarget,
		leaseId: EditorForegroundLeaseId
	})
]);
export type EditorForegroundLeaseRequest = typeof EditorForegroundLeaseRequest.Type;

const resultBase = {
	schemaVersion: Schema.Literal(1),
	processId: ProcessId,
	message: Schema.String,
	recovery: Schema.String
};
const RequestRejection = Schema.Literals(["invalid_request", "target_changed"]);
const Unsupported = Schema.Struct({
	status: Schema.Literal("unsupported"),
	...resultBase,
	reason: Schema.Literals(["platform", "editor_unavailable"])
});

/**
 * What happened to a lease. `expired` means the lease ended, or its client exited or changed;
 * `rejected` and `unsupported` carry a stable `reason` with prose and a recovery step.
 */
export const EditorForegroundLeaseResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("granted"),
		...resultBase,
		activeLeases: LeaseCount,
		leaseId: EditorForegroundLeaseId,
		ttlMs: EditorForegroundLeaseTtlMs
	}),
	Schema.Struct({
		status: Schema.Literal("renewed"),
		...resultBase,
		activeLeases: LeaseCount,
		leaseId: EditorForegroundLeaseId,
		ttlMs: EditorForegroundLeaseTtlMs
	}),
	Schema.Struct({
		status: Schema.Literal("released"),
		...resultBase,
		activeLeases: LeaseCount,
		leaseId: EditorForegroundLeaseId
	}),
	Schema.Struct({
		status: Schema.Literal("expired"),
		...resultBase,
		activeLeases: LeaseCount,
		leaseId: EditorForegroundLeaseId,
		reason: Schema.Literals(["lease_ended", "client_exited", "client_changed"])
	}),
	Schema.Struct({
		status: Schema.Literal("rejected"),
		...resultBase,
		reason: Schema.Literals([
			...RequestRejection.literals,
			"own_process",
			"client_unavailable",
			"lease_limit",
			"lease_mismatch"
		])
	}),
	Unsupported
]);
export type EditorForegroundLeaseResult = typeof EditorForegroundLeaseResult.Type;

/** Asks the editor for its foreground-throttle state, guarded by the process ID the host expects. */
export const EditorForegroundStateRequest = Schema.Struct({ expectedProcessId: ProcessId });
export type EditorForegroundStateRequest = typeof EditorForegroundStateRequest.Type;

/** The editor's throttle state and active leases, or `unsupported` with a stable reason. */
export const EditorForegroundStateResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("reported"),
		...resultBase,
		/** Whether this editor's throttle exemption entry is registered. */
		registered: Schema.Boolean,
		activeLeases: LeaseCount,
		maxLeases: Schema.Int.check(Schema.isGreaterThan(0)),
		/** Whether a leaseholder owns the foreground window right now. */
		exemptionActive: Schema.Boolean,
		/** Unreal's own throttle decision right now, including every other exemption. */
		editorThrottling: Schema.Boolean,
		/** The user's "Use Less CPU when in Background" setting, read only. */
		throttleWhenNotForeground: Schema.Boolean,
		minTtlMs: EditorForegroundLeaseTtlMs,
		defaultTtlMs: EditorForegroundLeaseTtlMs,
		maxTtlMs: EditorForegroundLeaseTtlMs
	}),
	Schema.Struct({ status: Schema.Literal("rejected"), ...resultBase, reason: RequestRejection }),
	Unsupported
]);
export type EditorForegroundStateResult = typeof EditorForegroundStateResult.Type;
