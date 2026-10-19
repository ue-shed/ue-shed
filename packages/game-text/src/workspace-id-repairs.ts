import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { Effect, Option, Schema, Semaphore } from "effect";
import { inspectUnrealProducer, RemoteControlClient } from "@ue-shed/unreal-connection";
import { AssetReader, extractProjectTextPackages } from "@ue-shed/unreal-assets";
import { Stream } from "effect";
import {
	TextIdRepairId,
	TextIdRepairPlan,
	TextIdRepairRequest,
	TextIdRepairResult,
	sameRepairOccurrence
} from "./id-repair-schema.js";
import { textIdRepairSupport, textIdNamespace, textIdRepairPlace } from "./id-repair.js";
import {
	gameTextActionsRequest,
	runGameTextActions,
	verifyGameTextActions
} from "./text-actions.js";
import { prepareTextIdTableRepair, applyTextIdTableRepair } from "./id-repair-tables.js";
import { stripPackageNamespace } from "@ue-shed/localization";
import type { GameTextWorkspaceApi } from "./workspace.js";
import type {
	GameTextWorkspaceFileHooks,
	GameTextWorkspaceProjectState
} from "./workspace-host.js";

/** Host authority for ID repairs. Storage, project selection and endpoint selection stay explicit. */
export interface GameTextIdRepairsHost {
	readonly workspace: Pick<GameTextWorkspaceApi, "focus" | "beginOperation" | "endOperation">;
	readonly current: () => Effect.Effect<GameTextWorkspaceProjectState>;
	readonly endpoint: () => Effect.Effect<string>;
	/** Resolve the endpoint's actual project directory through the host's editor connection. */
	readonly editorProject: (
		endpoint: string
	) => Effect.Effect<string | undefined, { readonly message: string; readonly recovery: string }>;
	readonly files: Pick<GameTextWorkspaceFileHooks, "readFileWithin" | "writeFile">;
}

/** Domain failure returned as reviewable recovery information, including indeterminate writes. */
class RepairError extends Schema.TaggedError<RepairError>()("TextIdRepairError", {
	cause: Schema.optionalKey(Schema.Defect()),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean,
	nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"])
}) {}

/** Recovery guidance carried by typed failures from the editor, reader and this workflow. */
const Guidance = Schema.Struct({
	retrySafe: Schema.Boolean,
	nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"])
});

const unavailable = (error: {
	readonly message: string;
	readonly recovery: string;
	readonly retrySafe?: boolean;
	readonly nextStep?: "fix_input" | "retry" | "reconcile" | "escalate";
}): TextIdRepairResult => ({
	status: "unavailable",
	message: error.message,
	recovery: error.recovery,
	retrySafe: error.retrySafe ?? false,
	nextStep: error.nextStep ?? "fix_input"
});

const Artifact = Schema.Struct({
	state: Schema.Literals(["prepared", "started", "finished"]),
	plan: TextIdRepairPlan,
	result: Schema.optionalKey(TextIdRepairResult)
});

const folder = "Saved/UEShed/GameTextActions";

/**
 * Shared durable prepare/approve workflow. Plans pin the project, endpoint, editor session and
 * reviewed occurrences. A started artifact is never replayed, including after restart or a lost reply.
 */
export const makeGameTextIdRepairs = Effect.fn("GameText.idRepairs.make")(function* (
	host: GameTextIdRepairsHost
) {
	const gate = yield* Semaphore.make(1);
	const remote = yield* RemoteControlClient;
	const reader = yield* AssetReader;
	const editorProject = Effect.fn("GameText.idRepairs.editorProject")(function* (
		endpoint: string,
		root: string
	) {
		const actual = yield* host.editorProject(endpoint);
		if (!actual || relative(resolve(actual), resolve(root)) !== "")
			return yield* new RepairError({
				message: "The connected editor is running a different project.",
				recovery: "Connect the shell's selected project and review the fix again.",
				retrySafe: true,
				nextStep: "fix_input"
			});
	});
	const selected = Effect.fn("GameText.idRepairs.selected")(function* (expected?: string) {
		const state = yield* host.current();
		if (
			state.status !== "ready" ||
			(expected !== undefined && state.project.projectRoot !== expected)
		)
			return yield* new RepairError({
				message: "The selected project changed or is unavailable.",
				recovery: "Choose the project in the shell, rescan, and review the fix again.",
				retrySafe: true,
				nextStep: "fix_input"
			});
		return state.project.projectRoot;
	});
	const actions = Effect.fn("GameText.idRepairs.resolve")(function* (
		request: TextIdRepairRequest
	) {
		const root = yield* selected(request.projectKey);
		const seen = new Set<string>();
		const output = [];
		for (const change of request.changes) {
			const expected = change.occurrence;
			const key = JSON.stringify([change.unitId, expected.id]);
			if (seen.has(key))
				return yield* new RepairError({
					message: "This proposal edits a place more than once.",
					recovery: "Review a single edit for each place.",
					retrySafe: false,
					nextStep: "fix_input"
				});
			seen.add(key);
			let found = yield* host.workspace.focus({ id: change.unitId, pageSize: 50 });
			let pages = 1;
			while (
				found.status === "found" &&
				!found.focus.occurrences.some((item) => sameRepairOccurrence(item, expected)) &&
				found.focus.nextOccurrenceCursor &&
				pages < 6
			) {
				found = yield* host.workspace.focus({
					id: change.unitId,
					pageSize: 50,
					occurrenceCursor: found.focus.nextOccurrenceCursor
				});
				pages++;
			}
			if (
				found.status !== "found" ||
				!found.focus.occurrences.some((item) => sameRepairOccurrence(item, expected))
			)
				return yield* new RepairError({
					message: "A reviewed place is no longer in the current scan.",
					recovery: "Rescan and review the fix again.",
					retrySafe: true,
					nextStep: "fix_input"
				});
			const unsupported = textIdRepairSupport(expected, change.edit);
			if (unsupported !== undefined || expected.identity.status !== "resolved")
				return yield* new RepairError({
					message: unsupported ?? "This place cannot be edited here.",
					recovery: "Use the place's Unreal editor or Data Authoring.",
					retrySafe: false,
					nextStep: "fix_input"
				});
			const packageFile = resolve(root, expected.packageFile);
			const within = relative(root, packageFile);
			if (within.startsWith("..") || isAbsolute(within))
				return yield* new RepairError({
					message: "The reviewed package is outside the selected project.",
					recovery: "Open the owning project in the shell and rescan.",
					retrySafe: false,
					nextStep: "fix_input"
				});
			output.push({
				id: expected.id,
				place: {
					...textIdRepairPlace(expected),
					packageFile
				},
				expected: {
					namespace: textIdNamespace(expected),
					key: expected.identity.key,
					source: expected.source
				},
				edit: change.edit
			});
		}
		return output;
	});
	const write = (
		root: string,
		id: TextIdRepairId,
		artifact: typeof Artifact.Type,
		exclusive = false
	) =>
		host.files.writeFile(
			resolve(root, folder, `${id}.json`),
			new TextEncoder().encode(JSON.stringify(artifact)),
			{ exclusive }
		);
	const prepare = Effect.fn("GameText.idRepairs.prepare")(function* (input: TextIdRepairRequest) {
		const request = yield* Schema.decodeUnknownEffect(TextIdRepairRequest)(input).pipe(
			Effect.mapError(
				(cause) =>
					new RepairError({
						cause,
						message: "The ID repair request is invalid.",
						recovery: "Review fewer than 257 places with valid text and keys.",
						retrySafe: false,
						nextStep: "fix_input"
					})
			)
		);
		const root = yield* selected(request.projectKey);
		const endpoint = yield* host.endpoint();
		yield* editorProject(endpoint, root);
		const producer = yield* inspectUnrealProducer(endpoint);
		if (producer.producerKind !== "unreal_editor" || !producer.identity)
			return yield* new RepairError({
				message: "A matching Unreal editor session is required.",
				recovery: "Launch the selected project with UE Shed plugins.",
				retrySafe: true,
				nextStep: "fix_input"
			});
		const resolved = yield* actions(request);
		const id = TextIdRepairId.make(randomUUID());
		const tableCount = request.changes.filter(
			(item) => item.occurrence.location.kind === "data_table_cell"
		).length;
		const plainTables =
			tableCount === request.changes.length &&
			request.changes.every(
				(item) =>
					item.occurrence.location.kind === "data_table_cell" &&
					/^[A-Za-z_][\w ]*$/u.test(item.occurrence.location.propertyPath)
			);
		const table =
			plainTables &&
			producer.capabilities.includes("authoring.snapshot.v2") &&
			producer.authoringObjectPath
				? yield* prepareTextIdTableRepair(endpoint, request, id)
				: undefined;
		const preview =
			table?.preview ??
			(yield* runGameTextActions({
				endpoint,
				request: gameTextActionsRequest({ mode: "dry_run", actions: resolved, save: true })
			}));
		if (
			preview.status === "ok" &&
			(preview.actions.length !== resolved.length ||
				resolved.some(
					(action) => !preview.actions.some((outcome) => outcome.id === action.id)
				))
		)
			return unavailable({
				message: "The editor returned an incomplete repair preview.",
				recovery: "Update the editor plugins and review the fix again."
			});
		const plan: TextIdRepairPlan = {
			id,
			request,
			endpoint,
			sessionId: producer.identity.sessionId,
			preview,
			artifact: `${folder}/${id}.json`,
			...(table ? { authoring: table.authoring } : undefined)
		};
		yield* selected(root);
		yield* write(root, id, { state: "prepared", plan }, true);
		return { status: "prepared", plan } satisfies TextIdRepairResult;
	});
	const claimed = (error: { readonly message: string; readonly recovery?: string }) =>
		new RepairError({
			cause: error,
			message: error.message,
			recovery:
				error.recovery ??
				"Inspect the editor and saved repair receipt before preparing another fix.",
			retrySafe: false,
			nextStep: "reconcile"
		});
	const apply = Effect.fn("GameText.idRepairs.apply")(function* (input: TextIdRepairId) {
		const id = yield* Schema.decodeUnknownEffect(TextIdRepairId)(input).pipe(
			Effect.mapError(
				(cause) =>
					new RepairError({
						cause,
						message: "The repair ID is invalid.",
						recovery: "Prepare and review the fix again.",
						retrySafe: false,
						nextStep: "fix_input"
					})
			)
		);
		const root = yield* selected();
		const bytes = yield* host.files.readFileWithin(root, `${folder}/${id}.json`, {
			maxBytes: 4 * 1024 * 1024
		});
		const artifact = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Artifact))(
			new TextDecoder().decode(bytes)
		).pipe(
			Effect.mapError(
				(cause) =>
					new RepairError({
						cause,
						message: "The saved repair proposal cannot be read.",
						recovery: "Prepare the fix again; inspect any prior editor changes first.",
						retrySafe: false,
						nextStep: "reconcile"
					})
			)
		);
		if (artifact.state !== "prepared")
			return unavailable({
				message: "This fix has already been started.",
				recovery:
					"Inspect its saved receipt and reconcile the editor and saved files before preparing another fix.",
				nextStep: "reconcile"
			});
		const { plan } = artifact;
		if (plan.id !== id || plan.request.projectKey !== root || plan.preview.status !== "ok")
			return unavailable({
				message: "This proposal is not ready to apply.",
				recovery: "Resolve the preview errors and prepare a new fix."
			});
		const endpoint = yield* host.endpoint();
		yield* editorProject(endpoint, root);
		const producer = yield* inspectUnrealProducer(endpoint);
		if (endpoint !== plan.endpoint || producer.identity?.sessionId !== plan.sessionId)
			return unavailable({
				message: "The editor connection changed after the preview.",
				recovery: "Review the fix against the current editor again."
			});
		const resolved = yield* actions(plan.request);
		const admitted = yield* host.workspace.beginOperation();
		if (!admitted)
			return unavailable({
				message: "Another Game Text operation is running.",
				recovery: "Wait for it to finish, then review the fix again.",
				retrySafe: true
			});
		return yield* Effect.gen(function* () {
			yield* selected(root);
			yield* editorProject(endpoint, root);
			// An exclusive claim also prevents two host processes from applying the same proposal.
			yield* host.files.writeFile(
				resolve(root, folder, `${id}.started.json`),
				new TextEncoder().encode(JSON.stringify({ id, endpoint })),
				{ exclusive: true }
			);
			yield* write(root, id, { state: "started", plan });
			// Once claimed, every failure leaves state to reconcile: a retry-safe read after the
			// mutation is never permission to replay the repair.
			return yield* Effect.gen(function* () {
				const request = gameTextActionsRequest({
					mode: "apply",
					actions: resolved,
					save: true
				});
				const result = plan.authoring
					? yield* applyTextIdTableRepair(
							endpoint,
							plan.authoring,
							plan.preview,
							(result) =>
								write(root, id, {
									state: "finished",
									plan,
									result: { status: "finished", plan, result, verified: false }
								})
						)
					: yield* runGameTextActions({ endpoint, request });
				// Retain native outcomes before any re-read can fail or be interrupted.
				yield* write(root, id, {
					state: "finished",
					plan,
					result: { status: "finished", plan, result, verified: false }
				});
				let verified = false;
				if (result.status === "ok" && result.packages.every((item) => item.saved)) {
					const events = yield* Stream.runCollect(
						extractProjectTextPackages({
							projectRoot: root,
							paths: [...new Set(resolved.map((item) => item.place.packageFile))]
						})
					);
					// The reader may report project-relative paths; compare them as absolute files.
					const records = events
						.filter((event) => event.event === "text_package_record")
						.map((record) => ({ ...record, path: resolve(root, record.path) }));
					const verification = verifyGameTextActions(
						request,
						{
							...result,
							actions: result.actions.map((item) =>
								item.status === "unchanged" ? { ...item, status: "applied" } : item
							)
						},
						records
					);
					const tableMatches =
						plan.authoring === undefined ||
						plan.request.changes.every((change) => {
							const location = change.occurrence.location;
							const after = result.actions.find(
								(item) => item.id === change.occurrence.id
							)?.after;
							if (!after || location.kind !== "data_table_cell") return false;
							return records.some(
								(record) =>
									resolve(root, record.path) ===
										resolve(root, change.occurrence.packageFile) &&
									record.occurrences.some(
										(item) =>
											item.location.kind === "data_table_cell" &&
											item.location.object_path === location.objectPath &&
											item.location.row === location.row &&
											item.location.property_path === location.propertyPath &&
											item.identity.status === "resolved" &&
											stripPackageNamespace(item.identity.namespace) ===
												after.namespace &&
											item.identity.key === after.key &&
											item.source === after.source
									)
							);
						});
					verified =
						result.actions.length === resolved.length &&
						resolved.every((action) =>
							result.actions.some(
								(outcome) =>
									outcome.id === action.id &&
									(outcome.status === "applied" || outcome.status === "unchanged")
							)
						) &&
						records.every((record) => record.status === "complete") &&
						tableMatches &&
						(plan.authoring !== undefined || verification.mismatches.length === 0) &&
						records.length ===
							new Set(resolved.map((item) => item.place.packageFile)).size;
				}
				const receipt: TextIdRepairResult = { status: "finished", plan, result, verified };
				yield* write(root, id, { state: "finished", plan, result: receipt });
				return receipt;
			}).pipe(Effect.mapError(claimed));
		}).pipe(Effect.ensuring(host.workspace.endOperation()));
	});
	const failure = (
		error: Effect.Error<ReturnType<typeof apply>> | Effect.Error<ReturnType<typeof prepare>>,
		mutation: boolean
	) => {
		// Keep each failure's own guidance; only unguided failures fall back to the phase default.
		const guidance = Schema.decodeUnknownOption(Guidance)(error);
		return unavailable({
			message: error.message,
			recovery:
				"recovery" in error
					? error.recovery
					: "Inspect the editor and saved repair receipt before retrying.",
			retrySafe: Option.isSome(guidance) ? guidance.value.retrySafe : false,
			nextStep: Option.isSome(guidance)
				? guidance.value.nextStep
				: mutation
					? "reconcile"
					: "fix_input"
		});
	};
	return {
		prepare: (request: TextIdRepairRequest) =>
			gate.withPermit(prepare(request)).pipe(
				Effect.provideService(RemoteControlClient, remote),
				Effect.catch((error) => Effect.succeed(failure(error, false)))
			),
		apply: (id: TextIdRepairId) =>
			gate.withPermit(apply(id)).pipe(
				Effect.provideService(RemoteControlClient, remote),
				Effect.provideService(AssetReader, reader),
				Effect.catch((error) => Effect.succeed(failure(error, true)))
			)
	};
});
