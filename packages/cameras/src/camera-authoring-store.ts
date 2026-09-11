import { CameraVisibilityPreset } from "./camera-visibility.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { ReviewSet, ReviewViewId } from "./review-schema.js";
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
import { CameraArrangementRecipe } from "./camera-arrangement.js";

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
const ApprovalScope = {
	operationId: CameraOperationId,
	expectedRevision: Schema.Int,
	destination: Schema.NonEmptyString
};
export const CameraApproval = Schema.Union([
	Schema.Struct({ ...ApprovalScope, cameraId: ArrangementCameraId }),
	Schema.Struct({
		...ApprovalScope,
		cameraIds: Schema.Array(ArrangementCameraId).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		),
		removeRetiredViewIds: Schema.Array(ReviewViewId)
	})
]);
export type CameraApproval = typeof CameraApproval.Type;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Rebase disjoint set approvals while retaining conflict detection for this set's saved cameras. */
export function cameraApprovalBase(
	document: CameraAuthoringDocument,
	current: ReviewSet
): ReviewSet {
	const previous = document.reviewSet;
	const {
		views: _oldViews,
		captureProfiles: _oldProfiles,
		contract: _oldContract,
		...oldHeader
	} = previous;
	const {
		views: _newViews,
		captureProfiles: _newProfiles,
		contract: _newContract,
		...newHeader
	} = current;
	const ownedIds = new Set([
		...document.arrangement.cameras.map((camera) => camera.viewId),
		...previous.views
			.filter((view) => view.authoring?.arrangementId === document.arrangement.id)
			.map((view) => view.id)
	]);
	const unchangedOwned = [...ownedIds].every(
		(id) =>
			canonical(previous.views.find((view) => view.id === id) ?? null) ===
			canonical(current.views.find((view) => view.id === id) ?? null)
	);
	const unchangedProfiles = previous.captureProfiles.every(
		(profile) =>
			canonical(profile) ===
			canonical(current.captureProfiles.find((entry) => entry.id === profile.id) ?? null)
	);
	if (canonical(oldHeader) !== canonical(newHeader) || !unchangedOwned || !unchangedProfiles)
		throw arrangementFailure(
			"stale",
			"This set's saved cameras or capture configuration changed. Reload before saving."
		);
	return current;
}
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

export const readCameraArrangementRecipe = Effect.fn("CameraAuthoringStore.readRecipe")(
	(path: string) =>
		Effect.tryPromise({
			try: async () => {
				if ((await stat(path)).size > 4 * 1024 * 1024)
					throw arrangementFailure("invalid", "Recipe exceeds the 4 MiB input limit.");
				return Schema.decodeUnknownSync(CameraArrangementRecipe)(
					JSON.parse(await readFile(path, "utf8")),
					{ onExcessProperty: "error" }
				);
			},
			catch: storageError
		})
);
export const writeCameraArrangementRecipe = Effect.fn("CameraAuthoringStore.writeRecipe")(
	(path: string, recipe: CameraArrangementRecipe) =>
		Effect.tryPromise({
			try: () => writeAtomic(resolve(path), json(CameraArrangementRecipe.make(recipe))),
			catch: storageError
		})
);

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
				let base = document.reviewSet;
				if (current !== null) {
					let decoded: ReviewSet;
					try {
						decoded = Schema.decodeUnknownSync(ReviewSet)(JSON.parse(current));
					} catch {
						throw arrangementFailure(
							"stale",
							"The destination differs from a valid Review Set. Reload before saving."
						);
					}
					base = cameraApprovalBase(document, decoded);
				}
				const ids = "cameraId" in approval ? [approval.cameraId] : approval.cameraIds;
				if (new Set(ids).size !== ids.length)
					throw arrangementFailure("invalid", "Approval camera IDs must be unique.");
				let reviewSet = base;
				for (const cameraId of ids)
					reviewSet = approveArrangementCamera(document.arrangement, cameraId, reviewSet);
				if ("removeRetiredViewIds" in approval) {
					for (const viewId of approval.removeRetiredViewIds) {
						const view = reviewSet.views.find((entry) => entry.id === viewId);
						if (
							!view?.authoring ||
							view.authoring.arrangementId !== document.arrangement.id ||
							!document.arrangement.retiredCameraIds.some(
								(id) => id === view.authoring?.cameraId
							)
						)
							throw arrangementFailure(
								"scope_mismatch",
								"Only explicitly retired Views owned by this arrangement can be removed."
							);
					}
					reviewSet = ReviewSet.make({
						...reviewSet,
						views: reviewSet.views.filter(
							(view) => !approval.removeRetiredViewIds.includes(view.id)
						)
					});
				}
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

export const readCameraVisibilityPreset = Effect.fn("CameraAuthoringStore.readVisibilityPreset")(
	(path: string) =>
		Effect.tryPromise({
			try: async () => {
				if ((await stat(path)).size > 4 * 1024 * 1024)
					throw arrangementFailure(
						"invalid",
						"Visibility preset exceeds the 4 MiB input limit."
					);
				return Schema.decodeUnknownSync(CameraVisibilityPreset)(
					JSON.parse(await readFile(path, "utf8")),
					{ onExcessProperty: "error" }
				);
			},
			catch: storageError
		})
);
export const writeCameraVisibilityPreset = Effect.fn("CameraAuthoringStore.writeVisibilityPreset")(
	(path: string, preset: CameraVisibilityPreset) =>
		Effect.tryPromise({
			try: () =>
				exclusive(resolve(path), async () => {
					const expected = json(CameraVisibilityPreset.make(preset)),
						previous = await optionalRead(resolve(path));
					if (previous === expected) return;
					if (previous !== null)
						throw arrangementFailure(
							"stale",
							"Visibility presets are immutable. Export a new replacement path and explicitly adopt it."
						);
					await writeAtomic(resolve(path), expected);
				}),
			catch: storageError
		})
);
