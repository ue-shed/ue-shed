import { describe, expect, it } from "vitest";
import { decodeMapReviewFlowRecordingManifest } from "./map-review-flow-contract.js";

const timestamp = "2026-08-06T10:00:00.000Z";

function validManifest(
	options: {
		readonly failure?: { readonly message: string; readonly name: string };
		readonly omitAttachmentHeight?: boolean;
		readonly path?: string;
	} = {}
): Record<string, unknown> {
	return {
		artifacts: {
			logs: "logs.txt",
			traces: ["traces/segment-01.zip", "traces/segment-02.zip"],
			video: "flow.webm"
		},
		checkpoints: [
			{
				attachments: [
					{
						...(options.omitAttachmentHeight ? {} : { height: 720 }),
						kind: "raw-capture",
						path: options.path ?? "captures/approved.png",
						width: 1280
					}
				],
				completedAt: timestamp,
				description: "The approved pose produced immutable capture evidence.",
				id: "capture-completed",
				identity: {
					artifactId: "artifact-1",
					candidateId: "preset/context-three-quarter/0",
					runId: "run-1",
					sessionId: "session-1",
					viewId: "view-1",
					viewRevisionId: "view-1-r1"
				},
				title: "Capture the persisted view"
			}
		],
		cleanup: {
			mapDirtyAfter: false,
			provisionedCameraCountAfter: 0,
			status: "verified"
		},
		commit: "b4922eb",
		contract: { name: "ue-shed-map-review-flow-recording", version: 1 },
		dirty: false,
		finishedAt: timestamp,
		...(options.failure === undefined ? {} : { failure: options.failure }),
		fixture: {
			map: "/Game/Fixture/MapReview/L_MapReviewFixture",
			subjectKey: "compound"
		},
		flow: "authoring-roundtrip",
		id: "recording-1",
		startedAt: timestamp,
		status: "passed"
	};
}

describe("Map Review flow recording manifest", () => {
	it("decodes relative, identity-linked recording evidence", () => {
		expect(decodeMapReviewFlowRecordingManifest(validManifest())).toMatchObject({
			flow: "authoring-roundtrip",
			status: "passed"
		});
	});

	it.each([
		"C:\\Users\\fixture\\capture.png",
		"/tmp/capture.png",
		"../capture.png",
		"captures/../../capture.png"
	])("rejects artifact paths outside the bundle: %s", (path) => {
		expect(() => decodeMapReviewFlowRecordingManifest(validManifest({ path }))).toThrow();
	});

	it("requires paired image dimensions", () => {
		expect(() =>
			decodeMapReviewFlowRecordingManifest(validManifest({ omitAttachmentHeight: true }))
		).toThrow();
	});

	it("keeps failure data impossible on a passed recording", () => {
		expect(() =>
			decodeMapReviewFlowRecordingManifest(
				validManifest({ failure: { message: "no", name: "Error" } })
			)
		).toThrow();
	});
});
