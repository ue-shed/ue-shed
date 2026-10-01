import { describe, expect, it } from "vitest";
import { viewerRead } from "../../../../extensions/data-authoring/src/viewer-fixture.test-support.js";
import { authoringRelatedView } from "./related-view.js";

describe("Data Tables related view", () => {
	it("offers only ready table evidence, including valid empty tables", () => {
		expect(authoringRelatedView(undefined)).toEqual({ status: "hidden" });
		expect(
			authoringRelatedView({
				status: "failed",
				reason: "unsupported_asset",
				message: "No table",
				recovery: "Choose a table"
			})
		).toEqual({ status: "hidden" });
		expect(authoringRelatedView(viewerRead)).toMatchObject({
			status: "available",
			subtitle: "2 rows · 2 fields",
			read: viewerRead
		});
		expect(
			authoringRelatedView({
				...viewerRead,
				snapshot: {
					...viewerRead.snapshot,
					table: { ...viewerRead.snapshot.table, rows: [] }
				}
			})
		).toMatchObject({ status: "available", subtitle: "0 rows · 0 fields" });
	});
});
