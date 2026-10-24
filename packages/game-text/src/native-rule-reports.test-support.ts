/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { effectiveRuleDocument } from "./rules/effective.js";
import type { RuleDocumentV4 } from "./rules/schema.js";
import { expr, rule } from "./rules/builder.js";
import type { GameTextRuleDocument, CustomLocalizationCheck } from "./game-text-rules.js";
import {
	LocalizationCustomFinding,
	type LocalizationCheckOptions
} from "./localization-quality-schema.js";

const Row = Schema.Struct({
	fields: Schema.Record(Schema.String, Schema.Json),
	occurrences: Schema.Array(Schema.Json)
});
const Emission = Schema.Struct({
	rule: Schema.Number,
	row: Schema.Number,
	actual: Schema.Json,
	expectation: Schema.Json,
	fix: Schema.Json,
	extra: Schema.Json,
	translationOrigin: Schema.Json,
	recovery: Schema.String,
	affected: Schema.Array(
		Schema.Struct({ id: Schema.String, location: Schema.Json, packageFile: Schema.String })
	)
});
const Result = Schema.Struct({
	findings: Schema.Array(Emission),
	diagnostics: Schema.Array(
		Schema.Struct({
			subject: Schema.String,
			row: Schema.Number,
			code: Schema.optionalKey(Schema.String),
			patternIssues: Schema.optionalKey(Schema.Array(Schema.String))
		})
	)
});
/** Native unit-test transport. Subject facts are supplied explicitly; every row rule runs in Rust. */
function evaluate(
	document: GameTextRuleDocument | undefined,
	rows: {
		line: readonly (typeof Row.Type)[];
		line_culture: readonly (typeof Row.Type)[];
		unit_source: readonly (typeof Row.Type)[];
	},
	options: LocalizationCheckOptions = {}
) {
	return evaluateV4(effectiveRuleDocument(document, options), rows);
}
function evaluateV4(
	document: RuleDocumentV4,
	rows: {
		line: readonly (typeof Row.Type)[];
		line_culture: readonly (typeof Row.Type)[];
		unit_source: readonly (typeof Row.Type)[];
	}
) {
	const executable =
		process.env.UE_SHED_RULE_TEST_DRIVER ??
		fileURLToPath(
			new URL(
				`../../../target/debug/examples/rule_test_driver${process.platform === "win32" ? ".exe" : ""}`,
				import.meta.url
			)
		);
	const result = spawnSync(executable, {
		input: JSON.stringify({
			document,
			locale: new Intl.Collator().resolvedOptions().locale,
			...rows
		}),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true
	});
	if (result.error || result.status !== 0)
		throw new Error(
			`Native rule unit-test driver failed. Build with cargo build -p game-text-index --example rule_test_driver. ${result.stderr}`,
			{ cause: result.error }
		);
	const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Result))(result.stdout);
	return {
		...decoded,
		// A finding's rule is its ordinal in the document this driver evaluated.
		findings: decoded.findings.map((finding) => ({
			...finding,
			rule: document.rules[finding.rule]!
		}))
	};
}
/** Direct base-function assertions, with no TypeScript regex implementation. */
export function nativeTermMatches(source: string, term: string, caseSensitive: boolean) {
	const definition = rule({
		id: "terms",
		kind: "terms",
		label: "Terms",
		subject: "unit_source",
		family: "source",
		severity: "normal",
		when: expr.lit(true),
		actual: expr.object({
			matches: expr.termMatches(expr.lit(source), expr.lit(term), expr.lit(caseSensitive))
		}),
		expectation: expr.object({}),
		recovery: expr.lit("")
	});
	const output = evaluateV4(
		{ schemaVersion: 4, roles: [], rules: [definition] },
		{ line: [], line_culture: [], unit_source: [{ fields: { source }, occurrences: [] }] }
	);
	return Schema.decodeUnknownSync(
		Schema.Struct({
			matches: Schema.Array(
				Schema.Struct({ match: Schema.String, start: Schema.Number, end: Schema.Number })
			)
		})
	)(output.findings[0]!.actual).matches.map(({ match, start, end }) => ({
		matched: match,
		start,
		end
	}));
}

/** The native `visibleLength` of one text: characters a reader sees, tags and arguments removed. */
export function nativeVisibleLength(text: string): number {
	const definition = rule({
		id: "length",
		kind: "length",
		label: "Length",
		subject: "unit_source",
		family: "source",
		severity: "normal",
		when: expr.lit(true),
		actual: expr.object({ length: expr.visibleLength(expr.lit(text)) }),
		expectation: expr.object({}),
		recovery: expr.lit("")
	});
	const output = evaluateV4(
		{ schemaVersion: 4, roles: [], rules: [definition] },
		{ line: [], line_culture: [], unit_source: [{ fields: { source: text }, occurrences: [] }] }
	);
	return Schema.decodeUnknownSync(Schema.Struct({ length: Schema.Number }))(
		output.findings[0]!.actual
	).length;
}

/** Custom-kind unit assertions with one explicit source row, evaluated in Rust. */
export function nativeDetectCustom(check: CustomLocalizationCheck, text: string) {
	const document = Schema.decodeUnknownSync(importGameTextRuleDocument)({
		schemaVersion: 1,
		roles: [],
		rules: [{ ...check, subject: "source" }]
	});
	const row = Schema.decodeUnknownSync(Row)({
		fields: {
			lineId: "line",
			identity: { namespace: "", key: "K" },
			source: text,
			manifestSource: text,
			comparisonSource: text,
			sourceVariants: null,
			comparable: true,
			checkable: true,
			sourceCulture: "en",
			sourceLatestOrigin: "archive",
			nativeCulture: "en",
			gathered: true,
			bytecodeOnly: false,
			manifestNotes: [],
			manifestLocations: [],
			originKind: "corpus",
			stringTables: []
		},
		occurrences: []
	});
	const finding = evaluate(
		document,
		{
			line: [row],
			line_culture: [],
			unit_source: []
		},
		{ checks: [] }
	).findings.find((finding) => finding.rule.family === "custom");
	return finding
		? Schema.decodeUnknownSync(
				Schema.Struct({
					actual: LocalizationCustomFinding.fields.actual,
					expectation: LocalizationCustomFinding.fields.expectation
				})
			)(finding)
		: undefined;
}
import { GameTextRuleDocument as importGameTextRuleDocument } from "./game-text-rules.js";

/** Evaluate a v4 document against explicit rows of every subject, as group rules need. */
export const nativeEvaluateRows = (
	document: RuleDocumentV4,
	rows: Partial<Parameters<typeof evaluateV4>[1]>
) => evaluateV4(document, { line: [], line_culture: [], unit_source: [], ...rows });

/** Evaluate one native expression definition against explicit unit-test facts. */
export function nativeEvaluateRule(
	definition: RuleDocumentV4["rules"][number],
	fields: typeof Row.Type.fields
) {
	const row = { fields, occurrences: [] };
	return evaluateV4(
		{ schemaVersion: 4, roles: [], rules: [definition] },
		{
			line: definition.subject === "line" ? [row] : [],
			line_culture: definition.subject === "line_culture" ? [row] : [],
			unit_source: definition.subject === "unit_source" ? [row] : []
		}
	).findings[0];
}
