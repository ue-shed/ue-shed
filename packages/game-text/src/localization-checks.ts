import { Schema } from "effect";
import type {
	LocalizationChangeSet,
	LocalizationTargetEvidence
} from "@ue-shed/localization/browser";
import { LocalizationCheckId } from "./localization-check-ids.js";
import { localizationManifestNotes } from "./localization.js";
import {
	GameTextLocalizationError,
	type LocalizationJoin,
	type LocalizationLine,
	type LocalizationCultureState
} from "./localization-schema.js";
import {
	LocalizationQualityReport,
	type LocalizationQualityFinding,
	type LocalizationCheckOptions,
	type LocalizationCheckDiagnostic
} from "./localization-quality-schema.js";
import { localizationEvidenceFileStatuses } from "./localization-status.js";
import {
	TextQualityRuleId,
	type TextQualityAffectedOccurrence,
	type TextQualityRuleDocument
} from "./quality-schema.js";
import type { TextCorpus } from "./schema.js";
import {
	parseUnrealFormatPattern,
	unrealRichTextCounts,
	unrealRichTextValid,
	unrealWhitespace,
	unrealUnsafeWhitespace,
	type UnrealFormatPattern,
	type UnrealModifierIdentity
} from "./unreal-text-syntax.js";

type FindingBase = Pick<
	LocalizationQualityFinding,
	| "lineId"
	| "target"
	| "culture"
	| "identity"
	| "affectedOccurrences"
	| "manifestLocations"
	| "translationOrigin"
>;
type DuplicateSourceActual = Extract<
	LocalizationQualityFinding,
	{ kind: "duplicate_source" }
>["actual"];

/** Secondary not_synced facts matter even when drift or gathered_only is the primary state. */
export function localizationShippedTranslation(culture: LocalizationCultureState) {
	if (culture.facts.includes("not_synced") || culture.state === "not_synced")
		return LocalizationShippedTranslation.make({ origin: "po", value: culture.poTranslation });
	return LocalizationShippedTranslation.make({
		origin: culture.archive ? "archive" : "absent",
		value: culture.archive?.translation.Text ?? null
	});
}

export const LocalizationShippedTranslation = Schema.Struct({
	origin: Schema.Literals(["po", "archive", "absent"]),
	value: Schema.NullOr(Schema.String)
});

function argumentNames(pattern: UnrealFormatPattern): readonly string[] {
	return [...new Set(pattern.arguments.map((argument) => argument.name))].sort();
}

function modifiers(pattern: UnrealFormatPattern): readonly UnrealModifierIdentity[] {
	return pattern.modifiers
		.map((modifier) => ({ argument: modifier.argument, name: modifier.name }))
		.sort(
			(a, b) =>
				(a.argument ?? "").localeCompare(b.argument ?? "") || a.name.localeCompare(b.name)
		);
}

function renameArgument(
	text: string,
	from: string,
	to: string,
	culture: LocalizationCultureState["culture"]
): string | undefined {
	const parsed = parseUnrealFormatPattern(text, culture);
	if (parsed.compiled !== true) return undefined;
	const replacements = parsed.arguments
		.filter((argument) => argument.name === from && argument.start >= 0)
		.map((argument) => ({
			start: argument.start,
			end: argument.end,
			value: `{${to}}`
		}));
	for (const modifier of parsed.modifiers.filter(
		(item) => item.depth === 0 && item.name !== "hpp"
	)) {
		const forms = modifier.forms.map((form) => ({
			...form,
			renamed: renameArgument(form.value, from, to, culture)
		}));
		if (forms.some((form) => form.renamed === undefined)) return undefined;
		if (!forms.some((form) => form.renamed !== form.value)) continue;
		const values = forms.map(
			(form) =>
				`${modifier.name === "plural" || modifier.name === "ordinal" ? `${form.name}=` : ""}${JSON.stringify(form.renamed)}`
		);
		replacements.push({
			start: modifier.start,
			end: modifier.end,
			value: `|${modifier.name}(${values.join(",")})`
		});
	}
	let value = text;
	for (const replacement of [...replacements].sort((a, b) => b.start - a.start))
		value =
			value.slice(0, replacement.start) + replacement.value + value.slice(replacement.end);
	return value;
}

/** Built-ins are read-only; proposals never modify evidence, corpus, PO or archives. */
export function checkLocalizationTarget(
	corpus: TextCorpus,
	join: LocalizationJoin,
	evidence: LocalizationTargetEvidence,
	options: LocalizationCheckOptions = {},
	ruleDocument?: TextQualityRuleDocument
): LocalizationQualityReport {
	if (
		join.target !== evidence.target.name ||
		(options.culture !== undefined && !join.cultures.includes(options.culture))
	)
		throw new GameTextLocalizationError({
			code: "invalid_selection",
			message: "The localization check selection is invalid.",
			recovery: "Choose a loaded target and one of its listed cultures."
		});
	const disabled = new Set([
		...(options.disabledChecks ?? []),
		...(ruleDocument?.disabledLocalizationChecks ?? [])
	]);
	const enabled = LocalizationCheckId.literals.filter(
		(id) => !disabled.has(id) && (!options.checks || options.checks.includes(id))
	);
	const findings: LocalizationQualityFinding[] = [];
	const checkDiagnostics: LocalizationCheckDiagnostic[] = [];
	const changes: LocalizationChangeSet["changes"][number][] = [];
	const byUnit = new Map(corpus.units.map((unit) => [unit.id, unit]));
	const groups = new Map<string, LocalizationLine[]>();
	for (const line of join.lines) {
		if (
			!line.identity ||
			line.source.trim().length === 0 ||
			line.cultures.every((culture) => culture.state === "outside_target")
		)
			continue;
		const group = groups.get(line.source) ?? [];
		group.push(line);
		groups.set(line.source, group);
	}
	const duplicateGroups = new Map<string, DuplicateSourceActual>(
		[...groups].map(([source, lines]) => {
			const identities = lines
				.flatMap((line) => (line.identity ? [line.identity] : []))
				.sort(
					(a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key)
				);
			return [
				source,
				{ source, identityCount: identities.length, identities: identities.slice(0, 5) }
			];
		})
	);
	for (const line of [...join.lines].sort((a, b) => a.id.localeCompare(b.id))) {
		for (const culture of [...line.cultures].sort((a, b) =>
			a.culture.localeCompare(b.culture)
		)) {
			if (
				(options.culture && culture.culture !== options.culture) ||
				culture.state === "outside_target"
			)
				continue;
			for (const code of culture.unknownReasons)
				checkDiagnostics.push({ lineId: line.id, culture: culture.culture, code });
			if (culture.reducedSourceChecking)
				checkDiagnostics.push({
					lineId: line.id,
					culture: culture.culture,
					code: "reduced_source_checking"
				});
		}
		if (!line.identity || line.source.trim().length === 0) continue;
		const units =
			line.origin.kind === "corpus"
				? line.origin.unitIds.flatMap((id) => {
						const unit = byUnit.get(id);
						return unit ? [unit] : [];
					})
				: [];
		const affectedOccurrences: TextQualityAffectedOccurrence[] = units
			.flatMap((unit) =>
				unit.occurrences.map((occurrence) => ({
					id: occurrence.id,
					packageFile: occurrence.packageFile,
					location: occurrence.location
				}))
			)
			.sort((a, b) => a.id.localeCompare(b.id));
		const notes = units
			.flatMap((unit) => unit.occurrences.map((occurrence) => occurrence.devNotes))
			.filter((note) => note.trim().length > 0);
		const source = line.manifest[0]?.source.Text ?? line.source;
		for (const culture of [...line.cultures].sort((a, b) =>
			a.culture.localeCompare(b.culture)
		)) {
			if (
				(options.culture && culture.culture !== options.culture) ||
				culture.state === "outside_target"
			)
				continue;
			const shipped = localizationShippedTranslation(culture);
			const base: FindingBase = {
				lineId: line.id,
				target: join.target,
				culture: culture.culture,
				identity: line.identity,
				affectedOccurrences,
				manifestLocations: [...new Set(line.manifest.map((entry) => entry.path))].sort(),
				translationOrigin: shipped.origin
			};
			const add = (finding: LocalizationQualityFinding) => {
				if (enabled.includes(finding.kind)) findings.push(finding);
			};
			const ruleId = (id: LocalizationCheckId) =>
				TextQualityRuleId.make(`localization.${id}`);
			const emptyPO = culture.po?.msgstr["0"] === "";
			const emptyArchive = culture.archive?.translation.Text === "";
			if (emptyPO || emptyArchive)
				add({
					...base,
					translationOrigin: emptyPO ? "po" : "archive",
					ruleId: ruleId("empty_translation"),
					kind: "empty_translation",
					actual: { entryExists: true, translation: "" },
					expectation: { nonEmptyTranslation: true },
					recovery:
						"Provide a non-empty translation in the culture's PO entry, then import and compile with Unreal."
				});
			if (
				notes.length === 0 &&
				line.manifest.every((entry) => localizationManifestNotes(entry).length === 0)
			)
				add({
					...base,
					ruleId: ruleId("missing_translator_notes"),
					kind: "missing_translator_notes",
					actual: { noteCount: 0 },
					expectation: { minimumNotes: 1 },
					recovery:
						"Add translator context to a source occurrence or manifest-producing source."
				});
			const duplicates = duplicateGroups.get(line.source);
			if (duplicates && duplicates.identityCount > 1)
				add({
					...base,
					ruleId: ruleId("duplicate_source"),
					kind: "duplicate_source",
					actual: duplicates,
					expectation: { reviewDistinctKeys: true },
					recovery:
						"Review whether these distinct identities need different context or should share a key. Equal text never links translations."
				});
			if (!line.manifest.length)
				checkDiagnostics.push({
					lineId: line.id,
					culture: culture.culture,
					code: "source_unavailable"
				});
			const sourcePattern = parseUnrealFormatPattern(source, culture.culture);
			const sourceModifiers = modifiers(sourcePattern);
			const patternIssues = (pattern: UnrealFormatPattern) => {
				for (const issue of pattern.issues)
					if (issue.code === "unsupported_culture" || issue.code === "syntax_limit")
						checkDiagnostics.push({
							lineId: line.id,
							culture: culture.culture,
							code: issue.code
						});
				return pattern.issues.filter(
					(issue) => issue.code !== "unsupported_culture" && issue.code !== "syntax_limit"
				);
			};
			const sourceIssues = patternIssues(sourcePattern);
			if (sourceIssues.length)
				add({
					...base,
					ruleId: ruleId("argument_modifiers"),
					kind: "argument_modifiers",
					actual: { side: "source", issues: sourceIssues, modifiers: sourceModifiers },
					expectation: { modifiers: sourceModifiers },
					recovery:
						"Repair the source's modifier syntax and culture-required forms before translating it."
				});
			if (shipped.value === null) {
				checkDiagnostics.push({
					lineId: line.id,
					culture: culture.culture,
					code: "translation_unavailable"
				});
				continue;
			}
			const translation = shipped.value;
			const escapeMatches = [...translation.matchAll(/\\[nrt]/gu)];
			if (escapeMatches.length)
				add({
					...base,
					ruleId: ruleId("po_escape_safety"),
					kind: "po_escape_safety",
					actual: {
						positions: escapeMatches.map((match) => match.index),
						sequences: escapeMatches.map((match) => match[0])
					},
					expectation: { roundTripSafe: true },
					recovery:
						"Replace literal backslash control sequences with actual control characters or reword them before Unreal's PO round trip."
				});
			const expectedSpace = unrealWhitespace(source);
			const actualSpace = unrealWhitespace(translation);
			if (
				JSON.stringify(expectedSpace) !== JSON.stringify(actualSpace) ||
				unrealUnsafeWhitespace(translation)
			)
				add({
					...base,
					ruleId: ruleId("whitespace"),
					kind: "whitespace",
					actual: actualSpace,
					expectation: expectedSpace,
					recovery:
						"Preserve the source's intentional boundary whitespace and line breaks; remove unsafe boundary spaces or tabs."
				});
			if (!unrealRichTextValid(source, translation))
				add({
					...base,
					ruleId: ruleId("rich_text"),
					kind: "rich_text",
					actual: unrealRichTextCounts(translation),
					expectation: unrealRichTextCounts(source),
					recovery:
						"Balance opening rich-text tags with </>, retaining intentional source imbalance."
				});
			const translationPattern = parseUnrealFormatPattern(translation, culture.culture);
			const expectedArgs = argumentNames(sourcePattern);
			const actualArgs = argumentNames(translationPattern);
			const canComparePattern =
				sourcePattern.compiled !== null && translationPattern.compiled !== null;
			const missing = expectedArgs.filter((argument) => !actualArgs.includes(argument));
			const added = actualArgs.filter((argument) => !expectedArgs.includes(argument));
			if (canComparePattern && (missing.length || added.length)) {
				const finding: Extract<LocalizationQualityFinding, { kind: "format_arguments" }> = {
					...base,
					ruleId: ruleId("format_arguments"),
					kind: "format_arguments",
					actual: { arguments: actualArgs, missing, added },
					expectation: { arguments: expectedArgs },
					recovery:
						"Keep the source's case-sensitive format argument names in the translation, including arguments inside modifier forms."
				};
				const from = added[0];
				const to = missing[0];
				if (
					enabled.includes("format_arguments") &&
					line.manifest.length > 0 &&
					!culture.unknownReasons.some(
						(reason) =>
							reason === "duplicate_manifest_identity" ||
							reason === "duplicate_archive_identity" ||
							reason === "duplicate_po_identity"
					) &&
					missing.length === 1 &&
					added.length === 1 &&
					from !== undefined &&
					to !== undefined
				) {
					const replacement = renameArgument(translation, from, to, culture.culture);
					if (
						replacement !== undefined &&
						JSON.stringify(
							argumentNames(parseUnrealFormatPattern(replacement, culture.culture))
						) === JSON.stringify(expectedArgs)
					) {
						const change = {
							target: join.target,
							culture: culture.culture,
							...line.identity,
							source,
							previousTranslation:
								culture.po?.msgstr["0"] ??
								culture.archive?.translation.Text ??
								null,
							translation: replacement
						};
						Object.assign(finding, { suggestedChange: change });
						changes.push(change);
					}
				}
				add(finding);
			}
			const translationModifiers = modifiers(translationPattern);
			const actionable = patternIssues(translationPattern);
			if (
				actionable.length ||
				(canComparePattern &&
					JSON.stringify(sourceModifiers) !== JSON.stringify(translationModifiers))
			)
				add({
					...base,
					ruleId: ruleId("argument_modifiers"),
					kind: "argument_modifiers",
					actual: {
						side: "translation",
						issues: actionable,
						modifiers: translationModifiers
					},
					expectation: { modifiers: sourceModifiers },
					recovery:
						"Repair modifier syntax and culture-required forms; preserve the source's argument modifiers."
				});
		}
	}
	findings.sort(
		(a, b) =>
			a.lineId.localeCompare(b.lineId) ||
			a.culture.localeCompare(b.culture) ||
			a.kind.localeCompare(b.kind) ||
			JSON.stringify(a.actual).localeCompare(JSON.stringify(b.actual))
	);
	const files = localizationEvidenceFileStatuses(evidence);
	return LocalizationQualityReport.make({
		schemaVersion: 1,
		ruleDocumentVersion: 1,
		status: corpus.status,
		coverage: corpus.coverage,
		diagnostics: corpus.diagnostics,
		target: join.target,
		gatherEvidence: files,
		findings,
		checkDiagnostics,
		roles: [],
		rules: enabled.map((id) => ({
			ruleId: TextQualityRuleId.make(`localization.${id}`),
			findingCount: findings.filter((finding) => finding.kind === id).length
		})),
		changes: {
			schemaVersion: 1,
			provenance: {
				producer: "ue-shed.localization.checks",
				files: files.flatMap((file) => (file.provenance ? [file.provenance] : []))
			},
			changes
		}
	});
}
