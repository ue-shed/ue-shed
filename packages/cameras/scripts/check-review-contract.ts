import { deepStrictEqual } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import {
	ReviewAssessmentCapabilities,
	ReviewCaptureRequest,
	ReviewCaptureResponse,
	ReviewSelectionResponse,
	ReviewSubjectInspectionResponse
} from "../src/review-schema.js";
import {
	MapCapturePlan,
	MapTileCaptureRequest,
	MapTileCaptureOperation,
	MapTileCaptureResponse,
	MapTilePyramidManifest
} from "../src/map-tile-schema.js";
import { ProvisionedCameraRequest } from "../src/provisioned-cameras-live.js";

const fixturesDirectory = fileURLToPath(
	new URL("../../protocol/contracts/cameras/review/v1/fixtures/", import.meta.url)
);
const provisioningFixturesDirectory = fileURLToPath(
	new URL("../../protocol/contracts/cameras/provisioning/v1/fixtures/", import.meta.url)
);
const mapTileFixturesDirectory = fileURLToPath(
	new URL("../../protocol/contracts/cameras/map-tile/v1/fixtures/", import.meta.url)
);

type WireSchema = Schema.Top;

const validFixtures: ReadonlyArray<{
	readonly file: string;
	readonly schema: WireSchema;
}> = [
	{ file: "capture-request-area-valid.json", schema: ReviewCaptureRequest },
	{ file: "capture-request-relative-valid.json", schema: ReviewCaptureRequest },
	{ file: "capture-request-clear-valid.json", schema: ReviewCaptureRequest },
	{ file: "capture-request-guid-valid.json", schema: ReviewCaptureRequest },
	{ file: "capture-request-valid.json", schema: ReviewCaptureRequest },
	{ file: "assessment-capabilities.json", schema: ReviewAssessmentCapabilities },
	{ file: "capture-area.json", schema: ReviewCaptureResponse },
	{ file: "capture-clear.json", schema: ReviewCaptureResponse },
	{ file: "capture-clear-failed.json", schema: ReviewCaptureResponse },
	{ file: "capture-guid.json", schema: ReviewCaptureResponse },
	{ file: "capture-assessed.json", schema: ReviewCaptureResponse },
	{ file: "capture-assessed-v2.json", schema: ReviewCaptureResponse },
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
	{
		file: "invalid-assessment-capabilities-supported-without-effective-method.json",
		schema: ReviewAssessmentCapabilities
	},
	{ file: "invalid-capture-request-bad-fov.json", schema: ReviewCaptureRequest },
	{
		file: "invalid-capture-request-clear-before-minor-4.json",
		schema: ReviewCaptureRequest
	},
	{
		file: "invalid-capture-request-alternate-actor-guid.json",
		schema: ReviewCaptureRequest
	},
	{
		file: "invalid-capture-request-empty-diagnostic-label.json",
		schema: ReviewCaptureRequest
	},
	{
		file: "invalid-capture-request-future-minor.json",
		schema: ReviewCaptureRequest
	},
	{
		file: "invalid-capture-request-guid-before-minor-5.json",
		schema: ReviewCaptureRequest
	},
	{
		file: "invalid-capture-request-malformed-last-known-path.json",
		schema: ReviewCaptureRequest
	},
	{
		file: "invalid-capture-request-nil-operation-id.json",
		schema: ReviewCaptureRequest
	},
	{
		file: "invalid-capture-request-nil-actor-guid.json",
		schema: ReviewCaptureRequest
	},
	{
		file: "invalid-capture-response-projected-without-margins.json",
		schema: ReviewCaptureResponse
	},
	{ file: "invalid-selection-unknown-code.json", schema: ReviewSubjectInspectionResponse }
];

function readJson(file: string): Schema.Json {
	return Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(readFileSync(join(fixturesDirectory, file), "utf8"))
	);
}

function roundTrip(schema: WireSchema, input: Schema.Json): Schema.Json {
	const decoded = Schema.decodeUnknownSync(schema)(input, { onExcessProperty: "error" });
	return Schema.decodeUnknownSync(Schema.Json)(Schema.encodeUnknownSync(schema)(decoded));
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
	const result = Schema.decodeUnknownResult(schema)(fixture, { onExcessProperty: "error" });
	if (result._tag !== "Failure") {
		throw new Error(`invalid fixture ${file} was accepted by Effect schema`);
	}
}

// SAFETY: this repository fixture is decoded by the matching protocol schema below.
const provisioningFixture = JSON.parse(
	readFileSync(join(provisioningFixturesDirectory, "provision-request-valid.json"), "utf8")
) as unknown;
try {
	deepStrictEqual(roundTrip(ProvisionedCameraRequest, provisioningFixture), provisioningFixture);
} catch (cause) {
	throw new Error("provisioned camera request failed JSON/Effect compatibility", { cause });
}

const mapTileFixtures: ReadonlyArray<{
	readonly file: string;
	readonly schema: WireSchema;
}> = [
	{ file: "plan-valid.json", schema: MapCapturePlan },
	{ file: "capture-request-valid.json", schema: MapTileCaptureRequest },
	{ file: "capture-request-lit-valid.json", schema: MapTileCaptureRequest },
	{ file: "capture-operation-running-valid.json", schema: MapTileCaptureOperation },
	{ file: "capture-operation-finished-valid.json", schema: MapTileCaptureOperation },
	{ file: "capture-response-valid.json", schema: MapTileCaptureResponse },
	{ file: "manifest-valid.json", schema: MapTilePyramidManifest }
];
for (const { file, schema } of mapTileFixtures) {
	// SAFETY: this repository fixture is decoded by the matching review schema below.
	const fixture = JSON.parse(
		readFileSync(join(mapTileFixturesDirectory, file), "utf8")
	) as unknown;
	try {
		deepStrictEqual(roundTrip(schema, fixture), fixture);
	} catch (cause) {
		throw new Error(`map tile fixture ${file} failed JSON/Effect decode-encode parity`, {
			cause
		});
	}
}
for (const file of ["manifest-invalid-grid.json", "manifest-invalid-complete.json"]) {
	// SAFETY: this repository fixture is decoded by the matching review schema below.
	const fixture = JSON.parse(
		readFileSync(join(mapTileFixturesDirectory, file), "utf8")
	) as unknown;
	if (Schema.decodeUnknownResult(MapTilePyramidManifest)(fixture)._tag !== "Failure") {
		throw new Error(`invalid map tile fixture ${file} was accepted by Effect schema`);
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
	`review contract parity: ${validFixtures.length} valid, ${invalidFixtures.length} invalid; provisioned v3; map-tile v1 (${mapTileFixtures.length} valid, 2 invalid)`
);
