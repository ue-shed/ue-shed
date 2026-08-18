import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { noModuleMockingRule } from "./no-module-mocking.ts";
import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

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
