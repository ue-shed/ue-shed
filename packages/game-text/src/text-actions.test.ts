import type { GameTextActionsResult } from "@ue-shed/protocol";
import type { RemoteControlRequest } from "@ue-shed/unreal-connection";
import type { SavedAssetTextOccurrence } from "@ue-shed/unreal-assets";
import {
	RemoteControlClientError,
	makeRemoteControlClientTestLayer
} from "@ue-shed/unreal-connection";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { emptyPackageTextRecord } from "./package-text-record.js";
import {
	GameTextActionsError,
	gameTextActionForOccurrence,
	gameTextActionsRequest,
	runGameTextActions,
	verifyGameTextActions
} from "./text-actions.js";

const ENDPOINT = "http://127.0.0.1:30010";
const GAME_TEXT = "/Script/UEShedGameText.Default__UEShedGameTextLibrary";
const PATH = "/Game/Notes/DA_Notes.DA_Notes";
const FILE = "Content/Notes/DA_Notes.uasset";
const PLACE = { packageFile: FILE, objectPath: PATH, propertyPath: "SharedPrimary" };

const occurrence: SavedAssetTextOccurrence = {
	source: "Keep the lamp lit",
	dev_notes: "",
	identity: { status: "resolved", namespace: "[0F4DFA4AF5E088DC23B0099F63656165]", key: "A1" },
	location: {
		kind: "asset_property",
		object_path: PATH,
		class_path: "/Script/Game.Notes",
		property_path: "SharedPrimary"
	},
	edit_capability: "source_editable"
};

function manifest(capabilities: readonly string[], gameTextObjectPath?: string): object {
	const base = { schemaVersion: 1, producerKind: "unreal_editor", capabilities };
	return gameTextObjectPath === undefined ? base : { ...base, gameTextObjectPath };
}

const applied: GameTextActionsResult = {
	contract: "ue-shed-game-text-actions",
	version: "1.0",
	mode: "apply",
	status: "ok",
	rolledBack: false,
	actions: [
		{
			id: "notes",
			place: PLACE,
			status: "applied",
			before: { namespace: "", key: "A1", source: "Keep the lamp lit" },
			after: { namespace: "Notes", key: "Lamp", source: "Keep the lamp lit" }
		}
	],
	blueprints: [],
	packages: [
		{
			packageName: "/Game/Notes/DA_Notes",
			packageFile: FILE,
			saved: true,
			persistence: "saved"
		}
	],
	errors: []
};

function request() {
	const action = gameTextActionForOccurrence(
		"notes",
		occurrence,
		{
			kind: "change_key",
			namespace: "Notes",
			key: "Lamp"
		},
		FILE
	);
	if (!action) throw new Error("Expected an editable occurrence.");
	return gameTextActionsRequest({ mode: "apply", save: true, actions: [action] });
}

function run(handle: (request: RemoteControlRequest) => object, input = request()) {
	const calls: RemoteControlRequest[] = [];
	return Effect.runPromiseExit(
		runGameTextActions({ endpoint: `${ENDPOINT}/`, request: input }).pipe(
			Effect.provide(
				makeRemoteControlClientTestLayer((call) => {
					calls.push(call);
					return Effect.sync(() => Schema.decodeUnknownSync(Schema.Json)(handle(call)));
				})
			)
		)
	).then((exit) => ({ exit, calls }));
}

function failure(exit: Exit.Exit<unknown, GameTextActionsError>) {
	if (Exit.isSuccess(exit)) throw new Error("Expected a failure.");
	const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
	if (!error || error._tag !== "Fail") throw new Error("Expected a typed failure.");
	return error.error;
}

describe("Game Text actions API", () => {
	it("builds an action from a reader occurrence, expecting what the reader saw", () => {
		expect(request().actions[0]).toEqual({
			id: "notes",
			place: PLACE,
			expected: { namespace: "", key: "A1", source: "Keep the lamp lit" },
			edit: { kind: "change_key", namespace: "Notes", key: "Lamp" }
		});
		expect(request()).toMatchObject({
			contract: "ue-shed-game-text-actions",
			version: "1.0",
			mode: "apply",
			save: true
		});
		const invariant: SavedAssetTextOccurrence = {
			...occurrence,
			identity: { status: "unresolved", reason: "culture_invariant" }
		};
		const cell: SavedAssetTextOccurrence = {
			...occurrence,
			location: {
				kind: "data_table_cell",
				object_path: PATH,
				row: "Lantern",
				property_path: "Name"
			}
		};
		for (const text of [invariant, cell])
			expect(
				gameTextActionForOccurrence("x", text, { kind: "regenerate_key" }, FILE)
			).toBeUndefined();
	});

	it("checks the capability, then sends the request to the advertised library", async () => {
		const { exit, calls } = await run((call) =>
			call.functionName === "GetCapabilityManifest"
				? manifest(["game-text.actions.v1"], GAME_TEXT)
				: applied
		);
		expect(Exit.isSuccess(exit) && exit.value).toEqual(applied);
		expect(calls.map((call) => [call.endpoint, call.objectPath, call.functionName])).toEqual([
			[ENDPOINT, "/Script/UEShedCore.Default__UEShedCoreLibrary", "GetCapabilityManifest"],
			[ENDPOINT, GAME_TEXT, "ApplyTextActions"]
		]);
		expect(JSON.parse(String(calls[1]?.parameters.RequestJson))).toEqual(request());
	});

	it("returns a rejected request as a result with typed errors, not a failure", async () => {
		const rejected: GameTextActionsResult = {
			...applied,
			status: "rejected",
			actions: [],
			packages: [],
			errors: [
				{
					code: "stale_expected",
					actionId: "notes",
					message: "Changed since review.",
					recovery: "Rescan.",
					retrySafe: false,
					nextStep: "reconcile"
				}
			]
		};
		const { exit } = await run((call) =>
			call.functionName === "GetCapabilityManifest"
				? manifest(["game-text.actions.v1"], GAME_TEXT)
				: rejected
		);
		expect(Exit.isSuccess(exit) && exit.value.errors[0]?.code).toBe("stale_expected");
	});

	it("fails without calling the plugin when the editor does not advertise it", async () => {
		const { exit, calls } = await run(() => manifest(["authoring.apply.v1"]));
		expect(failure(exit)).toMatchObject({ code: "capability_missing", nextStep: "fix_input" });
		expect(calls).toHaveLength(1);
	});

	it("rejects an invalid request before connecting", async () => {
		const { exit, calls } = await run(() => manifest([]), {
			...request(),
			actions: []
		});
		expect(failure(exit)).toMatchObject({ code: "invalid_request", retrySafe: false });
		expect(calls).toEqual([]);
	});

	it("reports a malformed result as invalid, asking to read the text again", async () => {
		const { exit } = await run((call) =>
			call.functionName === "GetCapabilityManifest"
				? manifest(["game-text.actions.v1"], GAME_TEXT)
				: { status: "ok" }
		);
		expect(failure(exit)).toMatchObject({ code: "invalid_result", nextStep: "reconcile" });
	});

	it("keeps a transport failure's retry safety", async () => {
		const exit = await Effect.runPromiseExit(
			runGameTextActions({ endpoint: ENDPOINT, request: request() }).pipe(
				Effect.provide(
					makeRemoteControlClientTestLayer((call) =>
						Effect.fail(
							new RemoteControlClientError({
								code: "transport_failed",
								recovery: "Inspect editor state before retrying.",
								nextStep: "reconcile",
								endpoint: call.endpoint,
								functionName: call.functionName,
								message: "connect ECONNREFUSED",
								operation: call.operation ?? "call",
								retrySafe: true
							})
						)
					)
				)
			)
		);
		expect(failure(exit)).toBeInstanceOf(GameTextActionsError);
		expect(failure(exit)).toMatchObject({ code: "connection_failed", nextStep: "retry" });
	});

	it("verifies applied actions against the re-read packages", () => {
		const record = (occurrences: readonly SavedAssetTextOccurrence[]) => ({
			...emptyPackageTextRecord("Content/Notes/DA_Notes.uasset"),
			occurrences
		});
		const rekeyed: SavedAssetTextOccurrence = {
			...occurrence,
			identity: {
				status: "resolved",
				namespace: "Notes [0F4DFA4AF5E088DC23B0099F63656165]",
				key: "Lamp"
			}
		};
		expect(verifyGameTextActions(request(), applied, [record([rekeyed])])).toEqual({
			verified: 1,
			mismatches: [],
			complete: true
		});
		// A 4.27 package names its objects relative to the package; the place still matches.
		const relative: SavedAssetTextOccurrence = {
			...rekeyed,
			location: { ...rekeyed.location, object_path: "DA_Notes" }
		};
		expect(verifyGameTextActions(request(), applied, [record([relative])]).verified).toBe(1);
		// The same relative or mounted path in a branch copy is another package.
		const branch = { ...record([relative]), path: "Content/Branched/Notes/DA_Notes.uasset" };
		expect(verifyGameTextActions(request(), applied, [branch]).verified).toBe(0);
		const branchMounted: SavedAssetTextOccurrence = {
			...rekeyed,
			location: { ...rekeyed.location, object_path: "/Game/Branched/Notes/DA_Notes.DA_Notes" }
		};
		expect(verifyGameTextActions(request(), applied, [record([branchMounted])]).verified).toBe(
			1
		);
		const copiedOriginalPath = {
			...record([rekeyed]),
			path: "Content/Branched/Notes/DA_Notes.uasset"
		};
		expect(verifyGameTextActions(request(), applied, [copiedOriginalPath]).verified).toBe(0);
		expect(verifyGameTextActions(request(), applied, [record([occurrence])])).toEqual({
			verified: 0,
			mismatches: [
				{
					actionId: "notes",
					expected: applied.actions[0]?.after,
					found: { namespace: "", key: "A1", source: "Keep the lamp lit" }
				}
			],
			complete: true
		});
		expect(verifyGameTextActions(request(), applied, [record([])]).mismatches).toEqual([
			{ actionId: "notes", expected: applied.actions[0]?.after }
		]);
	});
});

describe("Game Text mutation recovery", () => {
	it("requires reconciliation when an apply reply is lost, even if the transport suggests retry", async () => {
		const calls: string[] = [];
		const exit = await Effect.runPromiseExit(
			runGameTextActions({ endpoint: ENDPOINT, request: request() }).pipe(
				Effect.provide(
					makeRemoteControlClientTestLayer((call) => {
						calls.push(call.functionName);
						if (call.functionName === "GetCapabilityManifest")
							return Effect.succeed(
								Schema.decodeUnknownSync(Schema.Json)(
									manifest(["game-text.actions.v1"], GAME_TEXT)
								)
							);
						return Effect.fail(
							new RemoteControlClientError({
								code: "transport_failed",
								recovery: "Inspect editor state before retrying.",
								nextStep: "reconcile",
								endpoint: call.endpoint,
								functionName: call.functionName,
								message: "reply timed out after mutation",
								operation: call.operation ?? "call",
								retrySafe: true
							})
						);
					})
				)
			)
		);
		expect(calls).toEqual(["GetCapabilityManifest", "ApplyTextActions"]);
		expect(failure(exit)).toMatchObject({ retrySafe: false, nextStep: "reconcile" });
	});

	it("verifies persisted edits from a failed partially saved batch", () => {
		const partial: GameTextActionsResult = {
			...applied,
			status: "failed",
			packages: [
				...applied.packages,
				{
					packageName: "/Game/ReadOnly",
					packageFile: "Content/ReadOnly.uasset",
					saved: false,
					persistence: "unsaved"
				}
			],
			errors: [
				{
					code: "save_failed",
					message: "Read-only file",
					recovery: "Reconcile before saving.",
					retrySafe: false,
					nextStep: "reconcile"
				}
			]
		};
		const record = {
			...emptyPackageTextRecord(FILE),
			occurrences: [
				{
					...occurrence,
					identity: { status: "resolved", namespace: "Notes", key: "Lamp" }
				} satisfies SavedAssetTextOccurrence
			]
		};
		expect(verifyGameTextActions(request(), partial, [record])).toMatchObject({
			verified: 1,
			mismatches: []
		});
	});
});
