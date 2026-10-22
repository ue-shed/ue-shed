import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonObject } from "./json.ts";
import { assertLocalizationIntent } from "./localization-fixture-evidence.ts";
import {
	gameTextActionsFixtureSteps,
	gameTextProblemsFixtureSteps,
	localizationFixtureSteps
} from "./localization-fixture-steps.ts";

const fixture = new URL("../fixtures/unreal-project/", import.meta.url);

test("no GatherText process runs two report steps that write the same file", () => {
	const project = fileURLToPath(new URL("UEShedFixture.uproject", fixture));
	const steps = [
		...localizationFixtureSteps(project, "evidence"),
		...gameTextProblemsFixtureSteps(project),
		...gameTextActionsFixtureSteps(project, "evidence")
	];
	for (const step of steps) {
		const configs = step.find((argument) => argument.startsWith("-config="));
		if (configs === undefined) continue;
		// GatherText runs every config's report steps as parallel tasks of its final phase.
		const reports = configs
			.slice("-config=".length)
			.split(";")
			.flatMap((path) => [
				...readFileSync(path, "utf8").matchAll(/^\w+ReportName=(.+?)\s*$/gmu)
			])
			.map((match) => match[1]);
		assert.deepEqual(reports, [...new Set(reports)], configs);
	}
});
const intent = parseJsonObject(
	readFileSync(new URL("FixtureSource/Localization/expected-states.json", fixture), "utf8")
);

for (const version of ["5.7", "5.8"]) {
	test(`Unreal ${version} localization evidence covers the authored states`, () => {
		const evidence = parseJsonObject(
			readFileSync(
				new URL(`FixtureExpected/localization/evidence.ue${version}.json`, fixture),
				"utf8"
			)
		);
		assert.equal(evidence.engineVersion, version);
		assertLocalizationIntent(evidence, intent);
	});
}

test("localization evidence rejects malformed fields before evaluating states", () => {
	const contents = readFileSync(
		new URL("FixtureExpected/localization/evidence.ue5.8.json", fixture),
		"utf8"
	);
	const booleanAsText = parseJsonObject(
		contents.replace('"packageReadable": true', '"packageReadable": "true"')
	);
	assert.throws(() => assertLocalizationIntent(booleanAsText, intent), /packageReadable/);
	const numericComment = parseJsonObject(
		contents.replace(/("poExtractedComments":\s*\[)[\s\S]*?\]/u, "$1 12]")
	);
	assert.throws(() => assertLocalizationIntent(numericComment, intent), /poExtractedComments/);
	const numericSource = parseJsonObject(
		contents.replace('"manifestSource": "Confirm"', '"manifestSource": 12')
	);
	assert.throws(() => assertLocalizationIntent(numericSource, intent), /manifestSource/);
	const invalidValidator = parseJsonObject(
		contents.replace('"translationRichTextValid": true', '"translationRichTextValid": "true"')
	);
	assert.throws(
		() => assertLocalizationIntent(invalidValidator, intent),
		/translationRichTextValid/
	);
	const invalidArguments = parseJsonObject(
		contents.replace(/("arguments":\s*\[)[\s\S]*?\]/u, "$1 12]")
	);
	assert.throws(() => assertLocalizationIntent(invalidArguments, intent), /arguments/);
	assert.throws(
		() => assertLocalizationIntent(parseJsonObject(contents), { ...intent, schemaVersion: 2 }),
		/schemaVersion/
	);
	assert.throws(
		() =>
			assertLocalizationIntent(parseJsonObject(contents), {
				...intent,
				entries: [{ culture: "en", namespace: "Example", key: "Line", state: "invalid" }]
			}),
		/state/
	);
});
