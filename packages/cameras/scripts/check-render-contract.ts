import { deepStrictEqual } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Schema } from "effect";
import * as Render from "../src/camera-render-schema.js";
import * as Review from "../src/review-render.js";
import { MapTileReleaseResult } from "../src/map-tile-schema.js";

const directory = fileURLToPath(
	new URL("../../protocol/contracts/cameras/render/v1/", import.meta.url)
);
const releaseDocument = Schema.toJsonSchemaDocument(MapTileReleaseResult);
deepStrictEqual(
	JSON.parse(
		readFileSync(join(directory, "../../map-tile/v1/release-result.schema.json"), "utf8")
	),
	{
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "https://ue-shed.dev/contracts/cameras/map-tile/v1/release-result.schema.json",
		...releaseDocument.schema,
		$defs: releaseDocument.definitions
	}
);
const contracts = {
	"session-request": Render.CameraRenderSessionRequest,
	"frame-request": Render.CameraFrameRequest,
	capabilities: Render.CameraRenderCapabilities,
	preflight: Render.CameraRenderPreflight,
	"begin-result": Render.CameraRenderBeginResult,
	"end-result": Render.CameraRenderEndResult,
	"frame-status": Render.CameraFrameStatus,
	policy: Render.CameraRenderPolicy,
	"frame-evidence": Render.CameraFrameEvidence,
	"review-realization-request": Review.ReviewRealizationRequest,
	"review-realization-result": Review.ReviewRealizationResult,
	"review-inspection-request": Review.ReviewRenderInspectionRequest,
	"review-inspection-result": Review.ReviewRenderInspectionResult
} satisfies Record<string, Schema.Top>;

// JSON files are checked-in wire authorities. This check detects decoder drift; it never rewrites them.
for (const [name, schema] of Object.entries(contracts)) {
	const authoritative = Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(readFileSync(join(directory, `${name}.schema.json`), "utf8"))
	);
	const runtime = Schema.toJsonSchemaDocument(schema);
	deepStrictEqual(
		authoritative,
		{
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: `https://ue-shed.dev/contracts/cameras/render/v1/${name}.schema.json`,
			...runtime.schema,
			$defs: runtime.definitions
		},
		`${name} decoder differs from its wire authority`
	);
}
for (const file of readdirSync(join(directory, "fixtures"))) {
	const input = Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(readFileSync(join(directory, "fixtures", file), "utf8"))
	);
	const schema = file.includes("session-")
		? Render.CameraRenderSessionRequest
		: Render.CameraFrameRequest;
	const decoded = Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" });
	if (file.startsWith("invalid-"))
		deepStrictEqual(decoded._tag, "Failure", `${file} must be rejected`);
	else {
		deepStrictEqual(decoded._tag, "Success", `${file} must decode`);
		if (decoded._tag === "Success")
			deepStrictEqual(
				decoded.success,
				input,
				`${file} must round-trip without dropping fields`
			);
	}
}
