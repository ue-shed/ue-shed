import { resolve } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema, Stream } from "effect";
import { AssetReaderError, makeAssetReaderTestLayer } from "@ue-shed/unreal-assets";
import {
	RemoteControlClientError,
	makeRemoteControlClientTestLayer
} from "@ue-shed/unreal-connection";
import { GameTextActionsRequest, type GameTextActionsResult } from "@ue-shed/protocol";
import { makeGameTextIdRepairs } from "./workspace-id-repairs.js";
import { TextIdRepairRequest } from "./id-repair-schema.js";
import { makeTextUnitId } from "./identifiers.js";
import { textOccurrenceFromExtraction } from "./corpus.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import type { TextCorpusFocus } from "./schema.js";

// A rooted path on every platform, so artifact paths resolve the same on Windows and Linux.
const root = resolve("/Fixture").replaceAll("\\", "/");
const original = {
	source: "Keep the lamp lit",
	dev_notes: "",
	identity: { status: "resolved", namespace: "Notes", key: "Lamp" },
	location: {
		kind: "asset_property",
		object_path: "/Game/Notes.Notes",
		class_path: "/Script/Fixture.Notes",
		property_path: "Text"
	},
	edit_capability: "read_only"
} as const;
const occurrence = textOccurrenceFromExtraction({
	packageFile: "Content/Notes.uasset",
	occurrence: original
});
const unitId = makeTextUnitId("unit:lamp");
const focus: TextCorpusFocus = {
	occurrences: [occurrence],
	totalOccurrences: 1,
	diagnostics: [],
	unit: {
		id: unitId,
		source: { status: "consistent", value: original.source },
		identity: occurrence.identity,
		contexts: [],
		locationKinds: ["asset_property"],
		characterCount: 17,
		wordCount: 4,
		occurrenceCount: 1,
		remainingContextCount: 0,
		reviewSignals: []
	}
};
const request = TextIdRepairRequest.make({
	projectKey: root,
	title: "New key",
	changes: [
		{ unitId, occurrence, edit: { kind: "change_key", namespace: "Notes", key: "NewLamp" } }
	]
});

function setup(dataTable = false) {
	const extracted = dataTable
		? {
				...original,
				location: {
					kind: "data_table_cell" as const,
					object_path: "/Game/Notes.Notes",
					row: "Row",
					property_path: "Text"
				},
				edit_capability: "source_editable" as const
			}
		: original;
	const reviewed = textOccurrenceFromExtraction({
		packageFile: "Content/Notes.uasset",
		occurrence: extracted
	});
	const tableRequest = TextIdRepairRequest.make({
		...request,
		changes: [{ ...request.changes[0]!, occurrence: reviewed }]
	});
	const calls: string[] = [];
	const files = new Map<string, Uint8Array>();
	let currentRoot = root;
	let editorRoot = root;
	let session = "session-1";
	let mutations = 0;
	let savesFail = false;
	let focusValue = { ...focus, occurrences: [reviewed] };
	let readerFails = false;
	let readerRetrySafe = false;
	let lostReply = false;
	const native = makeRemoteControlClientTestLayer((call) =>
		Effect.gen(function* () {
			calls.push(call.functionName);
			if (call.functionName === "GetCapabilityManifest")
				return Schema.decodeUnknownSync(Schema.Json)({
					schemaVersion: 1,
					producerKind: "unreal_editor",
					capabilities: ["game-text.actions.v1", "game-text.actions.key-repairs.v1"],
					gameTextObjectPath: "/Script/UEShedGameText.Default__UEShedGameTextLibrary",
					identity: {
						engineVersion: "5.8",
						processId: 1,
						sessionId: session,
						plugins: []
					}
				});
			const input = Schema.decodeUnknownSync(Schema.fromJsonString(GameTextActionsRequest))(
				call.parameters.RequestJson
			);
			if (input.mode === "apply") mutations++;
			if (input.mode === "apply" && lostReply)
				return yield* new RemoteControlClientError({
					code: "request_timeout",
					endpoint: call.endpoint,
					functionName: call.functionName,
					operation: call.operation ?? "repair",
					message: "Reply lost",
					recovery: "Inspect Unreal",
					retrySafe: false,
					nextStep: "reconcile"
				});
			const result: GameTextActionsResult = {
				contract: input.contract,
				version: input.version,
				mode: input.mode,
				status: savesFail && input.mode === "apply" ? "failed" : "ok",
				rolledBack: false,
				actions: input.actions.map((action) => ({
					id: action.id,
					place: action.place,
					before: action.expected,
					after: { namespace: "Notes", key: "NewLamp", source: original.source },
					status: input.mode === "apply" ? "applied" : "planned"
				})),
				packages: [
					{
						packageName: "/Game/Notes",
						packageFile: `${root}/Content/Notes.uasset`,
						saved: input.mode === "apply" && !savesFail,
						persistence: input.mode === "apply" && !savesFail ? "saved" : "unsaved"
					}
				],
				blueprints: [],
				errors:
					savesFail && input.mode === "apply"
						? [
								{
									code: "save_failed",
									message: "Read only",
									recovery: "Save in Unreal",
									retrySafe: false,
									nextStep: "reconcile"
								}
							]
						: []
			};
			return Schema.decodeUnknownSync(Schema.Json)(result);
		})
	);
	const unused = () => Effect.die("Unexpected reader operation");
	const reader = makeAssetReaderTestLayer({
		configuration: unused,
		discoverAssets: unused,
		discoverTables: unused,
		extractProjectText: () => Stream.die("Unused"),
		extractProjectTextures: () => Stream.die("Unused"),
		readAsset: unused,
		readBlueprint: unused,
		readLevelSequence: unused,
		readTable: unused,
		readSavedWorld: unused,
		scanProject: unused,
		scanProgress: unused,
		savedWorldProgress: unused,
		source: unused,
		extractProjectTextPackages: () =>
			readerFails
				? Stream.fail(
						new AssetReaderError({
							kind: "process",
							operation: "extract_text_packages",
							message: "Reader failed",
							recovery: "Inspect the saved receipt",
							retrySafe: readerRetrySafe,
							nextStep: readerRetrySafe ? "retry" : "reconcile"
						})
					)
				: Stream.make({
						...emptyPackageTextRecord(`${root}/Content/Notes.uasset`),
						occurrences: [
							{
								...extracted,
								identity: { status: "resolved", namespace: "Notes", key: "NewLamp" }
							}
						]
					})
	});
	const make = makeGameTextIdRepairs({
		workspace: {
			focus: () => Effect.succeed({ status: "found", focus: focusValue }),
			beginOperation: () => Effect.succeed(true),
			endOperation: () => Effect.void
		},
		current: () => Effect.succeed({ status: "ready", project: { projectRoot: currentRoot } }),
		endpoint: () => Effect.succeed("http://127.0.0.1:30010"),
		editorProject: () => Effect.succeed(editorRoot),
		files: {
			readFileWithin: (directory, path) =>
				Effect.try({
					try: () => {
						const bytes = files.get(`${directory}/${path}`.replaceAll("\\", "/"));
						if (!bytes) throw new Error("Missing artifact");
						return bytes;
					},
					catch: () => ({
						message: "Missing artifact",
						recovery: "Choose the original project and review again."
					})
				}),
			writeFile: (path, bytes, options) =>
				Effect.try({
					try: () => {
						const key = path.replaceAll("\\", "/");
						if (options?.exclusive && files.has(key)) throw new Error("Already exists");
						files.set(key, bytes);
					},
					catch: () => ({
						message: "Already claimed",
						recovery: "Inspect the saved receipt."
					})
				})
		}
	}).pipe(Effect.provide(native), Effect.provide(reader));
	return {
		make,
		calls,
		tableRequest,
		files,
		mutations: () => mutations,
		project: (value: string) => {
			currentRoot = value;
		},
		editor: (value: string) => {
			editorRoot = value;
		},
		session: (value: string) => {
			session = value;
		},
		stale: () => {
			focusValue = { ...focus, occurrences: [] };
		},
		saveFails: () => {
			savesFail = true;
		},
		failReader: (retrySafe = false) => {
			readerFails = true;
			readerRetrySafe = retrySafe;
		},
		loseReply: () => {
			lostReply = true;
		}
	};
}

it.effect(
	"prepares without mutation, verifies saved files and prevents replay across service restart",
	() =>
		Effect.gen(function* () {
			const test = setup();
			const service = yield* test.make;
			const preview = yield* service.prepare(request);
			expect(preview.status).toBe("prepared");
			expect(test.mutations()).toBe(0);
			if (preview.status !== "prepared") return;
			expect(test.files.size).toBe(1);
			const result = yield* service.apply(preview.plan.id);
			expect(result).toMatchObject({ status: "finished", verified: true });
			const restarted = yield* test.make;
			expect(yield* restarted.apply(preview.plan.id)).toMatchObject({
				status: "unavailable",
				nextStep: "reconcile"
			});
			expect(test.mutations()).toBe(1);
		})
);

it.effect("refuses a proposal claimed by another process before any mutation", () =>
	Effect.gen(function* () {
		const test = setup();
		const first = yield* test.make;
		const preview = yield* first.prepare(request);
		if (preview.status !== "prepared") throw new Error(JSON.stringify(preview));
		test.files.set(
			`${root}/Saved/UEShed/GameTextActions/${preview.plan.id}.started.json`,
			new Uint8Array()
		);
		const second = yield* test.make;
		expect(yield* second.apply(preview.plan.id)).toMatchObject({
			status: "unavailable",
			nextStep: "reconcile"
		});
		expect(test.mutations()).toBe(0);
	})
);

it.effect(
	"retains mutation outcomes when verification fails, and does not replay a lost reply",
	() =>
		Effect.gen(function* () {
			// A retry-safe re-read after the save still leaves the claimed repair to reconcile.
			for (const kind of ["reader", "retry-safe reader", "reply"] as const) {
				const test = setup();
				const service = yield* test.make;
				const preview = yield* service.prepare(request);
				if (preview.status !== "prepared") throw new Error(JSON.stringify(preview));
				if (kind === "reply") test.loseReply();
				else test.failReader(kind === "retry-safe reader");
				expect(yield* service.apply(preview.plan.id)).toMatchObject({
					status: "unavailable",
					retrySafe: false,
					nextStep: "reconcile"
				});
				const receiptBytes = test.files.get(`${root}/${preview.plan.artifact}`);
				expect(receiptBytes).toBeDefined();
				if (!receiptBytes) return;
				const receipt = new TextDecoder().decode(receiptBytes);
				expect(receipt).toContain(
					kind === "reply" ? '"state":"started"' : '"state":"finished"'
				);
				if (kind !== "reply") expect(receipt).toContain('"status":"applied"');
				const restarted = yield* test.make;
				expect((yield* restarted.apply(preview.plan.id)).status).toBe("unavailable");
				expect(test.mutations()).toBe(1);
			}
		})
);

it.effect("refuses changed selected projects, editor projects, sessions and stale places", () =>
	Effect.gen(function* () {
		for (const kind of ["project", "editor", "session", "stale"] as const) {
			const test = setup();
			const service = yield* test.make;
			const preview = yield* service.prepare(request);
			if (preview.status !== "prepared") throw new Error(JSON.stringify(preview));
			if (kind === "stale") test.stale();
			else test[kind]("different");
			const result = yield* service.apply(preview.plan.id);
			expect(result.status).toBe("unavailable");
			// Refusals before any mutation keep their own guidance instead of demanding reconciliation.
			if (kind === "editor" || kind === "stale")
				expect(result).toMatchObject({ retrySafe: true, nextStep: "fix_input" });
			expect(test.mutations()).toBe(0);
		}
	})
);

it.effect("retains live applied outcomes after save failure and never replays them", () =>
	Effect.gen(function* () {
		const test = setup();
		const service = yield* test.make;
		const preview = yield* service.prepare(request);
		if (preview.status !== "prepared") throw new Error(JSON.stringify(preview));
		test.saveFails();
		const result = yield* service.apply(preview.plan.id);
		expect(result).toMatchObject({
			status: "finished",
			verified: false,
			result: {
				status: "failed",
				actions: [{ status: "applied" }],
				packages: [{ persistence: "unsaved" }]
			}
		});
		expect((yield* service.apply(preview.plan.id)).status).toBe("unavailable");
		expect(test.mutations()).toBe(1);
	})
);

it.effect("rejects duplicate or forged occurrences before any editor mutation", () =>
	Effect.gen(function* () {
		const test = setup();
		const service = yield* test.make;
		expect(
			(yield* service.prepare({
				...request,
				changes: [...request.changes, ...request.changes]
			})).status
		).toBe("unavailable");
		expect(
			(yield* service.prepare({
				...request,
				changes: request.changes.map((change) => ({
					...change,
					occurrence: {
						...change.occurrence,
						packageFile: "../Other/Content/Notes.uasset"
					}
				}))
			})).status
		).toBe("unavailable");
		expect(test.mutations()).toBe(0);
	})
);

it.effect("repairs simple DataTable cells through Game Text when Authoring is absent", () =>
	Effect.gen(function* () {
		const test = setup(true);
		const service = yield* test.make;
		const preview = yield* service.prepare(test.tableRequest);
		expect(preview.status).toBe("prepared");
		if (preview.status !== "prepared") throw new Error(JSON.stringify(preview));
		expect(preview.plan.authoring).toBeUndefined();
		expect(preview.plan.preview.actions[0]?.place.selector).toEqual({
			kind: "data_table_cell",
			row: "Row"
		});
		expect(yield* service.apply(preview.plan.id)).toMatchObject({
			status: "finished",
			verified: true
		});
		expect(test.mutations()).toBe(1);
		expect(
			test.calls.every((name) => ["GetCapabilityManifest", "ApplyTextActions"].includes(name))
		).toBe(true);
		expect(
			new TextDecoder().decode(test.files.get(`${root}/${preview.plan.artifact}`))
		).toContain('"state":"finished"');
	})
);

it.effect("DataTable fallback retains stale-place and saved-verification refusals", () =>
	Effect.gen(function* () {
		for (const kind of ["stale", "save", "reader"] as const) {
			const test = setup(true);
			const service = yield* test.make;
			const preview = yield* service.prepare(test.tableRequest);
			if (preview.status !== "prepared") throw new Error(JSON.stringify(preview));
			if (kind === "stale") test.stale();
			else if (kind === "save") test.saveFails();
			else test.failReader();
			const result = yield* service.apply(preview.plan.id);
			if (kind === "save")
				expect(result).toMatchObject({ status: "finished", verified: false });
			else expect(result.status).toBe("unavailable");
			expect(test.mutations()).toBe(kind === "stale" ? 0 : 1);
		}
	})
);
