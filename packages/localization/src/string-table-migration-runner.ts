import { isAbsolute, relative, resolve, sep } from "node:path";
import { EditorWorldControl } from "@ue-shed/engine";
import { inspectUnrealProducer, RemoteControlClient } from "@ue-shed/unreal-connection";
import {
	ErrorGuidanceFields,
	GameTextActionsResult,
	StringTableRedirectResult,
	type GameTextAction,
	type GameTextActionsRequest
} from "@ue-shed/protocol";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import {
	localizationTextActionsRequest,
	runLocalizationTextActions,
	verifyLocalizationStringTableRedirect
} from "./asset-text-actions.js";
import {
	StringTableKeyMigrationPlan,
	StringTableKeyMigrationId,
	StringTableKeyMigrationRequest,
	planStringTableKeyMigration,
	prepareStringTableRedirectConfig
} from "./string-table-migration.js";

const Step = Schema.Literals([
	"copy_entry",
	"persist_redirect",
	"retarget_references",
	"verify_redirect",
	"delete_old_entry",
	"verify_saved"
]);
type Step = typeof Step.Type;

/** Durable workflow journal. Verify every selected phase; deleting the old entry is optional. */
export const StringTableKeyMigrationRecord = Schema.Struct({
	plan: StringTableKeyMigrationPlan,
	endpoint: Schema.String,
	sessionId: Schema.String,
	configBefore: Schema.NullOr(Schema.String),
	configAfter: Schema.String,
	preview: GameTextActionsResult,
	redirectChecks: Schema.Array(StringTableRedirectResult),
	state: Schema.Union([
		Schema.Struct({ status: Schema.Literal("prepared") }),
		Schema.Struct({ status: Schema.Literal("running"), step: Step }),
		Schema.Struct({ status: Schema.Literal("complete") }),
		Schema.Struct({ status: Schema.Literal("failed"), step: Step, ...ErrorGuidanceFields })
	]),
	outcomes: Schema.Array(
		Schema.Struct({ step: Step, result: GameTextActionsResult, verified: Schema.Boolean })
	)
});
export type StringTableKeyMigrationRecord = typeof StringTableKeyMigrationRecord.Type;

/** Approves the saved proposal, including deletion only when selected during preparation. */
export const StringTableKeyMigrationApproval = Schema.Struct({
	id: StringTableKeyMigrationId
});
export type StringTableKeyMigrationApproval = typeof StringTableKeyMigrationApproval.Type;

/** Typed workflow failure. Native results remain in the durable journal when recovery is required. */
export class StringTableKeyMigrationError extends Schema.TaggedError<StringTableKeyMigrationError>()(
	"StringTableKeyMigrationError",
	{
		...ErrorGuidanceFields,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}
type HostFailure = { readonly message: string; readonly recovery: string };

/** Host-owned selection, durable atomic storage, config compare/replace and saved-reader authority. */
export interface StringTableKeyMigrationHostApi {
	readonly current: () => Effect.Effect<
		{ readonly projectRoot: string; readonly endpoint: string } | undefined,
		HostFailure
	>;
	readonly store: {
		/** Persist a new proposal exclusively; never overwrite an existing ID. Treat IDs as opaque keys. */
		readonly create: (
			record: StringTableKeyMigrationRecord
		) => Effect.Effect<void, HostFailure>;
		readonly read: (id: string) => Effect.Effect<unknown, HostFailure>;
		readonly write: (record: StringTableKeyMigrationRecord) => Effect.Effect<void, HostFailure>;
		/** Exclusive, durable execution claim shared by host processes. A claimed ID is never replayed. */
		readonly claim: (id: string) => Effect.Effect<void, HostFailure>;
	};
	readonly readConfig: (
		projectRoot: string,
		file: string
	) => Effect.Effect<string | undefined, HostFailure>;
	/** Replace only the exact reviewed bytes; honor a missing-file expectation and project confinement. */
	readonly writeConfig: (
		projectRoot: string,
		file: string,
		before: string | undefined,
		after: string
	) => Effect.Effect<void, HostFailure>;
	/** Re-read every listed package from disk, including absence for removed entries. Never use live objects. */
	readonly verifySaved: (
		projectRoot: string,
		request: GameTextActionsRequest,
		result: GameTextActionsResult
	) => Effect.Effect<boolean, HostFailure>;
}

/** Injectable host authority; no Workbench, selected-project singleton or filesystem default. */
export class StringTableKeyMigrationHost extends Context.Service<
	StringTableKeyMigrationHost,
	StringTableKeyMigrationHostApi
>()("@ue-shed/localization/StringTableKeyMigrationHost") {}

const failure = (message: string, cause?: unknown) =>
	new StringTableKeyMigrationError({
		message,
		recovery:
			"Inspect the migration journal, editor, saved packages and redirect config. Reconcile completed phases; never replay the migration ID.",
		retrySafe: false,
		nextStep: "reconcile",
		...(cause === undefined ? undefined : { cause })
	});

/** Copy/save -> persist config -> migrate/save -> verify redirect -> optional delete/save -> verify. */
export const makeStringTableKeyMigrations = Effect.fn("Localization.stringTable.migrations.make")(
	function* (host: StringTableKeyMigrationHostApi) {
		const client = yield* RemoteControlClient;
		const worlds = yield* EditorWorldControl;
		const gate = yield* Semaphore.make(1);
		const selected = Effect.fn("Localization.stringTable.migrations.selected")(function* (
			root: string,
			endpoint?: string,
			sessionId?: string
		) {
			const current = yield* host.current();
			if (
				!current ||
				relative(resolve(root), resolve(current.projectRoot)) !== "" ||
				(endpoint && current.endpoint !== endpoint)
			)
				return yield* failure("The selected project or editor connection changed.");
			const editor = yield* worlds.snapshot(current.endpoint);
			if (!editor.projectRoot || relative(resolve(root), resolve(editor.projectRoot)) !== "")
				return yield* failure("The connected editor belongs to another project.");
			const producer = yield* inspectUnrealProducer(current.endpoint);
			if (
				!producer.identity ||
				producer.producerKind !== "unreal_editor" ||
				(sessionId && producer.identity.sessionId !== sessionId)
			)
				return yield* failure("The editor session changed or is unavailable.");
			return { endpoint: current.endpoint, sessionId: producer.identity.sessionId };
		});
		const prepare = Effect.fn("Localization.stringTable.migrations.prepare")(function* (
			input: StringTableKeyMigrationRequest
		) {
			const prepared = planStringTableKeyMigration(input);
			if (prepared.status !== "ready") return yield* failure(prepared.message);
			const plan = prepared.plan;
			const reviewed = [
				plan.copy,
				...plan.retarget,
				...(plan.deleteOldEntry ? [plan.remove] : [])
			];
			for (const action of reviewed) {
				const path = relative(
					resolve(input.projectRoot),
					resolve(input.projectRoot, action.place.packageFile)
				);
				if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
					return yield* failure(
						"A migration package is outside its explicit project scope."
					);
			}
			const connection = yield* selected(input.projectRoot);
			const before = yield* host.readConfig(input.projectRoot, plan.redirect.configFile);
			if (before !== undefined && before.length > 1024 * 1024)
				return yield* failure(
					"The redirect configuration is too large to review in this proposal."
				);
			const config = prepareStringTableRedirectConfig(before, plan.redirect);
			if (config.status !== "ready") return yield* failure(config.message);
			const preview = yield* runLocalizationTextActions({
				endpoint: connection.endpoint,
				request: localizationTextActionsRequest({
					mode: "dry_run",
					actions: reviewed,
					save: true
				})
			});
			if (
				preview.status !== "ok" ||
				preview.actions.length !== reviewed.length ||
				reviewed.some((action) => !preview.actions.some((item) => item.id === action.id))
			)
				return yield* failure(
					preview.errors.map((error) => `${error.message} ${error.recovery}`).join(" ") ||
						"The editor returned an incomplete migration preview."
				);
			const record: StringTableKeyMigrationRecord = {
				plan,
				...connection,
				configBefore: before ?? null,
				configAfter: config.after,
				preview,
				redirectChecks: [],
				state: { status: "prepared" },
				outcomes: []
			};
			yield* host.store.create(record);
			return record;
		});
		const execute = Effect.fn("Localization.stringTable.migrations.execute")(function* (
			input: StringTableKeyMigrationApproval
		) {
			if (!Schema.is(StringTableKeyMigrationApproval)(input))
				return yield* failure("Approval must identify a reviewed migration proposal.");
			let record = yield* Schema.decodeUnknownEffect(StringTableKeyMigrationRecord)(
				yield* host.store.read(input.id)
			);
			if (record.plan.request.id !== input.id || record.state.status !== "prepared")
				return yield* failure("This migration is no longer an unapplied proposal.");
			const root = record.plan.request.projectRoot;
			yield* selected(root, record.endpoint, record.sessionId);
			yield* host.store.claim(input.id);
			let step: Step = "copy_entry";
			const save = Effect.fn("Localization.stringTable.migrations.journal")(function* (
				next: StringTableKeyMigrationRecord
			) {
				yield* host.store.write(next);
				record = next;
			});
			const enter = Effect.fn("Localization.stringTable.migrations.step")(function* (
				next: Step
			) {
				step = next;
				yield* selected(root, record.endpoint, record.sessionId);
				yield* save({ ...record, state: { status: "running", step } });
			});
			const apply = Effect.fn("Localization.stringTable.migrations.apply")(function* (
				next: Step,
				actions: readonly GameTextAction[]
			) {
				yield* enter(next);
				const request = localizationTextActionsRequest({
					mode: "apply",
					actions,
					save: true
				});
				const result = yield* runLocalizationTextActions({
					endpoint: record.endpoint,
					request
				});
				yield* save({
					...record,
					outcomes: [...record.outcomes, { step: next, result, verified: false }]
				});
				const packages = new Set(
					actions.map((action) => resolve(root, action.place.packageFile))
				);
				if (
					result.status !== "ok" ||
					result.actions.length !== actions.length ||
					actions.some(
						(action) =>
							!result.actions.some(
								(outcome) =>
									outcome.id === action.id &&
									(outcome.status === "applied" || outcome.status === "unchanged")
							)
					) ||
					result.packages.length !== packages.size ||
					result.packages.some(
						(item) =>
							!item.saved ||
							item.persistence !== "saved" ||
							!packages.has(resolve(root, item.packageFile))
					) ||
					!(yield* host.verifySaved(root, request, result))
				)
					return yield* failure(
						`The ${next} phase was not completely saved and verified.`
					);
				yield* save({
					...record,
					outcomes: record.outcomes.map((item, index) =>
						index === record.outcomes.length - 1 ? { ...item, verified: true } : item
					)
				});
			});
			const redirect = Effect.fn("Localization.stringTable.migrations.redirect")(function* (
				activate: boolean
			) {
				const mapping = record.plan.redirect;
				const result = yield* verifyLocalizationStringTableRedirect({
					endpoint: record.endpoint,
					request: {
						contract: "ue-shed-string-table-redirect",
						version: "1.0",
						tableId: mapping.tableId,
						oldKey: mapping.oldKey,
						newKey: mapping.newKey,
						source: mapping.source,
						activate,
						configFile: mapping.configFile
					}
				});
				yield* save({ ...record, redirectChecks: [...record.redirectChecks, result] });
				if (result.status !== "active") return yield* failure(result.message);
			});
			const reverify = Effect.fn("Localization.stringTable.migrations.reverify")(
				function* () {
					for (const outcome of record.outcomes) {
						const actions =
							outcome.step === "copy_entry"
								? [record.plan.copy]
								: outcome.step === "retarget_references"
									? record.plan.retarget
									: [record.plan.remove];
						if (
							!(yield* host.verifySaved(
								root,
								localizationTextActionsRequest({
									mode: "apply",
									actions,
									save: true
								}),
								outcome.result
							))
						)
							return yield* failure(
								`Saved packages changed after the ${outcome.step} phase.`
							);
					}
				}
			);
			return yield* Effect.gen(function* () {
				yield* apply("copy_entry", [record.plan.copy]);
				yield* enter("persist_redirect");
				if (
					(yield* host.readConfig(root, record.plan.redirect.configFile)) !==
					(record.configBefore ?? undefined)
				)
					return yield* failure("The redirect configuration changed after review.");
				yield* host.writeConfig(
					root,
					record.plan.redirect.configFile,
					record.configBefore ?? undefined,
					record.configAfter
				);
				if (
					(yield* host.readConfig(root, record.plan.redirect.configFile)) !==
					record.configAfter
				)
					return yield* failure(
						"The redirect configuration was not persisted as reviewed."
					);
				if (record.plan.retarget.length > 0)
					yield* apply("retarget_references", record.plan.retarget);
				// Unreal applies redirects when references load. Migrate their original identities first.
				yield* enter("verify_redirect");
				yield* redirect(true);
				if (
					(yield* host.readConfig(root, record.plan.redirect.configFile)) !==
					record.configAfter
				)
					return yield* failure("The persisted redirect changed during migration.");
				yield* redirect(false);
				yield* reverify();
				if (record.plan.deleteOldEntry)
					yield* apply("delete_old_entry", [record.plan.remove]);
				yield* enter("verify_saved");
				yield* redirect(false);
				yield* reverify();
				if (
					(yield* host.readConfig(root, record.plan.redirect.configFile)) !==
					record.configAfter
				)
					return yield* failure(
						"The persisted redirect changed during final verification."
					);
				yield* save({ ...record, state: { status: "complete" } });
				return record;
			}).pipe(
				Effect.tapError((cause) =>
					save({
						...record,
						state: {
							status: "failed",
							step,
							message: cause.message,
							recovery:
								"Inspect and reconcile the recorded phase before approving any further writes.",
							retrySafe: false,
							nextStep: "reconcile"
						}
					})
				)
			);
		});
		const run = <A, E extends { readonly message: string }, R>(
			effect: Effect.Effect<A, E, R>
		) =>
			gate.withPermit(effect).pipe(
				Effect.provideService(RemoteControlClient, client),
				Effect.mapError((cause) =>
					Schema.is(StringTableKeyMigrationError)(cause)
						? cause
						: failure(cause.message, cause)
				)
			);
		const inspect = Effect.fn("Localization.stringTable.migrations.inspect")(function* (
			id: StringTableKeyMigrationId
		) {
			const key = yield* Schema.decodeUnknownEffect(StringTableKeyMigrationId)(id);
			return yield* Schema.decodeUnknownEffect(StringTableKeyMigrationRecord)(
				yield* host.store.read(key)
			);
		});
		return {
			prepare: (input: StringTableKeyMigrationRequest) => run(prepare(input)),
			execute: (input: StringTableKeyMigrationApproval) => run(execute(input)),
			inspect: (id: StringTableKeyMigrationId) => run(inspect(id))
		};
	}
);

/** Shared workflow service, independent of Workbench and any transport adapter. */
export class StringTableKeyMigrations extends Context.Service<
	StringTableKeyMigrations,
	Effect.Success<ReturnType<typeof makeStringTableKeyMigrations>>
>()("@ue-shed/localization/StringTableKeyMigrations") {}
/** Compose with an explicit host, editor-world control and Remote Control client. */
export const StringTableKeyMigrationsLive = Layer.effect(
	StringTableKeyMigrations,
	Effect.gen(function* () {
		return yield* makeStringTableKeyMigrations(yield* StringTableKeyMigrationHost);
	})
);
