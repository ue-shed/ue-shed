import { requireJsdocOnExportsRule } from "./require-jsdoc-on-exports.ts";
import { noStringifiedCauseInErrorRule } from "./no-stringified-cause-in-error.ts";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { noChainedEffectFlatMapRule } from "./no-chained-effect-flat-map.ts";
import { noModuleMockingRule } from "./no-module-mocking.ts";
import { noPlanPhaseCommentsRule } from "./no-plan-phase-comments.ts";
import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";
import { preferEffectFnPipeablesRule } from "./prefer-effect-fn-pipeables.ts";
import {
	requireSafetyCommentForTypeAssertionRule,
	requireSafetyVerificationRule
} from "./require-safety-comment-for-type-assertion.ts";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" }, sourceType: "module" }
});

ruleTester.run("no-module-mocking", noModuleMockingRule, {
	valid: [
		'import * as vitest from "vitest"; vitest.vi.fn();',
		'import * as helpers from "./helpers"; helpers.vi.mock("./dependency");',
		"const vitest = { vi: { mock() {} } }; vitest.vi.mock();"
	],
	invalid: [
		{
			code: 'import { vi } from "vitest"; vi.mock("./dependency");',
			errors: [{ messageId: "moduleMock" }]
		},
		{
			code: 'import * as vitest from "vitest"; vitest.vi.mock("./dependency");',
			errors: [{ messageId: "moduleMock" }]
		},
		{
			code: 'import * as vitest from "vitest"; vitest["vi"]["doMock"]("./dependency");',
			errors: [{ messageId: "moduleMock" }]
		},
		{
			code: 'import * as globals from "@jest/globals"; globals.jest.unstable_mockModule("./dependency");',
			errors: [{ messageId: "moduleMock" }]
		}
	]
});

ruleTester.run("no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
	valid: [
		`interface ServiceApi {}
/** @deprecated Use ServiceApi. */
export type ServiceShape = ServiceApi;`
	],
	invalid: [
		{
			code: "type LocalShape = {};",
			errors: [{ messageId: "forbiddenSymbolName" }]
		},
		{
			code: `interface OtherApi {}
/** @deprecated Use OtherApi. */
export type ServiceShape = OtherApi;`,
			errors: [{ messageId: "forbiddenSymbolName" }]
		},
		{
			code: `interface ServiceApi {}
/** @deprecated Use ServiceApi. */
type ServiceShape = ServiceApi;`,
			errors: [{ messageId: "forbiddenSymbolName" }]
		}
	]
});

ruleTester.run("no-plan-phase-comments", noPlanPhaseCommentsRule, {
	valid: [
		"// Expand blocks of up to 256 KiB.\nconst size = 1;",
		"const phase = 2; // the second pass"
	],
	invalid: [
		{ code: "// Phase 2 layout.\nconst size = 1;", errors: [{ messageId: "planPhase" }] },
		{
			code: "/** Reusable Phase 5 adapter. */\nexport const x = 1;",
			errors: [{ messageId: "planPhase" }]
		}
	]
});

ruleTester.run("prefer-effect-fn-pipeables", preferEffectFnPipeablesRule, {
	valid: [
		'const f = Effect.fn("f")(function* (id: string) { return yield* read(id); }, Effect.orDie);',
		'const f = Effect.fn("f")(function* () { const a = yield* read(); return yield* a.pipe(Effect.orDie); });',
		'const f = Effect.fn("f")(function* () { return yield* read().pipe(Effect.orDie); }, Effect.scoped);'
	],
	invalid: [
		{
			code: 'const f = Effect.fn("f")(function* (id: string) { return yield* read(id).pipe(Effect.orDie); });',
			errors: [{ messageId: "pipeInBody" }]
		},
		{
			code: "const f = Effect.fnUntraced(function* () { return yield* read().pipe(Effect.orDie); });",
			errors: [{ messageId: "pipeInBody" }]
		}
	]
});

ruleTester.run("no-chained-effect-flat-map", noChainedEffectFlatMapRule, {
	valid: [
		"read().pipe(Effect.flatMap(parse), Effect.map(format), Effect.orDie);",
		"pipe(read(), Effect.andThen(parse));"
	],
	invalid: [
		{
			code: "read().pipe(Effect.flatMap(parse), Effect.flatMap(save));",
			errors: [{ messageId: "chainedFlatMap" }]
		},
		{
			code: "pipe(read(), Effect.andThen(parse), Effect.flatMap(save));",
			errors: [{ messageId: "chainedFlatMap" }]
		}
	]
});

ruleTester.run(
	"require-safety-comment-for-type-assertion",
	requireSafetyCommentForTypeAssertionRule,
	{
		valid: [
			"const a = [1] as const;",
			"// SAFETY: the parser only produces numbers here.\nconst n = value as number;"
		],
		invalid: [
			{ code: "const n = value as number;", errors: [{ messageId: "missingSafetyComment" }] }
		]
	}
);

ruleTester.run("require-safety-verification", requireSafetyVerificationRule, {
	valid: [
		{
			code: "// SAFETY: the parser only produces numbers here.\n// Verified by: src/parser.test.ts\nconst n = value as number;",
			filename: "packages/example/src/parser.ts"
		},
		{
			code: "// SAFETY: the fixture writes numbers.\nconst n = value as number;",
			filename: "packages/example/src/parser.test.ts"
		},
		{
			code: "// SAFETY: the script writes numbers.\nconst n = value as number;",
			filename: "scripts/measure.ts"
		},
		{ code: "const n = value as number;", filename: "packages/example/src/parser.ts" }
	],
	invalid: [
		{
			code: "// SAFETY: the parser only produces numbers here.\nconst n = value as number;",
			filename: "packages/example/src/parser.ts",
			errors: [{ messageId: "missingVerification" }]
		}
	]
});

ruleTester.run("no-stringified-cause-in-error", noStringifiedCauseInErrorRule, {
	valid: [
		'new ReaderError({ message: "The reader failed.", cause });',
		"new ReaderError({ message: `Could not read ${path}.`, cause: error });",
		"report({ message: String(cause) });"
	],
	invalid: [
		{
			code: "new ReaderError({ message: String(cause) });",
			errors: [{ messageId: "stringifiedCause" }]
		},
		{
			code: "new errors.ReaderError({ message: `Read failed: ${String(error)}` });",
			errors: [{ messageId: "stringifiedCause" }]
		},
		{
			code: "new ReaderFailure({ message: Cause.pretty(cause) });",
			errors: [{ messageId: "stringifiedCause" }]
		}
	]
});

ruleTester.run("require-jsdoc-on-exports", requireJsdocOnExportsRule, {
	valid: [
		`/** Seconds the editor waits before it reports a stalled frame. */
export const timeout = 5;`,
		`/** A frame, decoded at the process boundary. */
export const Frame = {};
export type Frame = typeof Frame;`,
		'export { helper } from "./helper.js";',
		"const local = 1;"
	],
	invalid: [
		{ code: "export const timeout = 5;", errors: [{ messageId: "missingJsdoc" }] },
		{
			code: `// A line comment is not documentation.
export function open() {}`,
			errors: [{ messageId: "missingJsdoc" }]
		},
		{
			code: `/** Detached. */
const gap = 1;
export interface Request {}`,
			errors: [{ messageId: "missingJsdoc" }]
		},
		{ code: "export type Alone = string;", errors: [{ messageId: "missingJsdoc" }] }
	]
});
