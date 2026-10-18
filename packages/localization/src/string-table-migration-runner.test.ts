import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import { makeEditorWorldControlTestLayer } from "@ue-shed/engine";
import { GameTextActionsRequest, type GameTextActionsResult } from "@ue-shed/protocol";
import {
	makeRemoteControlClientTestLayer,
	RemoteControlClientError
} from "@ue-shed/unreal-connection";
import {
	makeStringTableKeyMigrations,
	type StringTableKeyMigrationHostApi,
	type StringTableKeyMigrationRecord
} from "./string-table-migration-runner.js";
import {
	StringTableKeyMigrationId,
	type StringTableKeyMigrationRequest
} from "./string-table-migration.js";

const input: StringTableKeyMigrationRequest = {
	id: StringTableKeyMigrationId.make("migration"),
	projectRoot: "C:/Fixture",
	packageFile: "Content/ST_Words.uasset",
	objectPath: "/Game/ST_Words.ST_Words",
	tableId: "/Game/ST_Words.ST_Words",
	namespace: "Words",
	oldKey: "Old",
	newKey: "New",
	source: "Welcome aboard",
	deleteOldEntry: true,
	references: [
		{
			id: "reference",
			place: {
				packageFile: "Content/DA_Words.uasset",
				objectPath: "/Game/DA_Words.DA_Words",
				propertyPath: "Text"
			}
		}
	]
};

function setup() {
	let record: StringTableKeyMigrationRecord | undefined;
	let claimed = false;
	let config: string | undefined;
	let session = "session-1";
	let selected = input.projectRoot;
	let redirectActive = true;
	let rejectVerification = "";
	let lostDeleteReply = false;
	let changedCopy = false;
	const writes: string[] = [];
	const verifications: string[] = [];
	const fail = (message: string) => ({ message, recovery: "Inspect the journal." });
	const host: StringTableKeyMigrationHostApi = {
		current: () => Effect.succeed({ projectRoot: selected, endpoint: "http://fixture" }),
		store: {
			create: (value) =>
				Effect.sync(() => {
					record = value;
				}),
			read: () => Effect.succeed(record),
			write: (value) =>
				Effect.sync(() => {
					record = value;
				}),
			claim: () =>
				claimed
					? Effect.fail(fail("Already claimed"))
					: Effect.sync(() => {
							claimed = true;
						})
		},
		readConfig: () => Effect.succeed(config),
		writeConfig: (_root, _file, before, after) =>
			config !== before
				? Effect.fail(fail("Config changed"))
				: Effect.sync(() => {
						config = after;
					}),
		verifySaved: (_root, request) =>
			Effect.sync(() => {
				const kind = request.actions[0]!.edit.kind;
				verifications.push(kind);
				return (
					kind !== rejectVerification &&
					!(changedCopy && kind === "copy_string_table_entry" && writes.length > 1)
				);
			})
	};
	const transport = makeRemoteControlClientTestLayer((call) =>
		Effect.gen(function* () {
			if (call.functionName === "GetCapabilityManifest")
				return Schema.decodeUnknownSync(Schema.Json)({
					schemaVersion: 1,
					producerKind: "unreal_editor",
					capabilities: ["game-text.actions.v1", "game-text.actions.authoring.v1"],
					gameTextObjectPath: "/Script/UEShedGameText.Default__UEShedGameTextLibrary",
					identity: {
						engineVersion: "5.8",
						processId: 1,
						sessionId: session,
						plugins: []
					}
				});
			if (call.functionName === "VerifyStringTableRedirect")
				return Schema.decodeUnknownSync(Schema.Json)({
					contract: "ue-shed-string-table-redirect",
					version: "1.0",
					status: redirectActive ? "active" : "inactive",
					tableId: input.tableId,
					key: input.newKey,
					source: input.source,
					message: "Redirect not active"
				});
			const request = Schema.decodeUnknownSync(Schema.fromJsonString(GameTextActionsRequest))(
				call.parameters.RequestJson
			);
			const kind = request.actions[0]!.edit.kind;
			if (request.mode === "apply") writes.push(kind);
			if (request.mode === "apply" && kind === "remove_string_table_entry" && lostDeleteReply)
				return yield* new RemoteControlClientError({
					code: "request_timeout",
					endpoint: call.endpoint,
					functionName: call.functionName,
					operation: "delete",
					message: "Lost deletion reply",
					recovery: "Inspect saved assets",
					retrySafe: false,
					nextStep: "reconcile"
				});
			const result: GameTextActionsResult = {
				contract: request.contract,
				version: request.version,
				mode: request.mode,
				status: "ok",
				rolledBack: false,
				actions: request.actions.map((action) => ({
					id: action.id,
					place: action.place,
					before: action.expected,
					after: { namespace: "Words", key: "New", source: input.source },
					status: request.mode === "apply" ? "applied" : "planned"
				})),
				packages: [
					...new Set(request.actions.map((action) => action.place.packageFile))
				].map((packageFile) => ({
					packageFile,
					packageName: "/Game/Words",
					saved: request.mode === "apply",
					persistence: request.mode === "apply" ? "saved" : "unsaved"
				})),
				blueprints: [],
				errors: []
			};
			return Schema.decodeUnknownSync(Schema.Json)(result);
		})
	);
	const world = makeEditorWorldControlTestLayer({
		snapshot: () =>
			Effect.succeed({
				contract: { name: "unreal-editor-world-control", version: { major: 1, minor: 0 } },
				projectName: "Fixture",
				projectRoot: input.projectRoot,
				snapshot: { dirtyWorldPackages: [], playSessionActive: false }
			}),
		open: () => Effect.die("Unused")
	});
	return {
		make: makeStringTableKeyMigrations(host).pipe(
			Effect.provide(transport),
			Effect.provide(world)
		),
		writes,
		verifications,
		record: () => record,
		redirect: (value: boolean) => {
			redirectActive = value;
		},
		verification: (kind: string) => {
			rejectVerification = kind;
		},
		loseDelete: () => {
			lostDeleteReply = true;
		},
		changeCopy: () => {
			changedCopy = true;
		},
		changeSession: () => {
			session = "session-2";
		},
		changeProject: () => {
			selected = "C:/Other";
		},
		changeConfig: () => {
			config = "Changed after review";
		}
	};
}

it.effect(
	"completes only after explicitly approved deletion and re-reading every saved phase",
	() =>
		Effect.gen(function* () {
			const test = setup();
			const api = yield* test.make;
			const prepared = yield* api.prepare(input);
			expect(prepared.preview.actions.at(-1)?.id).toBe("migration:remove");
			const result = yield* api.execute({ id: input.id });
			expect(result.state.status).toBe("complete");
			expect((yield* api.inspect(input.id)).state.status).toBe("complete");
			expect(test.writes).toEqual([
				"copy_string_table_entry",
				"retarget_string_table",
				"remove_string_table_entry"
			]);
			expect(result.outcomes.find((item) => item.step === "delete_old_entry")?.verified).toBe(
				true
			);
			expect(
				test.verifications.filter((kind) => kind === "remove_string_table_entry")
			).toHaveLength(2);
			expect(yield* Effect.result(api.execute({ id: input.id }))).toMatchObject({
				_tag: "Failure"
			});
			expect(test.writes).toHaveLength(3);
		})
);

it.effect("completes without deletion when it was omitted from the proposal", () =>
	Effect.gen(function* () {
		const test = setup();
		const api = yield* test.make;
		const { deleteOldEntry: _deleteOldEntry, ...retaining } = input;
		const prepared = yield* api.prepare(retaining);
		expect(prepared.plan.deleteOldEntry).toBe(false);
		expect(prepared.preview.actions.some((action) => action.id === "migration:remove")).toBe(
			false
		);
		const result = yield* api.execute({ id: input.id });
		expect(result.state.status).toBe("complete");
		expect(test.writes).toEqual(["copy_string_table_entry", "retarget_string_table"]);
		expect(test.verifications).not.toContain("remove_string_table_entry");
	})
);

for (const mode of [
	"redirect",
	"retarget",
	"copyChanged",
	"session",
	"project",
	"config"
] as const) {
	it.effect(`stops before deletion when ${mode} verification changes`, () =>
		Effect.gen(function* () {
			const test = setup();
			const api = yield* test.make;
			yield* api.prepare(input);
			if (mode === "redirect") test.redirect(false);
			if (mode === "retarget") test.verification("retarget_string_table");
			if (mode === "copyChanged") test.changeCopy();
			if (mode === "session") test.changeSession();
			if (mode === "project") test.changeProject();
			if (mode === "config") test.changeConfig();
			expect(yield* Effect.result(api.execute({ id: input.id }))).toMatchObject({
				_tag: "Failure"
			});
			expect(test.writes).not.toContain("remove_string_table_entry");
		})
	);
}

it.effect("records an indeterminate deletion without replaying the mutation", () =>
	Effect.gen(function* () {
		const test = setup();
		const api = yield* test.make;
		yield* api.prepare(input);
		test.loseDelete();
		expect(yield* Effect.result(api.execute({ id: input.id }))).toMatchObject({
			_tag: "Failure"
		});
		expect(test.record()?.state).toMatchObject({
			status: "failed",
			step: "delete_old_entry",
			retrySafe: false
		});
		yield* Effect.result(api.execute({ id: input.id }));
		expect(test.writes.filter((kind) => kind === "remove_string_table_entry")).toHaveLength(1);
	})
);

it.effect("retains an unverified deletion receipt and never reports completion", () =>
	Effect.gen(function* () {
		const test = setup();
		const api = yield* test.make;
		yield* api.prepare(input);
		test.verification("remove_string_table_entry");
		expect(yield* Effect.result(api.execute({ id: input.id }))).toMatchObject({
			_tag: "Failure"
		});
		expect(test.record()?.state).toMatchObject({ status: "failed", step: "delete_old_entry" });
		expect(test.record()?.outcomes.at(-1)).toMatchObject({
			step: "delete_old_entry",
			verified: false
		});
	})
);
