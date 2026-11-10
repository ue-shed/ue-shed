import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { noCheckYieldWriteRule } from "./no-check-yield-write.ts";
import { noSharedLetInEffectRule } from "./no-shared-let-in-effect.ts";
import { noUnguardedOwnerClearRule } from "./no-unguarded-owner-clear.ts";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" }, sourceType: "module" }
});

const service = (body: string) => `
import { Effect, Layer, Ref } from "effect";
export const Live = Layer.effect(Tag, Effect.gen(function* () {
	${body}
}));
`;

ruleTester.run("no-shared-let-in-effect", noSharedLetInEffectRule, {
	valid: [
		// Written only by the body that declares it.
		service("let ready = false; ready = yield* check(); return { ready };"),
		// A tally that only grows.
		service("let failedCount = 0; return { fail: Effect.sync(() => { failedCount += 1; }) };"),
		// A per-call body: the other ownership rules cover it.
		service(
			"return { run: Effect.fn('run')(function* () { let sent = 0; yield* Effect.forEach(xs, () => Effect.sync(() => { sent = 1; })); }) };"
		),
		// Not a service file.
		"export const run = Effect.gen(function* () { let current; yield* Effect.sync(() => { current = 1; }); });",
		{
			code: service("let current; return { set: Effect.sync(() => { current = 1; }) };"),
			filename: "src/main/thing.test.ts"
		}
	],
	invalid: [
		{
			code: service(
				"let active: Fiber | undefined; return { start: Effect.gen(function* () { active = yield* Effect.forkScoped(work); }) };"
			),
			errors: [{ messageId: "sharedLet" }]
		},
		{
			code: service(
				"let context; let error; return { open: Effect.sync(() => { context = next; error = undefined; }) };"
			),
			errors: [{ messageId: "sharedLet" }, { messageId: "sharedLet" }]
		}
	]
});

ruleTester.run("no-check-yield-write", noCheckYieldWriteRule, {
	valid: [
		// The decision and the write are one step.
		"let busy = false; const run = Effect.gen(function* () { const start = yield* Ref.modify(state, (s) => [!s, true]); });",
		// No yield between the check and the write.
		"let busy = false; const run = Effect.gen(function* () { if (busy) return; busy = true; yield* work; });",
		// The state is local to this body.
		"const run = Effect.gen(function* () { let cached; if (!cached) cached = yield* load; return cached; });",
		// The yield between them leaves the body.
		"let cursor = 0; const run = Effect.gen(function* () { if (next < cursor) return yield* new Backwards(); cursor = next; });",
		"let open; const run = Effect.gen(function* () { if (open) return yield* pick(yield* Deferred.await(open)); open = next; yield* send; });",
		// The body runs under a permit.
		"let cached; const get = Effect.fn('get')(function* () { if (cached) return cached; cached = yield* load; return cached; }, gate.withPermits(1));",
		"let cached; const get = gate.withPermits(1)(Effect.gen(function* () { if (!cached) cached = yield* load; return cached; }));",
		"let cached; const get = Effect.gen(function* () { if (!cached) cached = yield* load; return cached; }).pipe(gate.withPermits(1));",
		// A Ref updated from its current value.
		"const run = Effect.gen(function* () { const s = yield* Ref.get(state); if (s.busy) return; yield* work; yield* Ref.update(state, (c) => ({ ...c, busy: true })); });"
	],
	invalid: [
		{
			// Two callers both miss, both load, and the slower one overwrites.
			code: "let cached; const get = Effect.gen(function* () { if (!cached) cached = yield* load; return cached; });",
			errors: [{ messageId: "checkYieldWrite" }]
		},
		{
			code: "let busy = false; const run = Effect.fn('run')(function* () { if (busy) return; yield* prepare; busy = true; });",
			errors: [{ messageId: "checkYieldWrite" }]
		},
		{
			code: "const run = Effect.gen(function* () { const s = yield* Ref.get(state); if (s.busy) return; yield* prepare; yield* Ref.set(state, { busy: true }); });",
			errors: [{ messageId: "checkYieldWrite" }]
		},
		{
			code: "const run = Effect.gen(function* () { if ((yield* Ref.get(state)).busy) return; yield* prepare; yield* Ref.set(state, { busy: true }); });",
			errors: [{ messageId: "checkYieldWrite" }]
		}
	]
});

ruleTester.run("no-unguarded-owner-clear", noUnguardedOwnerClearRule, {
	valid: [
		// Clears only its own entry.
		"let pending; function load() { const mine = fetchIt().finally(() => { if (pending === mine) pending = undefined; }); pending = mine; return mine; }",
		"let active; const run = work.pipe(Effect.ensuring(Effect.sync(() => { if (active === fiber) active = undefined; })));",
		// A generation fence decides whether this cleanup still owns the slot.
		"let active; let generation = 0; const run = work.pipe(Effect.onExit(() => Effect.suspend(() => { if (generation !== mine) return Effect.void; active = undefined; return Effect.void; })));",
		// A variable the cleanup owns itself.
		"const run = work.pipe(Effect.ensuring(Effect.sync(() => { let local = 1; local = undefined; })));",
		// Not cleanup.
		"let active; function reset() { active = undefined; }",
		// Not a clear.
		"let pending; function load() { return fetchIt().finally(() => { pending = next; }); }",
		// Detaching handlers is not clearing an owner.
		"const stop = () => work.finally(() => { worker.onmessage = null; });",
		// Not a close event.
		"let child; process.on('message', () => { child = undefined; });",
		{
			code: "let pending; fetchIt().finally(() => { pending = undefined; });",
			filename: "e2e/helpers/rowops.ts"
		}
	],
	invalid: [
		{
			code: "let pending; function load() { pending ??= fetchIt().finally(() => { pending = undefined; }); return pending; }",
			errors: [{ messageId: "unguardedClear" }]
		},
		{
			code: "let active; const run = work.pipe(Effect.ensuring(Effect.sync(() => { active = undefined; })));",
			errors: [{ messageId: "unguardedClear" }]
		},
		{
			code: "let lease; const scoped = Effect.acquireRelease(open, () => Effect.sync(() => { lease = null; }));",
			errors: [{ messageId: "unguardedClear" }]
		},
		{
			code: "const watch = Effect.gen(function* () { yield* Effect.addFinalizer(() => Ref.set(owner, Option.none())); });",
			errors: [{ messageId: "unguardedClear" }]
		},
		{
			code: "class Client { connect() { this.socket.on('close', () => { this.connecting = undefined; }); } }",
			errors: [{ messageId: "unguardedClear" }]
		},
		{
			code: "let updating; async function update() { try { await run(); } finally { updating = undefined; } }",
			errors: [{ messageId: "unguardedClear" }]
		},
		{
			code: "let child; socket.onclose = () => { child = undefined; };",
			errors: [{ messageId: "unguardedClear" }]
		}
	]
});
