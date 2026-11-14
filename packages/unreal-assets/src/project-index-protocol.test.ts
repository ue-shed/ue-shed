import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeUAssetIoEvent, UAssetIoProjectIndexDictionaryPage } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeProjectIndexPage } from "./project-index.js";
import {
	decodeProjectIndexWirePage,
	decodeProjectIndexDictionaryPage,
	decodeProjectIndexWireSummary,
	mapProjectIndexProgress,
	mapProjectIndexProtocolFailure
} from "./project-index-protocol.js";

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const fixture = async (name: string): Promise<Schema.Json> =>
	decodeJson(
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
	it.each([
		"project-index-inventory-result-event.json",
		"project-index-inventory-dictionary-result-event.json"
	])("retains committed package signatures in %s", async (name) => {
		const event = await Effect.runPromise(decodeUAssetIoEvent(await fixture(`valid/${name}`)));
		if (event.kind !== "result") throw new Error("Expected result.");
		const result = event.result;
		if (result.kind !== "project_index_page" && result.kind !== "project_index_dictionary_page")
			throw new Error("Expected page.");
		const page =
			result.kind === "project_index_page"
				? decodeProjectIndexWirePage(result.page)
				: decodeProjectIndexDictionaryPage(result.page);
		expect(page.items[0]).toEqual({
			kind: "inventory",
			packagePath: "Content/Data/DT_Items.uasset",
			signature: '[{"modifiedMs":456,"size":123},null,null,null]'
		});
	});
	it("validates compact domain bounds before retaining immutable expanded pages", async () => {
		const page = {
			generation: 1,
			projectId: "fixture",
			strings: ["名前"],
			items: [
				{
					kind: "header" as const,
					packageName: "/Game/A",
					packagePath: "Content/A.uasset",
					classes: [0],
					serializedNames: [0]
				}
			]
		};
		const decoded = decodeProjectIndexDictionaryPage(page);
		expect(await Effect.runPromise(decodeProjectIndexPage(decoded))).toBe(decoded);
		expect(Object.isFrozen(decoded)).toBe(true);
		expect(Object.isFrozen(decoded.items)).toBe(true);
		const header = decoded.items[0];
		if (header?.kind !== "header") throw new Error("expected header");
		expect(Object.isFrozen(header.classes)).toBe(true);
		page.strings[0] = "changed";
		const inputHeader = page.items[0];
		if (inputHeader === undefined) throw new Error("expected input header");
		inputHeader.classes[0] = 1;
		expect(header.classes).toEqual(["名前"]);
		for (const invalid of [
			{ ...page, generation: 0 },
			{ ...page, projectId: "" },
			{ ...page, nextCursor: "x".repeat(4097) },
			{ ...page, strings: ["x".repeat(1025)] },
			{ ...page, strings: [""] },
			{ ...page, items: Array.from({ length: 1025 }, () => inputHeader) },
			{ ...page, items: [{ ...inputHeader, packagePath: "x".repeat(32768) }] },
			{
				...page,
				items: [{ ...inputHeader, classes: Array.from({ length: 65 }, () => 0) }]
			}
		])
			expect(() => decodeProjectIndexDictionaryPage(invalid)).toThrow(
				"unbounded or invalid page"
			);
	});

	it.each([-1, 0.5, 1, Number.POSITIVE_INFINITY, Number.NaN])(
		"rejects invalid reference %s",
		(reference) => {
			expect(() =>
				decodeProjectIndexDictionaryPage({
					generation: 1,
					projectId: "fixture",
					strings: ["A"],
					items: [
						{
							kind: "header",
							packageName: "/Game/A",
							packagePath: "Content/A.uasset",
							classes: [reference],
							serializedNames: []
						}
					]
				})
			).toThrow();
		}
	);

	it("expands the shared dictionary fixture to the complete original page", async () => {
		const plain = await Effect.runPromise(
			decodeUAssetIoEvent(await fixture("valid/project-index-page-result-event.json"))
		);
		const compact = await Effect.runPromise(
			decodeUAssetIoEvent(
				await fixture("valid/project-index-dictionary-page-result-event.json")
			)
		);
		if (
			plain.kind !== "result" ||
			plain.result.kind !== "project_index_page" ||
			compact.kind !== "result" ||
			compact.result.kind !== "project_index_dictionary_page"
		)
			throw new Error("expected pages");
		expect(decodeProjectIndexDictionaryPage(compact.result.page)).toEqual(
			decodeProjectIndexWirePage(plain.result.page)
		);
	});

	it("expands dependency package pages and their summary change reports", async () => {
		const plain = await Effect.runPromise(
			decodeUAssetIoEvent(await fixture("valid/project-index-package-page-result-event.json"))
		);
		const compact = await Effect.runPromise(
			decodeUAssetIoEvent(
				await fixture("valid/project-index-package-dictionary-page-result-event.json")
			)
		);
		if (
			plain.kind !== "result" ||
			plain.result.kind !== "project_index_page" ||
			compact.kind !== "result" ||
			compact.result.kind !== "project_index_dictionary_page"
		)
			throw new Error("expected pages");
		const page = decodeProjectIndexDictionaryPage(compact.result.page);
		expect(page).toEqual(decodeProjectIndexWirePage(plain.result.page));
		expect(await Effect.runPromise(decodeProjectIndexPage(page))).toBe(page);
		const item = page.items[0];
		if (item?.kind !== "package") throw new Error("expected package");
		expect(item.dependencies.length).toBeGreaterThan(0);
		expect(Object.isFrozen(item.dependencies)).toBe(true);
		expect(Object.isFrozen(item.dependencies[0])).toBe(true);
		expect(Object.isFrozen(item.classes)).toBe(true);

		const summary = await Effect.runPromise(
			decodeUAssetIoEvent(
				await fixture("valid/project-index-changes-summary-result-event.json")
			)
		);
		if (summary.kind !== "result" || summary.result.kind !== "project_index_summary")
			throw new Error("expected summary");
		const mapped = decodeProjectIndexWireSummary(summary.result.summary);
		expect(mapped.changes).toEqual(summary.result.summary.changes);
		expect(mapped.mounts).toEqual(summary.result.summary.mounts);
	});

	it("preserves reference order, duplicates, Unicode, and empty arrays", () => {
		const page = UAssetIoProjectIndexDictionaryPage.make({
			generation: 1,
			projectId: "fixture",
			strings: ["Café", "名前"],
			items: [
				{
					kind: "header",
					packageName: "/Game/A",
					packagePath: "Content/A.uasset",
					classes: [],
					serializedNames: [1, 0, 1]
				}
			]
		});
		expect(decodeProjectIndexDictionaryPage(page).items).toEqual([
			{
				kind: "header",
				packageName: "/Game/A",
				packagePath: "Content/A.uasset",
				classes: [],
				serializedNames: ["名前", "Café", "名前"]
			}
		]);
		expect(decodeProjectIndexDictionaryPage({ ...page, strings: [], items: [] }).items).toEqual(
			[]
		);
	});

	it("rejects missing dictionary references before exposing a page", () => {
		const page = UAssetIoProjectIndexDictionaryPage.make({
			generation: 1,
			projectId: "fixture",
			strings: ["A"],
			items: [
				{
					kind: "header",
					packageName: "/Game/A",
					packagePath: "Content/A.uasset",
					classes: [1],
					serializedNames: []
				}
			]
		});
		expect(() => decodeProjectIndexDictionaryPage(page)).toThrow(
			"dictionary reference is out of bounds"
		);
	});
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
