import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
	decodeReviewAssessmentCapabilities,
	decodeReviewCaptureRequest,
	decodeReviewCaptureResponse,
	decodeReviewSelectionResponse,
	decodeReviewSubjectInspectionResponse,
	ReviewSubjectProjection
} from "./review-schema.js";

const contractDirectory = fileURLToPath(
	new URL("../../protocol/contracts/cameras/review/v1/", import.meta.url)
);

function json(path: string): Schema.Json {
	return Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(readFileSync(`${contractDirectory}${path}`, "utf8"))
	);
}

const decodeCapture = (input: Schema.Json) => Effect.runSync(decodeReviewCaptureResponse(input));
const decodeCaptureRequest = (input: Schema.Json) =>
	Effect.runSync(decodeReviewCaptureRequest(input));
const decodeAssessmentCapabilities = (input: Schema.Json) =>
	Effect.runSync(decodeReviewAssessmentCapabilities(input));
const decodeSubject = (input: Schema.Json) =>
	Effect.runSync(decodeReviewSubjectInspectionResponse(input));

describe("Map Review language-neutral wire contracts", () => {
	it("keeps operation UUIDs and actor GUID locators exact", () => {
		// SAFETY: this checked-in schema document owns the properties inspected by the test.
		const contract = json("capture-request.schema.json") as {
			readonly properties: {
				readonly operationId: Schema.JsonObject;
				readonly subject: { readonly oneOf: readonly Schema.JsonObject[] };
			};
		};
		expect(contract.properties.operationId).toMatchObject({
			format: "uuid",
			not: { const: "00000000-0000-0000-0000-000000000000" },
			pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
		});
		expect(contract.properties.subject.oneOf[0]).toMatchObject({
			properties: {
				actorGuid: {
					pattern: "^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{8}){3}$"
				},
				diagnosticLabel: { minLength: 1, type: "string" },
				lastKnownActorPath: {
					maxLength: 4_096,
					minLength: 7,
					pattern: "^/Game/",
					type: "string"
				}
			}
		});
		for (const fixture of [
			"invalid-capture-request-alternate-actor-guid.json",
			"invalid-capture-request-empty-diagnostic-label.json",
			"invalid-capture-request-malformed-last-known-path.json",
			"invalid-capture-request-nil-operation-id.json"
		]) {
			expect(() => decodeCaptureRequest(json(`fixtures/${fixture}`))).toThrow();
		}
	});

	it("keeps capture projection and visibility variants strict across compatible minors", () => {
		// SAFETY: this checked-in schema document owns the properties inspected by the test.
		const contract = json("capture-response.schema.json") as {
			readonly $defs: {
				readonly subjectProjection: { readonly oneOf: readonly Schema.JsonObject[] };
			};
			readonly oneOf: readonly {
				readonly allOf?: readonly {
					readonly then: { readonly required: readonly string[] };
				}[];
				readonly required?: readonly string[];
				readonly properties: { readonly subjectProjection: { readonly $ref: string } };
			}[];
		};
		const currentSuccess = contract.oneOf[0]!;
		const legacySuccess = contract.oneOf[3]!;
		expect(currentSuccess.properties.subjectProjection).toEqual({
			$ref: "#/$defs/subjectProjection"
		});
		expect(currentSuccess.required).toEqual(
			expect.arrayContaining([
				"clearCompanion",
				"effectiveWorldPose",
				"resolvedSubject",
				"stagedArtifacts",
				"subjectProjection",
				"visibility"
			])
		);
		expect(legacySuccess.allOf?.[0]?.then.required).toContain("subjectProjection");
		expect(contract.$defs.subjectProjection.oneOf).toHaveLength(2);
		for (const variant of contract.$defs.subjectProjection.oneOf) {
			expect(variant.additionalProperties).toBe(false);
		}

		const projected = decodeCapture(json("fixtures/capture-projected.json"));
		expect(projected).toMatchObject({
			contract: { version: { minor: 1 } },
			subjectProjection: { status: "projected", viewportStatus: "fully_within_viewport" }
		});
		const unprojectable = decodeCapture(json("fixtures/capture-unprojectable.json"));
		expect(unprojectable).toMatchObject({
			subjectProjection: { code: "near_plane_crossing", status: "unprojectable" }
		});
		expect(decodeCapture(json("fixtures/capture-legacy.json"))).not.toHaveProperty(
			"subjectProjection"
		);
		expect(decodeCapture(json("fixtures/capture-assessed.json"))).toMatchObject({
			contract: { version: { minor: 3 } },
			resolvedSubject: { kind: "actor_path" },
			visibility: {
				method: { method: "ray_samples", version: 1 },
				status: "assessed"
			}
		});
		expect(decodeCapture(json("fixtures/capture-assessed-v2.json"))).toMatchObject({
			contract: { version: { minor: 2 } },
			visibility: { classification: "partial", status: "assessed" }
		});
		expect(decodeCapture(json("fixtures/capture-area.json"))).toMatchObject({
			resolvedSubject: { kind: "oriented_bounds" },
			visibility: { status: "not_assessed" }
		});
		expect(decodeCapture(json("fixtures/capture-clear.json"))).toMatchObject({
			clearCompanion: {
				restoration: { status: "restored" },
				status: "captured",
				strategy: "hide_explicit"
			},
			contract: { version: { minor: 4 } },
			stagedArtifacts: expect.arrayContaining([
				expect.objectContaining({ variant: "pure" }),
				expect.objectContaining({ variant: "clear" })
			])
		});
		expect(decodeCapture(json("fixtures/capture-clear-failed.json"))).toMatchObject({
			clearCompanion: {
				failure: { code: "clear_actor_not_found", retrySafe: true },
				status: "failed"
			},
			stagedArtifacts: [expect.objectContaining({ variant: "pure" })]
		});
		expect(
			decodeCaptureRequest(json("fixtures/capture-request-guid-valid.json"))
		).toMatchObject({
			contract: { version: { minor: 5 } },
			subject: {
				actorGuid: "00000001-00000002-00000003-00000004",
				kind: "actor_guid"
			}
		});
		expect(decodeCapture(json("fixtures/capture-guid.json"))).toMatchObject({
			contract: { version: { minor: 5 } },
			resolvedSubject: {
				actorGuid: "00000001-00000002-00000003-00000004",
				kind: "actor_guid"
			}
		});

		expect(
			Schema.decodeUnknownResult(ReviewSubjectProjection)({
				status: "projected",
				viewportStatus: "fully_within_viewport",
				normalizedBounds: { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.8 }
			})._tag
		).toBe("Failure");
	});

	it("records InspectReviewSubject failures without broadening ambient selection failures", () => {
		// SAFETY: this checked-in schema document owns the properties inspected by the test.
		const contract = json("selection-response.schema.json") as {
			readonly oneOf: readonly {
				readonly properties?: { readonly code?: { readonly enum?: readonly string[] } };
			}[];
		};
		const failureCodes = contract.oneOf[1]?.properties?.code?.enum;
		expect(failureCodes).toEqual(expect.arrayContaining(["map_mismatch", "subject_not_found"]));
		const subjectFailure = json("fixtures/selection-subject-not-found.json");
		expect(decodeSubject(subjectFailure)).toMatchObject({
			code: "subject_not_found",
			status: "failed"
		});
		expect(() => Effect.runSync(decodeReviewSelectionResponse(subjectFailure))).toThrow();
		expect(
			Effect.runSync(decodeReviewSelectionResponse(json("fixtures/selection-selected.json")))
		).toMatchObject({
			actorGuid: "00000001-00000002-00000003-00000004",
			status: "selected"
		});
	});

	it("keeps optional assessment capabilities factual and policy-free", () => {
		// SAFETY: this checked-in schema document owns the properties inspected by the test.
		const contract = json("assessment-capabilities.schema.json") as {
			readonly $defs: {
				readonly methodCapability: { readonly oneOf: readonly Schema.JsonObject[] };
			};
		};
		expect(contract.$defs.methodCapability.oneOf).toHaveLength(2);

		const capabilities = decodeAssessmentCapabilities(
			json("fixtures/assessment-capabilities.json")
		);
		expect(capabilities).toMatchObject({
			contract: {
				name: "ue-shed-review-assessment-capabilities",
				version: { major: 1, minor: 0 }
			},
			depthCompareMaximumResolution: { height: 180, width: 320 }
		});
		expect(capabilities.methods).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					effectiveMethod: { method: "depth_compare", version: 1 },
					requestedMethod: "automatic",
					status: "supported"
				}),
				expect.objectContaining({
					requestedMethod: "subject_mask",
					status: "unsupported"
				})
			])
		);
		expect(() =>
			decodeAssessmentCapabilities(
				json(
					"fixtures/invalid-assessment-capabilities-supported-without-effective-method.json"
				)
			)
		).toThrow();
	});
});
