import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseJsonObject } from "./json.ts";
import { assertLocalizationIntent } from "./localization-fixture-evidence.ts";

const fixture = new URL("../fixtures/unreal-project/", import.meta.url);
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
