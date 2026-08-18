import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeUAssetIoEvent } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeProjectIndexWirePage,
	decodeProjectIndexWireSummary,
	mapProjectIndexProgress,
	mapProjectIndexProtocolFailure
} from "./project-index-protocol.js";

const fixture = async (name: string): Promise<Schema.Json> =>
	Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(
			await readFile(
				fileURLToPath(
					new URL(
						`../../protocol/contracts/uasset-io/v1/fixtures/${name}`,
						import.meta.url
					)
				),
				"utf8"
			)
		)
	);

describe("Project Index protocol adapter mappings", () => {
	it("maps an old worker exit before accepted to incompatible-worker", () => {
		const error = mapProjectIndexProtocolFailure({
			exitCode: 2,
			sawAccepted: false,
			stderr: "uasset protocol: invalid request: unknown variant `project_index_refresh`"
		});
		expect(error._tag).toBe("ProjectIndexIncompatibleWorker");
		expect(error.recovery).toContain("paired");
		expect(error.retrySafe).toBe(false);
	});

	it("maps stale-generation failed frames with generation fields", async () => {
		const event = await Effect.runPromise(
			decodeUAssetIoEvent(
				await fixture("valid/project-index-stale-generation-failed-event.json")
			)
		);
		if (event.kind !== "failed") throw new Error("expected failed fixture");
		const error = mapProjectIndexProtocolFailure({ event, sawAccepted: true });
		expect(error._tag).toBe("ProjectIndexStaleGeneration");
		if (error._tag !== "ProjectIndexStaleGeneration") return;
		expect(error.expectedGeneration).toBe(3);
		expect(error.actualGeneration).toBe(4);
	});

	it("maps Project Index progress and typed result payloads", async () => {
		const progress = await Effect.runPromise(
			decodeUAssetIoEvent(await fixture("valid/project-index-progress-event.json"))
		);
		if (progress.kind !== "progress") throw new Error("expected progress fixture");
		expect(mapProjectIndexProgress(progress)).toEqual({
			_tag: "Progress",
			completedPackages: 12,
			phase: "reading_headers",
			totalPackages: 40
		});

		const summaryEvent = await Effect.runPromise(
			decodeUAssetIoEvent(await fixture("valid/project-index-summary-result-event.json"))
		);
		if (
			summaryEvent.kind !== "result" ||
			summaryEvent.result.kind !== "project_index_summary"
		) {
			throw new Error("expected summary result");
		}
		expect(decodeProjectIndexWireSummary(summaryEvent.result.summary).generation).toBe(4);

		const pageEvent = await Effect.runPromise(
			decodeUAssetIoEvent(await fixture("valid/project-index-page-result-event.json"))
		);
		if (pageEvent.kind !== "result" || pageEvent.result.kind !== "project_index_page") {
			throw new Error("expected page result");
		}
		const page = decodeProjectIndexWirePage(pageEvent.result.page);
		expect(page.items).toHaveLength(2);
		expect(page.nextCursor).toBe("2");
	});

	it("maps cancelled and corrupt catalog failures", () => {
		expect(
			mapProjectIndexProtocolFailure({
				event: {
					contract: { name: "uasset-io", version: { major: 1, minor: 1 } },
					code: "cancelled",
					kind: "failed",
					message: "operation cancelled during committing",
					requestId: "r1",
					retrySafe: true,
					sequence: 2
				},
				sawAccepted: true
			})._tag
		).toBe("ProjectIndexRefreshFailed");

		expect(
			mapProjectIndexProtocolFailure({
				event: {
					contract: { name: "uasset-io", version: { major: 1, minor: 1 } },
					code: "corrupt_catalog",
					kind: "failed",
					message: "Catalog failed integrity checks.",
					requestId: "r1",
					retrySafe: true,
					sequence: 1
				},
				sawAccepted: true
			})._tag
		).toBe("ProjectIndexCorruptCatalog");
	});
});
