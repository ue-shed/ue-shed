import { it } from "@effect/vitest";
import { EditorForegroundLeaseId } from "@ue-shed/protocol";
import {
	EditorForegroundResponsiveness,
	EditorForegroundResponsivenessError,
	type EditorForegroundResponsivenessFailure
} from "@ue-shed/engine";
import { Effect, Exit, Layer, Ref, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import {
	WorkbenchEditorResponsiveness,
	makeEditorResponsivenessPreferenceTestStore,
	makeWorkbenchEditorResponsivenessLayer
} from "./editor-responsiveness.js";
import {
	WorkbenchUnrealConnection,
	makeWorkbenchUnrealConnectionLayer
} from "./unreal-connection.js";

const local = "http://127.0.0.1:30001";
const leaseId = Schema.decodeUnknownSync(EditorForegroundLeaseId)("0".repeat(32));

/** Records the engine calls; `failWith` makes the next holds fail with that reason. */
function fakeEngine() {
	return Effect.map(
		Ref.make<{ log: string[]; failWith?: EditorForegroundResponsivenessFailure }>({ log: [] }),
		(state) => ({
			log: Effect.map(Ref.get(state), (current) => current.log),
			failWith: (reason?: EditorForegroundResponsivenessFailure) =>
				Ref.update(state, (current) =>
					reason ? { ...current, failWith: reason } : { log: current.log }
				),
			layer: Layer.succeed(EditorForegroundResponsiveness, {
				hold: ({ endpoint, clientProcessId }) =>
					Effect.gen(function* () {
						const current = yield* Ref.get(state);
						yield* Ref.set(state, {
							...current,
							log: [...current.log, `hold:${endpoint}:${clientProcessId}`]
						});
						if (current.failWith)
							return yield* new EditorForegroundResponsivenessError({
								endpoint,
								operation: "acquire",
								reason: current.failWith,
								retryable: current.failWith === "transport",
								message: "The editor said no.",
								recovery: "Update UE Shed Core."
							});
						yield* Effect.addFinalizer(() =>
							Ref.update(state, (value) => ({
								...value,
								log: [...value.log, `release:${endpoint}`]
							}))
						);
						return {
							state: Effect.succeed({
								_tag: "Held" as const,
								editorProcessId: 42,
								leaseId,
								ttlMs: 5000
							})
						};
					}),
				state: () => Effect.die("unused")
			})
		})
	);
}

function exercise(options: { initial?: boolean; platform?: NodeJS.Platform } = {}) {
	return Effect.gen(function* () {
		const engine = yield* fakeEngine();
		const preference = yield* makeEditorResponsivenessPreferenceTestStore(options.initial);
		const scope = yield* Scope.make();
		yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
		const context = yield* Layer.buildWithScope(
			makeWorkbenchEditorResponsivenessLayer({
				clientProcessId: 7,
				platform: options.platform ?? "win32",
				store: preference.store
			}).pipe(
				Layer.provideMerge(
					Layer.merge(engine.layer, makeWorkbenchUnrealConnectionLayer(local))
				)
			),
			scope
		);
		const service = Effect.provide(WorkbenchEditorResponsiveness, context);
		const connection = Effect.provide(WorkbenchUnrealConnection, context);
		// Let the forked supervisor run its first reconcile.
		yield* TestClock.adjust(0);
		return { engine, preference, scope, service, connection };
	});
}

describe("WorkbenchEditorResponsiveness", () => {
	it.effect(
		"holds one lease for the main process while on, and releases it when turned off",
		() =>
			Effect.gen(function* () {
				const { engine, preference, service } = yield* exercise();
				const responsiveness = yield* service;
				expect(yield* engine.log).toEqual([`hold:${local}:7`]);
				expect(yield* responsiveness.settings()).toMatchObject({
					enabled: true,
					state: "active"
				});
				yield* TestClock.adjust(10_000);
				expect(yield* engine.log).toEqual([`hold:${local}:7`]);

				expect(yield* responsiveness.setEnabled(false)).toMatchObject({
					enabled: false,
					state: "off"
				});
				expect(yield* engine.log).toEqual([`hold:${local}:7`, `release:${local}`]);
				expect(yield* preference.saved).toBe(false);
				yield* TestClock.adjust(10_000);
				expect((yield* engine.log).length).toBe(2);

				yield* responsiveness.setEnabled(true);
				expect((yield* engine.log).at(-1)).toBe(`hold:${local}:7`);
			})
	);

	it.effect("does nothing when the saved preference is off", () =>
		Effect.gen(function* () {
			const { engine, service } = yield* exercise({ initial: false });
			yield* TestClock.adjust(10_000);
			expect(yield* engine.log).toEqual([]);
			expect(yield* (yield* service).settings()).toMatchObject({ state: "off" });
		})
	);

	it.effect("moves the lease when the selected endpoint changes", () =>
		Effect.gen(function* () {
			const { engine, connection } = yield* exercise();
			const next = (yield* (yield* connection).setPort(31001)).endpoint;
			yield* TestClock.adjust(1_000);
			expect(yield* engine.log).toEqual([
				`hold:${local}:7`,
				`release:${local}`,
				`hold:${next}:7`
			]);
		})
	);

	it.effect("never sends anything for a remote endpoint", () =>
		Effect.gen(function* () {
			const engine = yield* fakeEngine();
			const preference = yield* makeEditorResponsivenessPreferenceTestStore();
			const settings = yield* Effect.gen(function* () {
				yield* TestClock.adjust(5_000);
				return yield* (yield* WorkbenchEditorResponsiveness).settings();
			}).pipe(
				Effect.provide(
					makeWorkbenchEditorResponsivenessLayer({
						clientProcessId: 7,
						platform: "win32",
						store: preference.store
					}).pipe(
						Layer.provide(
							Layer.merge(
								engine.layer,
								makeWorkbenchUnrealConnectionLayer("http://editor.example:30001")
							)
						)
					)
				)
			);
			expect(settings).toMatchObject({ enabled: true, state: "remote" });
			expect(yield* engine.log).toEqual([]);
		})
	);

	it.effect("is unsupported off Windows without contacting the editor", () =>
		Effect.gen(function* () {
			const { engine, service } = yield* exercise({ platform: "darwin" });
			expect(yield* (yield* service).settings()).toMatchObject({ state: "unsupported" });
			expect(yield* engine.log).toEqual([]);
		})
	);

	it.effect("retries an unreachable editor with backoff, then holds", () =>
		Effect.gen(function* () {
			const engine = yield* fakeEngine();
			yield* engine.failWith("transport");
			const preference = yield* makeEditorResponsivenessPreferenceTestStore();
			yield* Effect.gen(function* () {
				const responsiveness = yield* WorkbenchEditorResponsiveness;
				yield* TestClock.adjust(0);
				expect(yield* responsiveness.settings()).toMatchObject({ state: "connecting" });
				// Backoff 1 s, 2 s, 4 s: four attempts in the first seven seconds.
				yield* TestClock.adjust(7_000);
				expect((yield* engine.log).length).toBe(4);
				yield* engine.failWith();
				yield* TestClock.adjust(8_000);
				expect(yield* responsiveness.settings()).toMatchObject({ state: "active" });
			}).pipe(
				Effect.provide(
					makeWorkbenchEditorResponsivenessLayer({
						clientProcessId: 7,
						platform: "win32",
						store: preference.store
					}).pipe(
						Layer.provide(
							Layer.merge(engine.layer, makeWorkbenchUnrealConnectionLayer(local))
						)
					)
				)
			);
		})
	);

	it.effect("reports an editor without the capability and looks again slowly", () =>
		Effect.gen(function* () {
			const engine = yield* fakeEngine();
			yield* engine.failWith("capability_missing");
			const preference = yield* makeEditorResponsivenessPreferenceTestStore();
			yield* Effect.gen(function* () {
				const responsiveness = yield* WorkbenchEditorResponsiveness;
				yield* TestClock.adjust(0);
				expect(yield* responsiveness.settings()).toMatchObject({
					state: "unsupported",
					detail: "The editor said no. Update UE Shed Core."
				});
				yield* TestClock.adjust(29_000);
				expect((yield* engine.log).length).toBe(1);
				yield* TestClock.adjust(2_000);
				expect((yield* engine.log).length).toBe(2);
			}).pipe(
				Effect.provide(
					makeWorkbenchEditorResponsivenessLayer({
						clientProcessId: 7,
						platform: "win32",
						store: preference.store
					}).pipe(
						Layer.provide(
							Layer.merge(engine.layer, makeWorkbenchUnrealConnectionLayer(local))
						)
					)
				)
			);
		})
	);

	it.effect("releases the lease when the Workbench runtime closes", () =>
		Effect.gen(function* () {
			const { engine, scope } = yield* exercise();
			yield* Scope.close(scope, Exit.void);
			expect(yield* engine.log).toEqual([`hold:${local}:7`, `release:${local}`]);
		})
	);
});
