import { it } from "@effect/vitest";
import {
	makeRemoteControlClientTestLayer,
	RemoteControlClientError,
	type RemoteControlRequest
} from "@ue-shed/unreal-connection";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import {
	EditorForegroundResponsiveness,
	EditorForegroundResponsivenessLive
} from "./editor-foreground-responsiveness.js";

const endpoint = "http://127.0.0.1:30010";
const objectPath = "/Script/UEShedCoreEditor.Default__UEShedEditorResponsivenessLibrary";

/** A stand-in for UEShedCoreEditor's lease table; tests flip its behaviour mid-run. */
interface FakeEditor {
	processId: number;
	capability: boolean;
	down: boolean;
	leases: Map<string, number>;
	nextLease: number;
	calls: string[];
	acquireResult?: Schema.JsonObject;
}

function fakeEditor() {
	const calls: string[] = [];
	const editor: FakeEditor = {
		processId: 42,
		capability: true,
		down: false,
		leases: new Map<string, number>(),
		nextLease: 0,
		calls
	};
	const result = (status: string, fields: Schema.JsonObject): Schema.JsonObject => ({
		status,
		schemaVersion: 1,
		processId: editor.processId,
		message: "",
		recovery: "",
		...fields
	});
	const handle = (request: RemoteControlRequest) => {
		if (editor.down)
			return Effect.fail(
				new RemoteControlClientError({
					endpoint: request.endpoint,
					functionName: request.functionName,
					message: "connect ECONNREFUSED",
					operation: request.operation ?? "",
					retrySafe: true
				})
			);
		if (request.functionName === "GetCapabilityManifest") {
			editor.calls.push("manifest");
			return Effect.succeed({
				schemaVersion: 1,
				producerKind: "unreal_editor",
				capabilities: editor.capability ? ["editor.foreground-responsiveness.v1"] : [],
				foregroundResponsivenessObjectPath: objectPath,
				identity: {
					engineVersion: "5.8",
					processId: editor.processId,
					sessionId: "fixture",
					plugins: []
				}
			});
		}
		expect(request.objectPath).toBe(objectPath);
		const body = JSON.parse(String(request.parameters.RequestJson));
		if (request.functionName === "GetForegroundResponsivenessState") {
			editor.calls.push("state");
			return Effect.succeed(
				result("reported", {
					registered: true,
					activeLeases: editor.leases.size,
					maxLeases: 8,
					exemptionActive: false,
					editorThrottling: true,
					throttleWhenNotForeground: true,
					minTtlMs: 2000,
					defaultTtlMs: 5000,
					maxTtlMs: 30000
				})
			);
		}
		editor.calls.push(body.operation);
		expect(body.clientProcessId).toBe(7);
		if (body.expectedProcessId !== editor.processId)
			return Effect.succeed(result("rejected", { reason: "target_changed" }));
		if (body.operation === "acquire") {
			if (editor.acquireResult)
				return Effect.succeed(result("rejected", editor.acquireResult));
			const leaseId = (++editor.nextLease).toString(16).padStart(32, "0");
			editor.leases.set(leaseId, body.clientProcessId);
			return Effect.succeed(
				result("granted", { activeLeases: editor.leases.size, leaseId, ttlMs: body.ttlMs })
			);
		}
		if (body.operation === "renew")
			return Effect.succeed(
				editor.leases.has(body.leaseId)
					? result("renewed", {
							activeLeases: editor.leases.size,
							leaseId: body.leaseId,
							ttlMs: body.ttlMs
						})
					: result("expired", {
							activeLeases: editor.leases.size,
							leaseId: body.leaseId,
							reason: "lease_ended"
						})
			);
		editor.leases.delete(body.leaseId);
		return Effect.succeed(
			result("released", { activeLeases: editor.leases.size, leaseId: body.leaseId })
		);
	};
	const layer = EditorForegroundResponsivenessLive.pipe(
		Layer.provide(makeRemoteControlClientTestLayer(handle))
	);
	return { editor, layer };
}

const hold = (target = endpoint, ttlMs = 3_000) =>
	Effect.flatMap(EditorForegroundResponsiveness, (service) =>
		service.hold({ endpoint: target, clientProcessId: 7, ttlMs })
	);

describe("EditorForegroundResponsiveness", () => {
	it.effect("renews at a third of the TTL and releases when the scope closes", () => {
		const { editor, layer } = fakeEditor();
		return Effect.gen(function* () {
			const scope = yield* Scope.make();
			const lease = yield* hold().pipe(Scope.provide(scope));
			expect((yield* lease.state)._tag).toBe("Held");
			expect(editor.calls).toEqual(["manifest", "acquire"]);
			yield* TestClock.adjust(999);
			expect(editor.calls).toEqual(["manifest", "acquire"]);
			yield* TestClock.adjust(1);
			yield* TestClock.adjust(2_000);
			expect(editor.calls).toEqual(["manifest", "acquire", "renew", "renew", "renew"]);
			yield* Scope.close(scope, Exit.void);
			expect(editor.calls.at(-1)).toBe("release");
			expect(editor.leases.size).toBe(0);
			expect((yield* lease.state)._tag).toBe("Released");
			yield* TestClock.adjust(10_000);
			expect(editor.calls.at(-1)).toBe("release");
		}).pipe(Effect.provide(layer));
	});

	it.effect("acquires again when the editor reports the lease ended", () => {
		const { editor, layer } = fakeEditor();
		return Effect.scoped(
			Effect.gen(function* () {
				const lease = yield* hold();
				editor.leases.clear();
				yield* TestClock.adjust(1_000);
				const state = yield* lease.state;
				expect(state._tag === "Held" && state.leaseId).toBe("2".padStart(32, "0"));
				expect(editor.calls).toEqual([
					"manifest",
					"acquire",
					"renew",
					"manifest",
					"acquire"
				]);
			})
		).pipe(Effect.provide(layer));
	});

	it.effect("follows a restarted editor to its new process", () => {
		const { editor, layer } = fakeEditor();
		return Effect.scoped(
			Effect.gen(function* () {
				const lease = yield* hold();
				editor.processId = 43;
				yield* TestClock.adjust(1_000);
				const state = yield* lease.state;
				expect(state._tag === "Held" && state.editorProcessId).toBe(43);
			})
		).pipe(Effect.provide(layer));
	});

	it.effect("lapses quietly after failed renewals outlast the TTL, then recovers", () => {
		const { editor, layer } = fakeEditor();
		return Effect.scoped(
			Effect.gen(function* () {
				const lease = yield* hold();
				editor.down = true;
				yield* TestClock.adjust(1_000);
				expect((yield* lease.state)._tag).toBe("Held");
				// Retries back off (1 s, 2 s): the third failure is past the 3 s TTL.
				yield* TestClock.adjust(3_000);
				const lapsed = yield* lease.state;
				expect(lapsed._tag).toBe("Lapsed");
				expect(lapsed._tag === "Lapsed" && lapsed.failures).toBeGreaterThanOrEqual(3);
				editor.down = false;
				editor.leases.clear();
				yield* TestClock.adjust(30_000);
				expect((yield* lease.state)._tag).toBe("Held");
			})
		).pipe(Effect.provide(layer));
	});

	it.effect("refuses a remote endpoint without sending anything", () => {
		const { editor, layer } = fakeEditor();
		return Effect.scoped(
			Effect.gen(function* () {
				const error = yield* hold("http://editor.example:30010").pipe(Effect.flip);
				expect(error.reason).toBe("remote_endpoint");
				expect(error.retryable).toBe(false);
				const stateError = yield* Effect.flatMap(
					EditorForegroundResponsiveness,
					(service) => service.state("http://10.0.0.5:30010")
				).pipe(Effect.flip);
				expect(stateError.reason).toBe("remote_endpoint");
				expect(editor.calls).toEqual([]);
			})
		).pipe(Effect.provide(layer));
	});

	it.effect("fails typed when the editor lacks the capability", () => {
		const { editor, layer } = fakeEditor();
		editor.capability = false;
		return Effect.scoped(
			Effect.gen(function* () {
				const error = yield* hold().pipe(Effect.flip);
				expect(error._tag).toBe("EditorForegroundResponsivenessError");
				expect(error.reason).toBe("capability_missing");
				expect(error.recovery).toMatch(/Update UE Shed Core/);
				expect(editor.calls).toEqual(["manifest"]);
			})
		).pipe(Effect.provide(layer));
	});

	it.effect("fails typed with the editor's reason when it refuses the lease", () => {
		const { editor, layer } = fakeEditor();
		editor.acquireResult = {
			reason: "lease_limit",
			message: "This editor already holds the maximum number of leases."
		};
		return Effect.scoped(
			Effect.gen(function* () {
				const error = yield* hold().pipe(Effect.flip);
				expect(error.reason).toBe("rejected");
				expect(error.retryable).toBe(true);
				expect(error.message).toMatch(/lease_limit/);
			})
		).pipe(Effect.provide(layer));
	});

	it.effect("fails typed when the editor is not reachable", () => {
		const { editor, layer } = fakeEditor();
		editor.down = true;
		return Effect.scoped(
			Effect.gen(function* () {
				const error = yield* hold().pipe(Effect.flip);
				expect(error.reason).toBe("transport");
				expect(error.retryable).toBe(true);
			})
		).pipe(Effect.provide(layer));
	});

	it.effect("reports the editor's diagnostic state", () => {
		const { layer } = fakeEditor();
		return Effect.gen(function* () {
			const state = yield* Effect.flatMap(EditorForegroundResponsiveness, (service) =>
				service.state(endpoint)
			);
			expect(state.status === "reported" && state.throttleWhenNotForeground).toBe(true);
		}).pipe(Effect.provide(layer));
	});
});
