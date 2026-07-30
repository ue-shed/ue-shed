import { Effect } from "effect";
import {
	P4CommandError,
	type P4ChangelistDescription,
	type P4DepotPath,
	type P4FileAction,
	type P4LocalPath
} from "p4client-ts";
import { describe, expect, it } from "vitest";
import { makePerforceHistorySource } from "./perforce.js";

function backend() {
	const description: P4ChangelistDescription = {
		change: 42,
		client: "workspace",
		createdAt: "2026/07/28 12:00:00",
		createdAtIso: "2026-07-28T12:00:00.000Z",
		description: "Move actor",
		files: [
			{
				action: "edit" as P4FileAction,
				depotFile: "//Project/Main/Content/Maps/L_Example.umap" as P4DepotPath,
				revision: 7,
				type: "binary"
			}
		],
		status: "submitted",
		user: "artist"
	};
	return {
		describeChangelist: () => Effect.succeed(description),
		listDepotFilesAtChange: () => Effect.succeed({ hasMore: false, items: [] }),
		listSubmittedChangelists: () =>
			Effect.succeed({
				hasMore: false,
				items: [
					{
						change: 42,
						client: "workspace",
						createdAt: "2026/07/28 12:00:00",
						createdAtIso: "2026-07-28T12:00:00.000Z",
						description: "Move actor",
						status: "submitted" as const,
						user: "artist"
					}
				],
				nextBeforeChange: null
			}),
		materializeDepotFiles: () =>
			Effect.succeed({
				directory: "C:/temp/history" as P4LocalPath,
				items: [],
				totalCount: 0
			}),
		resolveLocalPath: () =>
			Effect.succeed({ depotPath: "//Project/Main/Content/Maps/L_Example.umap" })
	};
}

describe("PerforceHistorySource", () => {
	it("translates p4client values at the acquisition boundary", async () => {
		const source = makePerforceHistorySource(backend());

		const result = await Effect.runPromise(
			source.listSubmittedChangelists({
				fileSpec: "//Project/Main/Content/Maps/...",
				limit: 100
			})
		);

		expect(result).toEqual({
			hasMore: false,
			items: [
				{
					change: 42,
					description: "Move actor",
					submittedAt: "2026-07-28T12:00:00.000Z",
					user: "artist"
				}
			],
			nextBeforeChange: null
		});
	});

	it("maps authentication failures to the map-history error vocabulary", async () => {
		const source = makePerforceHistorySource({
			...backend(),
			listSubmittedChangelists: () =>
				Effect.fail(
					new P4CommandError(
						"Perforce password invalid or unset.",
						{
							args: ["changes"],
							command: "p4",
							exitCode: 1,
							stderr: "Perforce password invalid or unset.",
							stdout: ""
						},
						"authentication"
					)
				)
		});

		const error = await Effect.runPromise(
			Effect.flip(source.listSubmittedChangelists({ limit: 1 }))
		);

		expect(error.kind).toBe("perforce_authentication");
		expect(error.retrySafe).toBe(false);
	});
});
