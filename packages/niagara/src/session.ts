import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type Brand, Effect, Exit, Schedule, Schema } from "effect";
import { NiagaraErrorGuidanceFields as ErrorGuidanceFields } from "./schema.js";

export class NiagaraSessionError extends Schema.TaggedError<
	NiagaraSessionError,
	Brand.Brand<"packages/niagara/src/session/NiagaraSessionError">
>()("NiagaraSessionError", {
	...ErrorGuidanceFields,
	cause: Schema.optionalKey(Schema.Defect())
}) {}
type SessionGuidance = Pick<NiagaraSessionError, "nextStep" | "recovery" | "retrySafe">;
const failure = (message: string, guidance: SessionGuidance, cause?: unknown) =>
	new NiagaraSessionError({
		message,
		...guidance,
		...(cause === undefined ? undefined : { cause })
	});
/** Before the request is published nothing has run, so the whole submission can be repeated. */
const beforeSubmit: SessionGuidance = {
	recovery:
		"Check that the Niagara session directory is readable and writable, then submit again.",
	retrySafe: true,
	nextStep: "retry"
};
/** After publication the session may already be capturing the run; resubmitting could repeat it. */
const afterSubmit: SessionGuidance = {
	recovery: "Inspect the session directory for this run's result before submitting it again.",
	retrySafe: false,
	nextStep: "reconcile"
};
const producerMismatch: SessionGuidance = {
	recovery: "Use a UEShedNiagara session producer that matches this host.",
	retrySafe: false,
	nextStep: "escalate"
};
const maximumSessionFileBytes = 4096;
class OversizedSessionFile extends Error {}
const resultSchema = Schema.Struct({
	protocol: Schema.Literal("ue-shed-niagara-session.v1"),
	runId: Schema.String,
	exitCode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
});
const readOptional = (path: string, guidance: SessionGuidance) =>
	Effect.tryPromise({
		try: async () => {
			try {
				const details = await stat(path);
				if (details.size > maximumSessionFileBytes) throw new OversizedSessionFile();
				return await readFile(path, "utf8");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT")
					return undefined;
				throw error;
			}
		},
		catch: (cause) =>
			failure(
				cause instanceof OversizedSessionFile
					? `Niagara session file ${path} exceeds ${maximumSessionFileBytes} bytes.`
					: `Could not read Niagara session file ${path}.`,
				guidance,
				cause
			)
	});

/** The host owns the process; interruption leaves a cancellation marker before releasing the request. */
export const submitNiagaraSessionRequest = Effect.fn("NiagaraSession.submit")(function* (input: {
	directory: string;
	requestPath: string;
	runId: string;
	timeoutMs?: number;
}) {
	if (!isAbsolute(input.directory) || !/^[a-f0-9-]{36}$/.test(input.runId))
		return yield* failure("Invalid Niagara session request.", {
			recovery: "Pass an absolute session directory and a UUID run ID.",
			retrySafe: true,
			nextStep: "fix_input"
		});
	const ready = yield* readOptional(join(input.directory, "ready.json"), beforeSubmit);
	yield* Schema.decodeUnknownEffect(
		Schema.fromJsonString(
			Schema.Struct({
				protocol: Schema.Literal("ue-shed-niagara-session.v1")
			})
		)
	)(ready).pipe(
		Effect.mapError((cause) =>
			failure(
				"Session is not ready.",
				{
					recovery:
						"Wait for the Niagara session to write its ready marker, or start a new session.",
					retrySafe: true,
					nextStep: "retry"
				},
				cause
			)
		)
	);
	const prefix = join(input.directory, input.runId);
	const poll = Effect.gen(function* () {
		const text = yield* readOptional(`${prefix}.result.json`, afterSubmit);
		if (text !== undefined) {
			const result = yield* Schema.decodeEffect(Schema.fromJsonString(resultSchema))(
				text
			).pipe(
				Effect.mapError((cause) =>
					failure("Invalid session result.", producerMismatch, cause)
				)
			);
			if (result.runId !== input.runId)
				return yield* failure("Invalid session result identity.", producerMismatch);
			return result.exitCode;
		}
		if ((yield* readOptional(join(input.directory, "closed"), afterSubmit)) !== undefined)
			return yield* failure("Niagara session closed before completing capture.", {
				recovery: "Start a new Niagara session, then submit the run again.",
				retrySafe: false,
				nextStep: "reconcile"
			});
		return undefined;
	}).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("100 millis"),
			while: (result) => result === undefined
		})
	);
	const result = yield* Effect.acquireUseRelease(
		Effect.tryPromise({
			try: async () => {
				await copyFile(input.requestPath, `${prefix}.pending`);
				await rename(`${prefix}.pending`, `${prefix}.request.json`);
			},
			catch: (cause) =>
				failure(
					`Could not submit Niagara session request ${input.runId} to ${input.directory}.`,
					beforeSubmit,
					cause
				)
		}),
		() => poll.pipe(Effect.timeout(input.timeoutMs ?? 30 * 60_000)),
		(_, exit) =>
			Exit.isSuccess(exit)
				? Effect.void
				: Effect.tryPromise({
						try: () => writeFile(`${prefix}.cancel`, "cancelled\n"),
						catch: (cause) =>
							failure(
								`Could not write the cancellation marker for Niagara session run ${input.runId}.`,
								{
									recovery:
										"Remove the run's request from the session directory or close the session.",
									retrySafe: true,
									nextStep: "retry"
								},
								cause
							)
					}).pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Niagara session cancellation marker failed", error)
						),
						Effect.ignore
					)
	);
	if (result === undefined) return yield* Effect.die("Session polling ended without a result.");
	return result;
});
