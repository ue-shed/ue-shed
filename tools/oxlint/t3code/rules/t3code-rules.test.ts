// Cases ported from pingdotgg/t3code's oxlint-plugin-t3code rule tests, which spawn oxlint per
// fixture; here they run through RuleTester like the anti-slop rules. Copyright (c) 2026 T3 Tools
// Inc. MIT License; see ../LICENSE. no-low-value-comments has no upstream tests; its cases are ours.
import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import noInlineSchemaCompile from "./no-inline-schema-compile.ts";
import noLowValueComments from "./no-low-value-comments.ts";
import preferEffectFn from "./prefer-effect-fn.ts";
import requireSuppressionReason from "./require-suppression-reason.ts";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ts = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" }, sourceType: "module" }
});
const tsx = new RuleTester({
	languageOptions: { parserOptions: { lang: "tsx" }, sourceType: "module" }
});
const effectFnMessage = /Effect\.fn\("Service\.operation"\).*documented hot paths/u;

ts.run("prefer-effect-fn", preferEffectFn, {
	valid: [
		// Inline programs and layer construction.
		`import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
export const program = Effect.gen(function* () { yield* Effect.void; });
export const layer = Layer.effectDiscard(Effect.gen(function* () { yield* Effect.void; }));`,
		// Named functions and deliberate untraced functions.
		`import * as Effect from "effect/Effect";
export const read = Effect.fn("Files.read")(function* () { yield* Effect.void; });
export const chunk = Effect.fnUntraced(function* () { yield* Effect.void; });`,
		// Inline combinator callbacks.
		`import * as Effect from "effect/Effect";
export const program = Effect.void.pipe(Effect.flatMap(() => Effect.gen(function* () {
	yield* Effect.void;
})));`,
		// Inline option and error callbacks.
		`import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
export const program = Option.match(Option.none(), {
	onNone: () => Effect.gen(function* () { yield* Effect.void; }),
	onSome: () => Effect.void
});
export const recovered = Effect.fail({ _tag: "Failed" }).pipe(Effect.catchTags({
	Failed: () => Effect.gen(function* () { yield* Effect.void; })
}));`,
		// Reference default-value callbacks.
		`import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
export const Default = Context.Reference("Default", {
	defaultValue: () => Effect.gen(function* () { yield* Effect.void; })
});`,
		// Other namespaces and shadowed locals are not Effect.
		`import * as Effect from "effect/Effect";
const Other = { gen: (body: () => unknown) => body() };
export const other = () => Other.gen(function* () {});
export function scoped(Effect: typeof Other) {
	return Effect.gen(function* () {});
}
export const effect = Effect.void;`,
		// Functions with synchronous setup are left for manual review.
		`import * as Effect from "effect/Effect";
export const read = () => {
	const state = new Map();
	return Effect.gen(function* () { yield* Effect.void; return state; });
};`,
		// Getters that expose an effect value.
		`import * as Effect from "effect/Effect";
export class Service {
	get read() { return Effect.gen(function* () { yield* Effect.void; }); }
}`
	],
	invalid: [
		...["onSome", "onNone", "onSuccess", "onFailure", "defaultValue"].map((name) => ({
			code: `import * as Effect from "effect/Effect";
export const service = Service.of({
	${name}: () => Effect.gen(function* () { yield* Effect.void; })
});`,
			errors: 1
		})),
		{
			code: `import * as Effect from "effect/Effect";
export const read = (path: string) => Effect.gen(function* () {
	yield* Effect.void;
	return path;
});`,
			errors: [{ message: effectFnMessage }]
		},
		{
			code: `import * as Effect from "effect/Effect";
export const read = () => { return Effect.gen(function* () { yield* Effect.void; }); };`,
			errors: 1
		},
		{
			code: `import * as Effect from "effect/Effect";
export function read() {
	return Effect.gen(function* () { yield* Effect.void; }).pipe(Effect.asVoid);
}`,
			errors: 1
		},
		{
			code: `import * as Effect from "effect/Effect";
export const read = function() { return Effect.gen(function* () { yield* Effect.void; }); };`,
			errors: 1
		},
		{
			code: `import * as Effect from "effect/Effect";
export const service = {
	read: () => Effect.gen(function* () { yield* Effect.void; })
};`,
			errors: 1
		},
		{
			code: `import * as Effect from "effect/Effect";
export class Service {
	read = () => Effect.gen(function* () { yield* Effect.void; });
}`,
			errors: 1
		},
		{
			code: `import * as Eff from "effect/Effect";
export const read = () => Eff.gen(function* () { yield* Eff.void; });`,
			errors: 1
		},
		{
			code: `import { Effect } from "effect";
export const read = () => Effect.gen(function* () { yield* Effect.void; });`,
			errors: 1
		},
		{
			code: `import { gen, void as noop } from "effect/Effect";
export const read = () => gen(function* () { yield* noop; });`,
			errors: 1
		},
		{
			code: `import * as Effect from "effect/Effect";
export class Service {
	read() { return Effect.gen(function* () { yield* Effect.void; }); }
}`,
			errors: 1
		}
	]
});

ts.run("no-inline-schema-compile", noInlineSchemaCompile, {
	valid: [
		// Compilers hoisted to module scope.
		`import { Schema } from "effect";
const User = Schema.Struct({ name: Schema.String });
const decodeUser = Schema.decodeUnknownEffect(User);
export const parseUser = (input: unknown) => decodeUser(input);`,
		// Factory helpers that return a precompiled decoder.
		`import { Schema } from "effect";
export const makeParser = <A, I>(schema: Schema.Codec<A, I>) => {
	const decode = Schema.decodeUnknownEffect(schema);
	return (input: unknown) => decode(input);
};`,
		// Schema construction helpers that use encode transformations.
		`import { Schema } from "effect";
export const makePrettyJson = <S extends Schema.Top>(schema: S) =>
	Schema.fromJsonString(schema).pipe(
		Schema.encode({
			decode: Schema.String,
			encode: Schema.String
		})
	);`,
		// Dynamic schema parameters that cannot be hoisted.
		`import { Schema } from "effect";
export const parseWith = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
	Schema.decodeUnknownEffect(schema)(input);`
	],
	invalid: [
		{
			code: `import { Schema } from "effect";
const User = Schema.Struct({ name: Schema.String });
export const parseUser = (input: unknown) => Schema.decodeUnknownEffect(User)(input);`,
			errors: [{ message: /Hoist Schema\.decodeUnknownEffect/u }]
		},
		{
			code: `import { Schema } from "effect";
export const parseUser = (input: unknown) =>
	Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))(input);`,
			errors: [{ message: /inline schema literal and the compiled function/u }]
		}
	]
});

tsx.run("require-suppression-reason", requireSuppressionReason, {
	valid: [
		// A directive with a -- reason.
		`// oxlint-disable-next-line no-control-regex -- ANSI sequences start with ESC.
const ansi = /\\x1b\\[/;
/* eslint-disable no-console -- this script reports to the terminal */`,
		// A directive explained by the comment above.
		`// Positions are stable for a given string.
// oxlint-disable-next-line react/no-array-index-key
const items = ["a"].map((item, index) => <li key={index}>{item}</li>);`,
		// Stacked directives under one explanation.
		`// The fixture is invalid on purpose.
// @ts-expect-error
// oxlint-disable-next-line no-unused-vars
const value: number = "text";`,
		// A TypeScript directive followed by its reason.
		`// @ts-expect-error the fixture passes a string on purpose
const count: number = "text";`,
		// A directive in a JSX comment with a reason.
		`const el = <div>{/* oxlint-disable-next-line react/no-danger -- sanitized above */}</div>;`,
		// Enable directives.
		`/* oxlint-enable no-console */`,
		// An empty comment line between the reason and the directive.
		`// Positions are stable for a given string.
//
// oxlint-disable-next-line react/no-array-index-key
const items = ["a"].map((item, index) => <li key={index}>{item}</li>);`
	].map((code) => ({ code, filename: "fixture.tsx" })),
	invalid: [
		{
			code: `// oxlint-disable-next-line no-control-regex
const ansi = /\\x1b\\[/;`,
			errors: [{ message: /end the directive with `-- reason`/u }]
		},
		{ code: `/* oxlint-disable eslint/no-useless-escape */`, errors: 1 },
		{
			code: `// @ts-expect-error
const count: number = "text";`,
			errors: [{ message: /write the reason after the directive/u }]
		},
		// A comment separated by a blank line doesn't count.
		{
			code: `// Positions are stable for a given string.

// oxlint-disable-next-line react/no-array-index-key
const items = ["a"].map((item, index) => <li key={index}>{item}</li>);`,
			errors: 1
		},
		// An empty comment above doesn't count.
		{
			code: `//
/* */
// oxlint-disable-next-line react/no-array-index-key
const items = ["a"].map((item, index) => <li key={index}>{item}</li>);`,
			errors: 1
		},
		// A trailing comment on the code line above doesn't count.
		{
			code: `const first = 1; // the first value
const second = 2; // oxlint-disable-line no-unused-vars`,
			errors: 1
		}
	].map((test) => ({ ...test, filename: "fixture.tsx" }))
});

ts.run("no-low-value-comments", noLowValueComments, {
	valid: [
		"// Expand blocks of up to 256 KiB; larger reads stall the event loop.\nconst size = 1;",
		"/**\n * Line one.\n * Line two.\n * Line three.\n * Line four.\n */\nexport const limit = 4;",
		"/**\n * Copyright (c) 2026 Example.\n * a\n * b\n * c\n * d\n */\nexport const x = 1;",
		"// oxlint-disable-next-line no-console -- the script reports to the terminal\nconsole.log(1);",
		"// TODO(#123): drop once the reader reports sizes.\nconst size = 1;",
		"// regression: #1234 keeps the empty shard.\nconst kept = true;"
	].map((code) => ({ code, filename: "fixture.ts" })),
	invalid: [
		{
			code: "/**\n * One.\n * Two.\n * Three.\n * Four.\n * Five.\n */\nexport const limit = 5;",
			errors: [{ message: /Cut this to 4 lines or fewer/u }]
		},
		{
			code: "// ----------------------------------------\nconst a = 1;",
			errors: [{ message: /section divider/u }]
		},
		{
			code: "// TODO make this faster\nconst a = 1;",
			errors: [{ message: /Link the issue/u }]
		},
		{
			code: "// Fixed in #1234.\nconst a = 1;",
			errors: [{ message: /Drop the PR or issue number/u }]
		},
		{
			code: "// Package count.\nconst packageCount = 1;",
			errors: [{ message: /only repeats the name/u }]
		},
		{
			code: "// const old = compute();\nconst value = 1;",
			errors: [{ message: /commented-out code/u }]
		},
		{ code: "test(() => {\n\t// Arrange\n\tconst a = 1;\n});", errors: 1 }
	].map((test) => ({ ...test, filename: "fixture.ts" }))
});
