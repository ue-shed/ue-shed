/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import type { LocalizationTargetEvidence } from "@ue-shed/localization";
import { translateRuleDocument } from "./rules/translate.js";
import { Rule } from "./rules/schema.js";
import type { RuleDocumentV4 } from "./rules/schema.js";
import { expr, rule } from "./rules/builder.js";
import type { GameTextRuleDocument, CustomLocalizationCheck } from "./game-text-rules.js";
import {
	LocalizationQualityFinding,
	LocalizationCustomFinding,
	LocalizationPolicyFinding,
	LocalizationCheckDiagnostic,
	type LocalizationCheckOptions
} from "./localization-quality-schema.js";
import {
	TextQualityFinding,
	TextQualityReport,
	type TextQualityRuleDocument
} from "./quality-schema.js";
import { textCorpusDiagnosticSummary } from "./corpus-summary.js";
import { matchesTextRole } from "./quality.js";
import { localizationSourceCulture, localizationConflictingSource } from "./localization-checks.js";
import { localizationLineUnits } from "./gathered-text.js";
import { localizationExpectedSource, localizationManifestNotes } from "./localization.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import { assembleLocalizationCheckReport } from "./localization-check-report.js";
import type { LocalizationJoin, LocalizationLine } from "./localization-schema.js";
import type { TextCorpus, TextOccurrence } from "./schema.js";

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
	rules: Schema.Array(Schema.Struct({ ordinal: Schema.Number, rule: Rule })),
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
function checkedValue<S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	value: typeof Schema.Json.Type
): S["Type"] {
	return Schema.is(schema)(value) ? value : Schema.decodeUnknownSync(schema)(value);
}

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
	return evaluateV4(translateRuleDocument(document, options), rows);
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
	const rules = new Map(decoded.rules.map(({ ordinal, rule }) => [ordinal, rule]));
	return {
		...decoded,
		findings: decoded.findings.map((finding) => ({
			...finding,
			rule: rules.get(finding.rule)!
		}))
	};
}
const occurrencesOf = (units: ReturnType<typeof localizationLineUnits>) =>
	units
		.flatMap((unit) =>
			unit.occurrences.map((occurrence) => ({
				...occurrence,
				unitStatus: unit.identity.status
			}))
		)
		.sort((a, b) => a.id.localeCompare(b.id));

/** Explicit facts for the old in-memory check fixtures; assertions now exercise the native IR. */
export function nativeLocalizationReport(
	corpus: TextCorpus,
	join: LocalizationJoin,
	evidence: LocalizationTargetEvidence,
	options: LocalizationCheckOptions = {},
	document?: GameTextRuleDocument
) {
	const units = new Map(corpus.units.map((unit) => [unit.id, unit]));
	const lines: (typeof Row.Type)[] = [],
		cultures: (typeof Row.Type)[] = [];
	const marks: Array<{ line: LocalizationLine; culture: LocalizationLine["cultures"][number] }> =
		[];
	for (const line of join.lines) {
		const lineUnits = localizationLineUnits(line, units),
			occurrences = occurrencesOf(lineUnits);
		const authored = lineUnits.filter((unit) => unit.identity.status !== "string_table");
		const variants = localizationConflictingSource(line)
			? [
					...new Set(
						(authored.length ? authored : lineUnits).flatMap((unit) =>
							unit.occurrences.map((occurrence) => occurrence.source)
						)
					)
				].sort()
			: [];
		const sourceVariants = variants.length > 1 ? variants : null;
		const manifest = line.manifest[0]?.source,
			comparisonSource = manifest?.Text ?? line.source;
		const sourceCulture = localizationSourceCulture(line, join.nativeCulture) ?? null;
		const sourceMark = line.cultures.find((mark) => mark.culture === sourceCulture);
		const fields = {
			lineId: line.id,
			identity: line.identity,
			source: line.source,
			manifestSource: manifest?.Text ?? null,
			comparisonSource,
			sourceVariants,
			comparable: sourceVariants === null || manifest !== undefined,
			checkable:
				line.identity !== null && (!!line.source.trim() || !!comparisonSource.trim()),
			sourceCulture,
			sourceLatestOrigin: sourceMark
				? localizationShippedTranslation(sourceMark).origin
				: "absent",
			nativeCulture: join.nativeCulture,
			gathered: line.manifest.length > 0,
			bytecodeOnly:
				line.manifest.length > 0 &&
				line.manifest.every((entry) => entry.path.endsWith("[Script Bytecode]")),
			manifestNotes: line.manifest.flatMap(localizationManifestNotes),
			manifestLocations: [...new Set(line.manifest.map((entry) => entry.path))].sort(),
			originKind: line.origin.kind,
			stringTables: [
				...new Set(
					occurrences.flatMap((occurrence) =>
						occurrence.location.kind === "string_table_entry"
							? [occurrence.location.objectPath]
							: []
					)
				)
			].sort()
		};
		lines.push(Schema.decodeUnknownSync(Row)({ fields, occurrences }));
		for (const mark of [...line.cultures].sort((a, b) => a.culture.localeCompare(b.culture))) {
			if (mark.state === "outside_target") continue;
			const latest = localizationShippedTranslation(mark);
			cultures.push(
				Schema.decodeUnknownSync(Row)({
					fields: {
						...Object.fromEntries(
							Object.entries(fields).map(([name, value]) => [`line.${name}`, value])
						),
						culture: mark.culture,
						state: mark.state,
						facts: mark.facts,
						unknownReasons: mark.unknownReasons,
						reducedSourceChecking: mark.reducedSourceChecking,
						isNative: mark.culture === join.nativeCulture,
						isSourceCulture: mark.culture === sourceCulture,
						po: mark.po?.msgstr["0"] ?? null,
						archive: mark.archive?.translation.Text ?? null,
						latest: latest.value,
						latestOrigin: latest.origin,
						archiveSource: mark.archive?.source.Text ?? null,
						expectedSource: manifest
							? localizationExpectedSource(
									manifest,
									mark.culture,
									join.nativeCulture,
									line.cultures.find(
										(culture) => culture.culture === join.nativeCulture
									)?.archive
								).Text
							: null
					},
					occurrences
				})
			);
			marks.push({ line, culture: mark });
		}
	}
	const result = evaluate(
		document,
		{ line: lines, line_culture: cultures, unit_source: [] },
		options
	);
	type Checked =
		Parameters<typeof assembleLocalizationCheckReport>[3] extends ReadonlyMap<string, infer A>
			? A
			: never;
	const checked = new Map<
		string,
		Omit<Checked, "diagnostics"> & { diagnostics: LocalizationCheckDiagnostic[] }
	>(
		join.lines.map((line, row) => [
			line.id,
			{ row, builtIns: [], policy: [], custom: [], diagnostics: [] }
		])
	);
	for (const emission of result.findings) {
		const lineRow = emission.rule.subject === "line",
			line = lineRow ? join.lines[emission.row]! : marks[emission.row]!.line;
		const cultureCode = lineRow
			? localizationSourceCulture(line, join.nativeCulture)!
			: marks[emission.row]!.culture.culture;
		const culture = line.cultures.find((mark) => mark.culture === cultureCode)!;
		const row = checked.get(line.id)!;
		const base = {
			lineId: line.id,
			target: join.target,
			culture: cultureCode,
			identity: line.identity,
			ruleId: emission.rule.ruleId ?? emission.rule.id,
			kind: emission.rule.kind,
			severity: emission.rule.severity,
			recovery: emission.recovery,
			actual: emission.actual,
			expectation: emission.expectation,
			affectedOccurrences: emission.affected,
			manifestLocations: lines[join.lines.indexOf(line)]!.fields.manifestLocations!,
			translationOrigin:
				emission.translationOrigin ?? localizationShippedTranslation(culture).origin,
			...(emission.rule.role ? { role: emission.rule.role } : undefined),
			...(Schema.is(Schema.Record(Schema.String, Schema.Json))(emission.extra)
				? emission.extra
				: undefined),
			...(emission.rule.family === "builtin" &&
			lines[join.lines.indexOf(line)]!.fields.sourceVariants !== null
				? { sourceVariants: lines[join.lines.indexOf(line)]!.fields.sourceVariants! }
				: undefined),
			...(Schema.is(Schema.String)(emission.fix)
				? {
						suggestedChange: {
							target: join.target,
							culture: cultureCode,
							namespace: line.identity!.namespace,
							key: line.identity!.key,
							source: line.manifest[0]?.source.Text ?? line.source,
							previousTranslation:
								culture.po?.msgstr["0"] ??
								culture.archive?.translation.Text ??
								null,
							translation: emission.fix
						}
					}
				: undefined)
		};
		if (emission.rule.family === "builtin")
			row.builtIns.push(checkedValue(LocalizationQualityFinding, base));
		else if (emission.rule.family === "policy")
			row.policy.push(checkedValue(LocalizationPolicyFinding, base));
		else row.custom.push(checkedValue(LocalizationCustomFinding, base));
	}
	for (const line of join.lines) {
		const row = checked.get(line.id)!;
		const selected = marks
			.map((mark, index) => ({ ...mark, index }))
			.filter((mark) => mark.line === line);
		for (const { culture } of selected) {
			for (const code of culture.unknownReasons)
				row.diagnostics.push({ lineId: line.id, culture: culture.culture, code });
			if (culture.reducedSourceChecking)
				row.diagnostics.push({
					lineId: line.id,
					culture: culture.culture,
					code: "reduced_source_checking"
				});
		}
		if (!lines[join.lines.indexOf(line)]!.fields.checkable) continue;
		for (const { culture, index } of selected) {
			if (!line.manifest.length)
				row.diagnostics.push({
					lineId: line.id,
					culture: culture.culture,
					code: "source_unavailable"
				});
			const codes =
				result.diagnostics.find(
					(diagnostic) => diagnostic.row === index && diagnostic.patternIssues
				)?.patternIssues ?? [];
			for (const code of codes)
				row.diagnostics.push(
					Schema.decodeUnknownSync(LocalizationCheckDiagnostic)({
						lineId: line.id,
						culture: culture.culture,
						code
					})
				);
			if (localizationShippedTranslation(culture).value === null)
				row.diagnostics.push({
					lineId: line.id,
					culture: culture.culture,
					code: "translation_unavailable"
				});
		}
	}
	return assembleLocalizationCheckReport(corpus, join, evidence, checked, options, document);
}

/** Source-unit golden assertions use the same native expressions as the indexed source scan. */
export function nativeSourceReport(
	corpus: TextCorpus,
	document: GameTextRuleDocument
): TextQualityReport {
	const units = [...corpus.units]
		.filter((unit) => unit.occurrences.some((occurrence) => occurrence.source.trim()))
		.sort((a, b) => a.id.localeCompare(b.id));
	const rows: (typeof Row.Type)[] = [],
		owners: typeof units = [];
	for (const unit of units) {
		const groups = new Map<string, TextOccurrence[]>();
		for (const occurrence of unit.occurrences) {
			const group = groups.get(occurrence.source) ?? [];
			group.push(occurrence);
			groups.set(occurrence.source, group);
		}
		for (const [source, occurrences] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
			rows.push(
				Schema.decodeUnknownSync(Row)({
					fields: { textUnitId: unit.id, unitStatus: unit.identity.status, source },
					occurrences
				})
			);
			owners.push(unit);
		}
	}
	const result = evaluate(document, { line: [], line_culture: [], unit_source: rows });
	const findings = result.findings.map((emission) =>
		Schema.decodeUnknownSync(TextQualityFinding)({
			textUnitId: owners[emission.row]!.id,
			ruleId: emission.rule.ruleId ?? emission.rule.id,
			kind: emission.rule.kind,
			role: emission.rule.role,
			recovery: emission.recovery,
			actual: emission.actual,
			expectation: emission.expectation,
			affectedOccurrences: emission.affected
				.map((occurrence) => ({
					id: occurrence.id,
					location: occurrence.location,
					packageFile: occurrence.packageFile
				}))
				.sort((a, b) => a.id.localeCompare(b.id))
		})
	);
	return {
		schemaVersion: 1,
		ruleDocumentVersion: document.schemaVersion,
		status: corpus.status,
		coverage: corpus.coverage,
		...textCorpusDiagnosticSummary(corpus.diagnostics),
		findings,
		roles: [...document.roles]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((role) => ({
				role: role.id,
				matchedOccurrences: units.reduce(
					(sum, unit) =>
						sum +
						unit.occurrences.filter((occurrence) => matchesTextRole(occurrence, role))
							.length,
					0
				),
				matchedTextUnits: units.filter((unit) =>
					unit.occurrences.some((occurrence) => matchesTextRole(occurrence, role))
				).length
			})),
		rules: [...document.rules]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((rule) => ({
				ruleId: rule.id,
				findingCount: findings.filter((finding) => finding.ruleId === rule.id).length
			}))
	};
}

export const nativeV1SourceReport = (corpus: TextCorpus, document: TextQualityRuleDocument) =>
	nativeSourceReport(corpus, document);

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

/** Custom-kind unit assertions with one explicit source row, evaluated in Rust. */
export function nativeDetectCustom(check: CustomLocalizationCheck, text: string) {
	const document = Schema.decodeUnknownSync(importGameTextRuleDocument)({
		schemaVersion: 3,
		roles: [],
		rules: [],
		customChecks: [{ ...check, subject: "source" }]
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
