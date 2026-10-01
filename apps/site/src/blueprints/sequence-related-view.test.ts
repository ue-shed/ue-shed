import { describe, expect, it } from "vitest";
import { sequenceReadFixture as read } from "../../../../extensions/sequencer/src/sequence-fixture.test-support.js";
import { sequenceRelatedView } from "./sequence-related-view.js";

describe("Sequencer related view", () => {
	it("offers validated partial evidence when tracks or bindings exist", () => {
		expect(sequenceRelatedView(read)).toMatchObject({
			status: "available",
			subtitle: "1 tracks · 1 keys",
			read
		});
		const bindingOnly = {
			...read,
			sequence: {
				...read.sequence,
				root_tracks: [],
				bindings: [
					{
						id: "camera",
						name: "Camera",
						kind: "possessable" as const,
						parent_id: null,
						possessed_object_class: null,
						object_template: null,
						object_template_class: null,
						tracks: []
					}
				]
			}
		};
		expect(sequenceRelatedView(bindingOnly).status).toBe("available");
	});

	it("explains rejected and empty sequences quietly", () => {
		expect(
			sequenceRelatedView({ ...read, sequence: { ...read.sequence, root_tracks: [] } })
		).toMatchObject({
			status: "unavailable",
			message: expect.stringContaining("no saved tracks")
		});
		expect(
			sequenceRelatedView({
				status: "failed",
				reason: "unsupported_asset",
				message: "Saved timeline unsupported",
				recovery: "Inspect in Unreal"
			})
		).toMatchObject({
			status: "unavailable",
			message: "No timeline view: Saved timeline unsupported"
		});
		expect(sequenceRelatedView(undefined)).toMatchObject({ status: "unavailable" });
	});

	it("hides timeline actions for other asset classes", () => {
		expect(sequenceRelatedView({ status: "cancelled" }, false)).toEqual({ status: "hidden" });
	});
});
