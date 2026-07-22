import { deepStrictEqual } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import {
	ReviewCaptureRequest,
	ReviewCaptureResponse,
	ReviewSelectionResponse,
	ReviewSubjectInspectionResponse
} from "../src/review-schema.js";

const fixturesDirectory = fileURLToPath(
	new URL("../../protocol/contracts/cameras/review/v1/fixtures/", import.meta.url)
);

type WireSchema = Schema.Top;

const validFixtures: ReadonlyArray<{
	readonly file: string;
	readonly schema: WireSchema;
}> = [
	{ file: "capture-request-valid.json", schema: ReviewCaptureRequest },
	{ file: "capture-projected.json", schema: ReviewCaptureResponse },
	{ file: "capture-unprojectable.json", schema: ReviewCaptureResponse },
	{ file: "capture-legacy.json", schema: ReviewCaptureResponse },
	{ file: "capture-failure.json", schema: ReviewCaptureResponse },
	{ file: "selection-selected.json", schema: ReviewSelectionResponse },
	{ file: "selection-subject-not-found.json", schema: ReviewSubjectInspectionResponse }
];

const invalidFixtures: ReadonlyArray<{
	readonly file: string;
	readonly schema: WireSchema;
}> = [
	{ file: "invalid-capture-request-bad-fov.json", schema: ReviewCaptureRequest },
	{
		file: "invalid-capture-response-projected-without-margins.json",
		schema: ReviewCaptureResponse
	},
	{ file: "invalid-selection-unknown-code.json", schema: ReviewSubjectInspectionResponse }
];

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(join(fixturesDirectory, file), "utf8")) as unknown;
}

function roundTrip(schema: WireSchema, input: unknown): unknown {
	const decoded = Schema.decodeUnknownSync(schema)(input);
	return Schema.encodeUnknownSync(schema)(decoded);
}

for (const { file, schema } of validFixtures) {
	const fixture = readJson(file);
	try {
		deepStrictEqual(roundTrip(schema, fixture), fixture);
	} catch (cause) {
		throw new Error(`valid fixture ${file} failed JSON/Effect decode-encode parity`, {
			cause
		});
	}
}

for (const { file, schema } of invalidFixtures) {
	const fixture = readJson(file);
	const result = Schema.decodeUnknownResult(schema)(fixture);
	if (result._tag !== "Failure") {
		throw new Error(`invalid fixture ${file} was accepted by Effect schema`);
	}
}

const known = new Set([...validFixtures, ...invalidFixtures].map((entry) => entry.file));
const present = readdirSync(fixturesDirectory);
for (const file of present) {
	if (!file.endsWith(".json")) continue;
	if (!known.has(basename(file))) {
		throw new Error(
			`fixture ${file} is not registered in check-review-contract.ts (valid or invalid)`
		);
	}
}

console.log(
	`review contract parity: ${validFixtures.length} valid, ${invalidFixtures.length} invalid`
);
