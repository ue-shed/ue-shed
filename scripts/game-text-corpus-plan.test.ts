import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	corpusCultures,
	decodeCorpusExpectations,
	diffCorpus,
	subjectKey
} from "./game-text-corpus-contract.ts";
import { decodeCorpusPlan, planCorpus } from "./game-text-corpus-plan.ts";
import { corpusLocalization } from "./game-text-corpus-localization.ts";
import {
	corpusDefectsFor,
	triageCorpusDifferences,
	formatCorpusComparisonSummary,
	type CorpusKnownDefect
} from "./game-text-corpus-defects.ts";

/** A subject pin for the triage tests, since every pin the corpus still needs is a probe. */
const syntheticPin: CorpusKnownDefect = {
	case: "empty-with-source-edge",
	defects: ["synthetic-whitespace"],
	withCheck: "localization.empty_translation",
	kind: "subject",
	status: "defect",
	why: "An empty translation should only produce empty_translation among translation-shape checks, as documented by the check contract. Boundary whitespace cannot be repaired until a translation exists.",
	rightAnswer: {
		findings: [
			{
				check: "localization.empty_translation",
				actual: { entryExists: true, translation: "" },
				expectation: { nonEmptyTranslation: true }
			}
		]
	},
	actual: {
		findings: [
			{
				check: "localization.empty_translation",
				actual: { entryExists: true, translation: "" },
				expectation: { nonEmptyTranslation: true }
			},
			{
				check: "localization.whitespace",
				actual: { leading: "", trailing: "", lineBreaks: 0 },
				expectation: { leading: " ", trailing: "", lineBreaks: 0 }
			}
		]
	}
};

const options = { root: "/Game/Fixture/Corpus", seed: 1, lines: 256, density: 1 };
const plan = planCorpus(options);
const texts = plan.packages.flatMap((owner) => owner.texts);
test("the semantic plan and expectations depend only on explicit inputs", () => {
	assert.deepEqual(planCorpus(options), plan);
	assert.notDeepEqual(planCorpus({ ...options, seed: 2 }), plan);
	assert.ok(plan.lines >= 256);
	assert.equal(plan.expectations.subjects.length, plan.lines * corpusCultures.length);
	assert.equal(
		new Set(plan.expectations.subjects.map(subjectKey)).size,
		plan.lines * corpusCultures.length
	);
});
test("every recipe survives the minimum requested size", () => {
	const minimum = planCorpus({ ...options, lines: 1 });
	const recipes = (p: typeof plan) =>
		new Set(
			p.packages.flatMap((owner) =>
				owner.texts
					.filter((text) => text.case !== "background")
					.map((text) => text.case.split("@")[0])
			)
		);
	assert.deepEqual(recipes(minimum), recipes(plan));
});

for (const name of new Set(
	texts.filter((text) => text.case !== "background").map((text) => text.case)
))
	test(`expectations are derived from recipe: ${name}`, () => {
		const placements = texts.filter((text) => text.case === name);
		const subjects = plan.expectations.subjects.filter((subject) => subject.case === name);
		assert.equal(subjects.length, placements.length * corpusCultures.length);
		for (const subject of subjects) {
			const placement = placements.find((text) => text.field === subject.field)!;
			assert.deepEqual(subject.findings, placement.cultures[subject.culture]!.findings);
			assert.deepEqual(subject.state, placement.cultures[subject.culture]!.state);
			for (const absent of subject.absent)
				assert.ok(!subject.findings.some((finding) => finding.check === absent));
		}
	});
test("all 25 built-in checks and all six custom source/translation kinds are planted", () => {
	const ids = new Set(
		plan.expectations.subjects.flatMap((subject) =>
			subject.findings.map((finding) => finding.check)
		)
	);
	for (const name of [
		"format_arguments",
		"argument_modifiers",
		"rich_text",
		"po_escape_safety",
		"whitespace",
		"empty_translation",
		"missing_translator_notes",
		"duplicate_source",
		"format_argument_renamed",
		"rich_text_tags",
		"rich_text_tag_case",
		"line_breaks",
		"segment_separator",
		"length_outlier",
		"outdated_translation",
		"inconsistent_translation",
		"rich_text_tags_added",
		"source_line_endings_changed",
		"placeholder_translation",
		"culture_invariant_text",
		"placeholder_text",
		"source_whitespace",
		"source_markup",
		"number_only_text",
		"string_table_key_collision"
	])
		assert.ok(ids.has(`localization.${name}`), name);
	for (const subject of ["source", "translation"])
		for (const kind of ["pattern", "length", "forbidden_term"])
			assert.ok([...ids].some((id) => id.startsWith(`corpus.${subject}.${kind}.i`)));
});
test("realistic background preserves syntax, is unique, current and finding-free", () => {
	for (const seed of [0, 1, 53, 2_147_483_647]) {
		const generated = planCorpus({ ...options, seed, lines: 10_000, density: 2 });
		const background = generated.packages.flatMap((owner) =>
			owner.texts.filter((text) => text.case === "background")
		);
		assert.equal(new Set(background.map((text) => text.source)).size, background.length);
		for (const [kind, fraction] of [
			["stringTableEntry", 0.4],
			["dataTableCell", 0.3],
			["blueprintVariable", 0.1],
			["blueprintPin", 0.1],
			["widgetText", 0.1]
		] as const) {
			const count = background.filter((text) => text.kind === kind).length;
			// A partial ten-line distribution cycle and an optional deletion probe affect the edges.
			assert.ok(Math.abs(count - background.length * fraction) <= 4, `${kind} distribution`);
		}
		assert.ok(
			generated.packages.length >= 600 && generated.packages.length <= 900,
			`Unexpected benchmark package count: ${generated.packages.length}`
		);
		assert.deepEqual(
			new Set(background.map((text) => text.kind)),
			new Set([
				"stringTableEntry",
				"dataTableCell",
				"blueprintVariable",
				"blueprintPin",
				"widgetText"
			])
		);
		assert.deepEqual(
			new Set(background.map((text) => text.parameters.template)),
			new Set([0, 1, 2, 3, 4, 5])
		);
		for (const text of background) {
			assert.ok(text.source.length < 39 && text.notes && text.gathered);
			assert.deepEqual(
				text.signals,
				["blueprintVariable", "blueprintPin", "widgetText"].includes(text.kind)
					? ["evidence_only"]
					: []
			);
			assert.equal(
				new Set(Object.values(text.cultures).map((mark) => mark.translation)).size,
				4
			);
			for (const [culture, mark] of Object.entries(text.cultures)) {
				assert.equal(mark.state, "translated");
				if (culture === "en") assert.equal(mark.translation, text.source);
				else assert.notEqual(mark.translation, text.source);
				assert.equal(mark.expectedSource, text.source);
				assert.equal(mark.archiveSource, text.source);
				assert.equal(mark.po, mark.translation);
				assert.deepEqual(mark.findings, []);
				assert.deepEqual(mark.problems, ["up_to_date"]);
				assert.deepEqual(
					mark.translation.match(/\{N\}|<\/?Em>|<\/>|\n/gu),
					text.source.match(/\{N\}|<\/?Em>|<\/>|\n/gu)
				);
			}
		}
	}
});

test("UTF-16 long boundaries include surrogate pairs", () => {
	for (const text of texts.filter((text) => text.case.startsWith("long-"))) {
		const length = Number(text.parameters.utf16Units);
		assert.equal(text.source.length, length);
		assert.equal(text.signals.includes("long"), length >= 40);
	}
});
test("the expectation derivation never imports checks, rules or index code", () => {
	for (const name of [
		"game-text-corpus-plan.ts",
		"game-text-corpus-contract.ts",
		"game-text-corpus-localization.ts"
	])
		assert.doesNotMatch(
			readFileSync(new URL(name, import.meta.url), "utf8"),
			/from ["'][^"']*(?:@ue-shed|packages\/|localization-checks|text-problems|index\.js)/u
		);
});
test("saved-source changes keep the native archive at the gathered source", () => {
	for (const seed of [1, 73139]) {
		const fixture = planCorpus({ ...options, seed });
		const changed = fixture.packages
			.flatMap((item) => item.texts)
			.find((text) => text.case === "changed-since-gather@0");
		assert.ok(changed);
		assert.notEqual(changed.source, changed.manifestSource);
		assert.equal(changed.cultures.en?.translation, changed.manifestSource);
		assert.equal(changed.cultures.en?.archiveSource, changed.manifestSource);
		for (const culture of ["de", "fr", "ja"])
			assert.equal(changed.cultures[culture]?.archiveSource, changed.cultures.en.translation);
		assert.ok(
			fixture.expectations.subjects
				.filter((subject) => subject.case === changed.case)
				.every(
					(subject) =>
						subject.facts.includes("translated") &&
						subject.facts.includes("changed_since_gather") &&
						!subject.findings.some(
							(finding) => finding.check === "localization.outdated_translation"
						)
				)
		);
	}
});

test("plan and expectation decoders reject invalid versions, missing fields and inconsistent counts", () => {
	assert.deepEqual(decodeCorpusPlan(JSON.stringify(plan)), plan);
	assert.deepEqual(
		decodeCorpusExpectations(JSON.stringify(plan.expectations)),
		plan.expectations
	);
	for (const value of [
		"{",
		"{}",
		JSON.stringify({ ...plan, version: 2 }),
		JSON.stringify({ ...plan, lines: 999 })
	])
		assert.throws(() => decodeCorpusPlan(value));
	assert.throws(() =>
		decodeCorpusExpectations(JSON.stringify({ ...plan.expectations, counts: {} }))
	);
	assert.throws(() =>
		decodeCorpusExpectations(
			JSON.stringify({
				...plan.expectations,
				subjects: [...plan.expectations.subjects, plan.expectations.subjects[0]]
			})
		)
	);
});
test("the diff rejects missing/extra subjects, missing/extra findings and wrong evidence", () => {
	assert.deepEqual(diffCorpus(plan.expectations, plan.expectations.subjects), []);
	assert.equal(diffCorpus(plan.expectations, plan.expectations.subjects.slice(1)).length, 1);
	assert.equal(
		diffCorpus(plan.expectations, [
			...plan.expectations.subjects,
			plan.expectations.subjects[0]!
		]).length,
		1
	);
	const changed = [...structuredClone(plan.expectations.subjects)];
	const found = changed.findIndex((subject) => subject.findings.length > 0);
	changed[found] = { ...changed[found]!, findings: [] };
	assert.equal(diffCorpus(plan.expectations, changed).length, 1);
	const extra = {
		...changed[0]!,
		findings: [{ check: "unexpected", actual: {}, expectation: {} }]
	};
	assert.ok(diffCorpus(plan.expectations, [extra, ...changed.slice(1)]).length >= 1);
});
test("localization has all cultures and never emits invariant or String Table reference identities", () => {
	const localization = corpusLocalization(plan);
	assert.equal(localization.resources.length, corpusCultures.length);
	for (const culture of plan.cultures) {
		assert.ok(localization.files[`${localization.folder}/${culture}/${plan.target}.archive`]);
		assert.ok(localization.files[`${localization.folder}/${culture}/${plan.target}.po`]);
	}
	assert.doesNotMatch(
		localization.files[`${localization.folder}/${plan.target}.manifest`]!,
		/Silent player label/u
	);
});
test("known defects cannot hide unrelated changes or silently survive a fix", () => {
	const caseName = "empty-with-source-edge@0";
	const intent = plan.expectations.subjects.filter(
		(subject) =>
			subject.case === caseName &&
			subject.findings.some((finding) => finding.check === "localization.empty_translation")
	);
	const actual = intent.map((subject) => {
		const defect = corpusDefectsFor(intent, [], [syntheticPin]).find(
			(defect) => defect.case === caseName && defect.culture === subject.culture
		)!;
		return { ...subject, ...JSON.parse(JSON.stringify(defect.actual)) };
	});
	const expected = { ...plan.expectations, subjects: intent };
	const active = intent;
	const differences = diffCorpus(expected, actual);
	assert.deepEqual(triageCorpusDifferences(differences, active, [], [syntheticPin]), {
		unexpected: [],
		stale: [],
		pinned: {
			total: intent.length,
			byDefect: { "synthetic-whitespace": intent.length }
		}
	});
	const fixed = diffCorpus(expected, [intent[0]!, ...actual.slice(1)]);
	assert.equal(triageCorpusDifferences(fixed, active, [], [syntheticPin]).stale.length, 1);
	const drift = diffCorpus(expected, [
		{ ...actual[0], source: "unrelated regression" },
		...actual.slice(1)
	]);
	assert.equal(triageCorpusDifferences(drift, active, [], [syntheticPin]).unexpected.length, 1);
	// A second copy of a pinned result is still a failure, even when it matches the defect.
	const twice = triageCorpusDifferences(
		diffCorpus(expected, [...actual, actual[0]!]),
		active,
		[],
		[syntheticPin]
	);
	assert.equal(twice.unexpected.length, 1);
	assert.equal(twice.stale.length, 0);
	assert.equal(twice.pinned.total, intent.length);
});
test("after-phase edits cover sources, PO, archives, additions and deletions with stable identities", () => {
	const before = planCorpus({ ...options, lines: 10_000, density: 2 });
	const after = planCorpus({ ...options, lines: 10_000, density: 2, phase: "after" });
	assert.deepEqual(before.edits, after.edits);
	assert.deepEqual(
		new Set(before.edits.operations.map((edit) => edit.kind)),
		new Set(["source", "po", "archive", "add_package", "delete_package", "resolve_conflict"])
	);
	assert.ok(after.edits.changedFiles.some((path) => path.endsWith(".po")));
	const old = new Map(before.packages.map((owner) => [owner.path, owner]));
	for (const owner of after.packages)
		if (
			!after.edits.packages.includes(owner.path) &&
			!after.edits.deletedPackages.includes(owner.path)
		)
			assert.deepEqual(owner, old.get(owner.path));
	assert.notDeepEqual(before.edits, planCorpus({ ...options, seed: 2, lines: 10_000 }).edits);
	assert.ok(
		after.expectations.subjects.some(
			(subject) => subject.case === "edit-source" && subject.state === "changed_since_gather"
		)
	);
	assert.ok(
		after.expectations.subjects.some(
			(subject) => subject.case === "edit-deleted-package" && subject.state === "not_found"
		)
	);
});

test("the smallest plan still plants every edit and lists every patched package", () => {
	for (const lines of [1, 10_000]) {
		const before = planCorpus({ ...options, lines, density: 1 });
		const after = planCorpus({ ...options, lines, density: 1, phase: "after" });
		assert.deepEqual(before.edits, after.edits);
		assert.deepEqual(
			new Set(after.edits.operations.map((edit) => edit.kind)),
			new Set([
				"source",
				"po",
				"archive",
				"add_package",
				"delete_package",
				"resolve_conflict"
			])
		);
		for (const path of [...after.edits.packages, ...after.edits.deletedPackages])
			assert.ok(after.edits.changedFiles.includes(`Content/${path.slice(6)}.uasset`), path);
		assert.ok(
			after.expectations.subjects.some(
				(subject) =>
					subject.case === "edit-source" && subject.state === "changed_since_gather"
			)
		);
	}
});

test("collapse-mode intent is current for unique namespace/source pairs", () => {
	const collapse = planCorpus({ ...options, scenario: "collapse" });
	assert.equal(collapse.lines, 2);
	assert.ok(collapse.expectations.subjects.every((subject) => subject.state === "translated"));
	assert.match(
		corpusLocalization(collapse).files["Config/Localization/UEShedCorpus_Gather.ini"]!,
		/IdenticalNamespaceAndSource/u
	);
});

test("translation stages keep their own values and lag facts", () => {
	const stages = (name: string) =>
		plan.expectations.subjects.filter((subject) => subject.case === `${name}@0`);
	const pending = stages("po-awaiting-import").find(
		(subject) => subject.stages.importPending
	)!.stages;
	assert.notEqual(pending.po, pending.archive);
	assert.equal(pending.archive, pending.compiled);
	const compile = stages("resource-not-compiled").find(
		(subject) => subject.stages.compilePending
	)!.stages;
	assert.equal(compile.po, compile.archive);
	assert.notEqual(compile.archive, compile.compiled);
	assert.ok(
		stages("package-namespace").every(
			({ stages }) => stages.po === stages.archive && stages.archive === stages.compiled
		)
	);
});

test("today's diff compares exposed stages and the future diff can compare every stage", () => {
	const subject = plan.expectations.subjects[0]!;
	const expected = { ...plan.expectations, subjects: [subject] };
	const changed = {
		...subject,
		stages: { ...subject.stages, compiled: "a different compiled value", compilePending: true }
	};
	assert.deepEqual(diffCorpus(expected, [changed]), []);
	assert.equal(diffCorpus(expected, [changed], true).length, 1);
	assert.equal(
		diffCorpus(expected, [
			{ ...subject, stages: { ...subject.stages, po: "unexpected PO edit" } }
		]).length,
		1
	);
	assert.equal(
		diffCorpus(expected, [{ ...subject, stages: { ...subject.stages, archive: null } }]).length,
		1
	);
});

test("boundary recipes state which side finds a problem", () => {
	const has = (name: string, check: string) =>
		plan.expectations.subjects.some(
			(subject) =>
				subject.case === `${name}@0` &&
				subject.findings.some((finding) => finding.check === `localization.${check}`)
		);
	assert.deepEqual(
		[6, 7, 8].map((n) => has(`ratio-lower-${n}`, "length_outlier")),
		[true, false, false]
	);
	assert.deepEqual(
		[59, 60, 61].map((n) => has(`ratio-upper-${n}`, "length_outlier")),
		[false, false, true]
	);
	assert.deepEqual(
		[4, 5, 6].map((n) => has(`compact-ratio-${n}`, "length_outlier")),
		[true, false, false]
	);
	assert.deepEqual(
		[23, 24, 25].map((n) => has(`placeholder-maximum-${n}`, "placeholder_translation")),
		[true, true, false]
	);
	assert.deepEqual(
		[2, 3, 4].map((n) => has(`placeholder-visible-words-${n}`, "placeholder_translation")),
		[false, true, true]
	);
	assert.deepEqual(
		[2, 3, 4].map((n) => has(`inconsistent-length-${n}-2`, "inconsistent_translation")),
		[false, true, true]
	);
	assert.deepEqual(
		[3, 4, 5].map((n) => has(`inconsistent-words-${n}-2`, "inconsistent_translation")),
		[true, true, false]
	);
	assert.equal(has("inconsistent-visible-words-2", "inconsistent_translation"), true);
	assert.equal(has("po-latest-check", "format_arguments"), true);
});

test("manifest contexts follow Unreal key metadata identity, retaining only the first place", () => {
	const files = corpusLocalization(plan).files;
	const manifest = JSON.parse(files["Content/Localization/UEShedCorpus/UEShedCorpus.manifest"]!);
	for (const namespace of manifest.Subnamespaces) {
		const contexts = namespace.Children.flatMap((child: { Keys: { Key: string }[] }) =>
			child.Keys.map((key) => key.Key)
		);
		assert.equal(contexts.length, new Set(contexts).size);
	}
});

test("every native signal, localization state, text problem and source kind appears", () => {
	const subjects = plan.expectations.subjects;
	for (const signal of [
		"shared",
		"duplicate_source",
		"long",
		"unresolved",
		"conflicting",
		"evidence_only",
		"compiled_copy_differs"
	])
		assert.ok(
			subjects.some((subject) => subject.signals.includes(signal)),
			signal
		);
	for (const state of [
		"not_gathered",
		"changed_since_gather",
		"not_found",
		"not_translated",
		"needs_update",
		"not_synced",
		"unknown",
		"translated",
		"gathered_only",
		"outside_target"
	])
		assert.ok(
			subjects.some((subject) => subject.state === state),
			state
		);
	for (const problem of [
		"key_changed",
		"conflicting_source",
		"not_gathered",
		"changed_since_gather",
		"translation",
		"finding",
		"unchecked",
		"up_to_date"
	])
		assert.ok(
			subjects.some((subject) => subject.problems.includes(problem)),
			problem
		);
	assert.deepEqual(
		new Set(subjects.map((subject) => subject.kind)),
		new Set([
			"stringTableEntry",
			"dataTableCell",
			"blueprintVariable",
			"blueprintPin",
			"widgetText",
			"manifest"
		])
	);
});
test("diff evidence is exact even when finding IDs and counts match", () => {
	const subject = plan.expectations.subjects.find((subject) => subject.findings.length)!;
	const expected = { ...plan.expectations, subjects: [subject] };
	const first = subject.findings[0]!;
	const changed = {
		...subject,
		findings: [{ ...first, actual: { wrongEvidence: true } }, ...subject.findings.slice(1)]
	};
	assert.equal(diffCorpus(expected, [changed]).length, 1);
	const malformed = {
		...plan.expectations,
		subjects: [{ ...subject, stages: { ...subject.stages, compiled: 123 } }]
	};
	assert.throws(() => decodeCorpusExpectations(JSON.stringify(malformed)));
});

test("canonical seed covers every recipe and source kind; density repeats recipes independently", () => {
	const doubled = planCorpus({ ...options, density: 2 });
	const recipes = (p: typeof plan) =>
		new Set(
			p.packages.flatMap((owner) =>
				owner.texts
					.filter((text) => text.instance === 0)
					.map((text) => text.case.split("@")[0])
			)
		);
	assert.deepEqual(recipes(doubled), recipes(plan));
	assert.equal(
		new Set(
			plan.packages.flatMap((owner) =>
				owner.texts
					.filter((text) => text.instance === 0)
					.map((text) => text.case.split("@")[0])
			)
		).size,
		161
	);
	assert.deepEqual(
		new Set(plan.packages.flatMap((owner) => owner.texts.map((text) => text.kind))),
		new Set([
			"stringTableEntry",
			"dataTableCell",
			"blueprintVariable",
			"blueprintPin",
			"widgetText",
			"manifest"
		])
	);
	const sources = new Map<string, number>();
	for (const owner of doubled.packages)
		for (const text of owner.texts)
			if (text.source && text.instance >= 0) {
				const previous = sources.get(text.source);
				assert.ok(
					previous === undefined || previous === text.instance,
					`Cross-instance source collision: ${text.source}`
				);
				sources.set(text.source, text.instance);
			}
});
test("seeds vary constructor parameters, cultures, syntax slots, placements and edits", () => {
	const samples = [1, 2, 3, 4, 5].map((seed) => planCorpus({ ...options, seed }));
	for (const recipe of [
		"format-missing",
		"format-added",
		"format-renamed",
		"long-38",
		"ratio-lower-6",
		"placeholder-maximum-23",
		"rich-tag-missing",
		"translation-boundary-space"
	])
		assert.ok(
			new Set(
				samples.map((p) =>
					JSON.stringify(
						p.packages.flatMap((owner) =>
							owner.texts
								.filter((text) => text.case === `${recipe}@0`)
								.map((text) => [
									text.source,
									text.kind,
									text.parameters,
									text.cultures
								])
						)
					)
				)
			).size > 1,
			recipe
		);
});

test("maximum density keeps literal groups and subject identities separate", () => {
	const dense = planCorpus({ ...options, density: 12, lines: 1 });
	assert.equal(
		new Set(dense.expectations.subjects.map(subjectKey)).size,
		dense.expectations.subjects.length
	);
	const sources = new Map<string, number>();
	for (const owner of dense.packages)
		for (const text of owner.texts) {
			if (!text.source || text.instance < 0) continue;
			const prior = sources.get(text.source);
			assert.ok(
				prior === undefined || prior === text.instance,
				`Cross-instance source collision: ${text.source}`
			);
			sources.set(text.source, text.instance);
		}
	assert.throws(() => planCorpus({ ...options, density: 0 }), /density/iu);
	assert.throws(() => planCorpus({ ...options, density: 13 }), /density/iu);
});

test("each Blueprint variable contributes its own editor category scaffold", () => {
	for (const owner of plan.packages) {
		const variables = owner.texts.filter(
			(text) => text.kind === "blueprintVariable" && text.mode !== "scaffold"
		);
		const scaffolds = owner.texts.filter((text) => text.mode === "scaffold");
		assert.equal(scaffolds.length, variables.length);
		for (const variable of variables) {
			const scaffold = scaffolds.find(
				(text) => text.case === `blueprint-empty-category@${variable.key}`
			);
			assert.ok(scaffold);
			assert.notEqual(scaffold.field, variable.field);
			assert.equal(scaffold.source, "");
			for (const mark of Object.values(scaffold.cultures)) {
				assert.equal(mark.state, "unknown");
				assert.deepEqual(mark.unknownReasons, ["unresolved_identity"]);
				assert.deepEqual(mark.findings, []);
			}
		}
	}
});

test("line-page defect assertions retain culture scope independently of compiled pin copies", () => {
	const variety = planCorpus({ ...options, seed: 73131, density: 5, lines: 1000 });
	const probes = variety.probes.map((probe) => ({
		case: probe.case,
		subject: `probe:${probe.kind}:${probe.culture}`,
		expected: probe.expected,
		actual: null
	}));
	const defects = corpusDefectsFor(variety.expectations.subjects, probes);
	for (const subject of variety.expectations.subjects.filter(
		(subject) => subject.case.startsWith("archive-missing-entry@") && subject.culture === "en"
	)) {
		const defect = defects.find(
			(defect) => defect.kind === "probe" && defect.case === subject.case
		);
		assert.ok(defect);
		assert.deepEqual(defect.rightAnswer, ["up_to_date"]);
		assert.deepEqual(defect.actual, ["translation"]);
	}
});

test("known-defect assertions use set semantics for signals while retaining exact evidence", () => {
	const planted = plan.expectations.subjects.find(
		(subject) =>
			subject.case === "empty-with-source-edge@0" &&
			subject.findings.some((finding) => finding.check === "localization.empty_translation")
	);
	assert.ok(planted);
	const subject = { ...planted, signals: ["long", "evidence_only"] };
	const expected = { ...plan.expectations, subjects: [subject] };
	const actual = {
		...subject,
		...JSON.parse(JSON.stringify(corpusDefectsFor([subject], [], [syntheticPin])[0]!.actual)),
		signals: [...subject.signals].reverse()
	};
	const result = triageCorpusDifferences(
		diffCorpus(expected, [actual]),
		[subject],
		[],
		[syntheticPin]
	);
	assert.deepEqual(result, {
		unexpected: [],
		stale: [],
		pinned: { total: 1, byDefect: { "synthetic-whitespace": 1 } }
	});
	assert.equal(triageCorpusDifferences([], [subject], [], [syntheticPin]).stale.length, 1);
});

test("background subjects require no defect pins, including their pure pin placements", () => {
	const background = plan.expectations.subjects.filter(
		(subject) => subject.case === "background"
	);
	assert.ok(background.length);
	assert.deepEqual(corpusDefectsFor(background), []);
	const pins = background.filter((subject) => subject.kind === "blueprintPin");
	assert.ok(pins.length);
	assert.ok(
		pins.every(
			(subject) => subject.field.startsWith("TextToUpper_") && subject.state === "translated"
		)
	);
	// A future accidental native override outside the named recipe cannot acquire a blanket pin.
	assert.deepEqual(
		corpusDefectsFor(
			background.map((subject) =>
				subject.culture === "en"
					? {
							...subject,
							stages: { ...subject.stages, archive: "Outside the override recipe" }
						}
					: subject
			)
		),
		[]
	);
});

test("native-source override recipes separate current native-keyed and stale raw-keyed archives", () => {
	for (const near of [false, true]) {
		const name = `${near ? "native-source-override-near" : "native-source-override"}@0`;
		const text = texts.find((text) => text.case === name)!;
		const native = text.cultures.en!.translation;
		assert.notEqual(native, text.source);
		for (const culture of ["de", "fr", "ja"]) {
			const mark = text.cultures[culture]!;
			assert.equal(mark.expectedSource, native);
			assert.equal(mark.archiveSource, near ? text.source : native);
			assert.equal(mark.poEntry, false);
			assert.equal(mark.state, near ? "needs_update" : "translated");
			assert.deepEqual(
				mark.findings,
				near
					? [
							{
								check: "localization.outdated_translation",
								actual: { translatedSource: text.source },
								expectation: { source: native }
							}
						]
					: []
			);
		}
	}
	const localization = corpusLocalization(plan);
	const config = localization.files[`Config/Localization/${plan.target}_Gather.ini`]!;
	assert.match(config, /ShouldGatherFromEditorOnlyData=true/u);
	const outside = plan.packages.find((owner) =>
		owner.texts.some((text) => text.case === "blueprint-pin@0")
	)!;
	assert.ok(
		config.includes(
			`ExcludePathFilters=%LOCPROJECTROOT%Content/${outside.path.slice(6)}.uasset`
		)
	);
});

test("canonical compare output reports the number and classes of pinned disagreements", () => {
	const collapse = planCorpus({ ...options, scenario: "collapse", lines: 1 });
	const subjects = [...plan.expectations.subjects, ...collapse.expectations.subjects];
	const probes = plan.probes.map((probe) => ({
		case: probe.case,
		subject: `probe:${probe.kind}:${probe.culture}`,
		expected: probe.expected,
		actual: probe.expected
	}));
	const defects = corpusDefectsFor(subjects, probes);
	const lookup = new Map(defects.map((defect) => [`${defect.case}\0${defect.subject}`, defect]));
	const current = subjects.map((subject) => {
		const defect = lookup.get(`${subject.case}\0${subjectKey(subject)}`);
		return defect ? { ...subject, ...JSON.parse(JSON.stringify(defect.actual)) } : subject;
	});
	const differences = [
		...diffCorpus({ ...plan.expectations, subjects }, current),
		...probes.flatMap((probe) => {
			const defect = lookup.get(`${probe.case}\0${probe.subject}`);
			return defect ? [{ ...probe, actual: defect.actual }] : [];
		})
	];
	const result = triageCorpusDifferences(differences, subjects, probes);
	assert.deepEqual(result.unexpected, []);
	assert.deepEqual(result.stale, []);
	assert.equal(result.pinned.total, defects.length);
	assert.equal(result.pinned.byDefect["native-source-override"], undefined);
	const output = formatCorpusComparisonSummary(
		subjects.length,
		differences.length,
		result.pinned
	);
	assert.ok(output.includes(`${defects.length} pinned disagreements`));
	assert.equal(result.pinned.total, differences.length);
});
