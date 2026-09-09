import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { ReviewSet } from "./review-schema.js";
import {
	CameraArrangement,
	CameraArrangementCommand,
	CameraArrangementError,
	CameraOperationId,
	ArrangementCameraId,
	applyCameraArrangementCommand,
	approveArrangementCamera,
	arrangementFailure
} from "./camera-arrangement.js";

const Outcome = Schema.Struct({
	operationId: CameraOperationId,
	fingerprint: Schema.String,
	revision: Schema.Int
});
export const CameraAuthoringDocument = Schema.Struct({
	version: Schema.Literal(1),
	arrangement: CameraArrangement,
	reviewSet: ReviewSet,
	outcomes: Schema.Array(Outcome).check(Schema.isMaxLength(256)),
	projection: Schema.optionalKey(
		Schema.Struct({ path: Schema.String, previousDigest: Schema.NullOr(Schema.String) })
	)
});
export type CameraAuthoringDocument = typeof CameraAuthoringDocument.Type;
export const CameraApproval = Schema.Struct({
	operationId: CameraOperationId,
	expectedRevision: Schema.Int,
	cameraId: ArrangementCameraId,
	destination: Schema.NonEmptyString
});
export type CameraApproval = typeof CameraApproval.Type;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const json = <Value>(value: Value) => `${JSON.stringify(value, null, "\t")}\n`;
function canonical<Value>(input: Value): string {
	const value = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(input)));
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (Schema.is(Schema.Record(Schema.String, Schema.Json))(value))
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
async function optionalRead(path: string) {
	try {
		return await readFile(path, "utf8");
	} catch (cause) {
		if (cause instanceof Object && "code" in cause && cause.code === "ENOENT") return null;
		throw cause;
	}
}
async function writeAtomic(path: string, text: string) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx");
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
async function exclusive<A>(path: string, operation: () => Promise<A>): Promise<A> {
	await mkdir(dirname(path), { recursive: true });
	const lock = `${path}.lock`;
	const handle = await open(lock, "wx").catch(() => {
		throw new CameraArrangementError({
			code: "busy",
			message: `Authoring writer lock: ${lock}`,
			recovery:
				"Wait for the writer. After a crash, verify its recorded PID is no longer running before removing this lock."
		});
	});
	try {
		await handle.writeFile(json({ pid: process.pid, createdAt: new Date().toISOString() }));
		return await operation();
	} finally {
		await handle.close();
		await rm(lock, { force: true });
	}
}
function storageError(cause: unknown) {
	return cause instanceof CameraArrangementError
		? cause
		: new CameraArrangementError({
				code: "storage",
				message: String(cause),
				recovery:
					"Check the authoring document and directory permissions. Retry the same operation ID to recover a committed result."
			});
}

/** File-backed coordinator state. A studio can implement this port over another durable store. */
export interface CameraAuthoringStore {
	readonly load: () => Effect.Effect<CameraAuthoringDocument, CameraArrangementError>;
	readonly create: (
		arrangement: CameraArrangement,
		reviewSet: ReviewSet
	) => Effect.Effect<CameraAuthoringDocument, CameraArrangementError>;
	readonly mutate: (
		command: CameraArrangementCommand
	) => Effect.Effect<CameraAuthoringDocument, CameraArrangementError>;
	readonly approve: (
		approval: CameraApproval
	) => Effect.Effect<CameraAuthoringDocument, CameraArrangementError>;
}
export function makeCameraAuthoringStore(documentPath: string): CameraAuthoringStore {
	const path = resolve(documentPath);
	const load = async () =>
		Schema.decodeUnknownSync(CameraAuthoringDocument)(JSON.parse(await readFile(path, "utf8")));
	const persist = async (document: CameraAuthoringDocument) => {
		await writeAtomic(path, json(CameraAuthoringDocument.make(document)));
		return document;
	};
	const recoverProjection = async (document: CameraAuthoringDocument) => {
		if (!document.projection) return document;
		const projection = document.projection;
		await exclusive(projection.path, async () => {
			const current = await optionalRead(projection.path),
				expected = json(document.reviewSet);
			if (current === expected) return;
			if ((current === null ? null : digest(current)) !== projection.previousDigest)
				throw arrangementFailure(
					"stale",
					"The approval destination changed. The approved state remains recoverable in the authoring document."
				);
			await writeAtomic(projection.path, expected);
		});
		const { projection: _completed, ...completed } = document;
		return persist(completed);
	};
	const transact = <A>(operation: () => Promise<A>) =>
		Effect.tryPromise({ try: () => exclusive(path, operation), catch: storageError });
	const prior = (document: CameraAuthoringDocument, operationId: string, fingerprint: string) => {
		const outcome = document.outcomes.find((entry) => entry.operationId === operationId);
		if (outcome && outcome.fingerprint !== fingerprint)
			throw arrangementFailure(
				"operation_reused",
				"The operation ID was already used with different input."
			);
		return outcome;
	};
	return {
		load: Effect.fn("CameraAuthoringStore.load")(() =>
			Effect.tryPromise({ try: load, catch: storageError })
		),
		create: Effect.fn("CameraAuthoringStore.create")((arrangement, reviewSet) =>
			transact(async () => {
				if ((await optionalRead(path)) !== null)
					throw arrangementFailure("stale", "The authoring document already exists.");
				if (arrangement.mapPath !== reviewSet.project.mapPath)
					throw arrangementFailure(
						"scope_mismatch",
						"The arrangement and Review Set maps differ."
					);
				return persist(
					CameraAuthoringDocument.make({
						version: 1,
						arrangement,
						reviewSet,
						outcomes: []
					})
				);
			})
		),
		mutate: Effect.fn("CameraAuthoringStore.mutate")((input) =>
			transact(async () => {
				const command = Schema.decodeUnknownSync(CameraArrangementCommand)(input);
				const document = await recoverProjection(await load());
				const fingerprint = digest(canonical(command));
				if (prior(document, command.operationId, fingerprint)) return document;
				const arrangement = applyCameraArrangementCommand(document.arrangement, command);
				return persist({
					...document,
					arrangement,
					outcomes: [
						...document.outcomes.slice(-255),
						{
							operationId: command.operationId,
							fingerprint,
							revision: arrangement.revision
						}
					]
				});
			})
		),
		approve: Effect.fn("CameraAuthoringStore.approve")((input) =>
			transact(async () => {
				const approval = Schema.decodeUnknownSync(CameraApproval)(input);
				const document = await recoverProjection(await load());
				const fingerprint = digest(canonical(approval));
				if (prior(document, approval.operationId, fingerprint)) return document;
				if (document.arrangement.revision !== approval.expectedRevision)
					throw arrangementFailure("stale", "Approve the exact reviewed revision.");
				const destination = resolve(approval.destination);
				if (destination === path)
					throw arrangementFailure(
						"invalid",
						"The capture Review Set must have its own path."
					);
				const current = await optionalRead(destination);
				if (
					current !== null &&
					canonical(JSON.parse(current)) !== canonical(document.reviewSet)
				)
					throw arrangementFailure(
						"stale",
						"The destination differs from the draft's Review Set. Import its changes before approving."
					);
				const reviewSet = approveArrangementCamera(
					document.arrangement,
					approval.cameraId,
					document.reviewSet
				);
				// Commit the approval and its projection intent together. Repeating the operation repairs a lost export.
				const committed = await persist({
					...document,
					reviewSet,
					outcomes: [
						...document.outcomes.slice(-255),
						{
							operationId: approval.operationId,
							fingerprint,
							revision: approval.expectedRevision
						}
					],
					projection: {
						path: destination,
						previousDigest: current === null ? null : digest(current)
					}
				});
				return recoverProjection(committed);
			})
		)
	};
}
