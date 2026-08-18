import { deepStrictEqual } from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeUAssetIoEvent,
	decodeUAssetIoRequest,
	makeUAssetIoJsonSchema,
	UAssetIoEvent,
	UAssetIoRequest
} from "./uasset-io.js";

const fixture = async (path: string): Promise<Schema.Json> =>
	Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(
			await readFile(
				fileURLToPath(
					new URL("../contracts/uasset-io/v1/fixtures/" + path, import.meta.url)
				),
				"utf8"
			)
		)
	);

describe("uasset IO protocol v1", () => {
	it("keeps Effect schemas conformant with the language-neutral JSON Schema", async () => {
		for (const [name, contract] of [
			["request", UAssetIoRequest],
			["event", UAssetIoEvent]
		] as const) {
			const checkedIn = JSON.parse(
				await readFile(
					fileURLToPath(
						new URL(
							"../contracts/uasset-io/v1/" + name + ".schema.json",
							import.meta.url
						)
					),
					"utf8"
				)
			);
			deepStrictEqual(checkedIn, makeUAssetIoJsonSchema(contract));
		}
	});

	it("accepts valid request, lifecycle, and typed result fixtures", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				for (const name of [
					"valid/scan-request.json",
					"valid/accepted-event.json",
					"valid/inspect-result-event.json",
					"valid/authoring-result-event.json",
					"valid/scan-asset-result-event.json",
					"valid/scan-inventory-result-event.json",
					"valid/scan-summary-result-event.json",
					"valid/extract-text-result-event.json",
					"valid/extract-text-occurrence-result-event.json",
					"valid/extract-text-summary-result-event.json",
					"valid/extract-texture-record-result-event.json",
					"valid/saved-world-result-event.json",
					"valid/partial-completed-event.json",
					"valid/project-index-status-request.json",
					"valid/project-index-refresh-request.json",
					"valid/project-index-rebuild-request.json",
					"valid/project-index-query-request.json",
					"valid/project-index-accepted-event.json",
					"valid/project-index-progress-event.json",
					"valid/project-index-status-result-event.json",
					"valid/project-index-summary-result-event.json",
					"valid/project-index-page-result-event.json",
					"valid/project-index-stale-generation-failed-event.json"
				]) {
					const value = yield* Effect.promise(() => fixture(name));
					if (name.includes("request")) yield* decodeUAssetIoRequest(value);
					else yield* decodeUAssetIoEvent(value);
				}
			})
		);
	});

	it("rejects invalid request and lifecycle fixtures", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				for (const name of [
					"invalid/request-wrong-major.json",
					"invalid/event-unknown-kind.json",
					"invalid/event-result-unknown-kind.json",
					"invalid/project-index-query-oversize-limit.json",
					"invalid/project-index-page-unbounded.json"
				]) {
					const value = yield* Effect.promise(() => fixture(name));
					const decoded =
						name.includes("-request") || name.includes("oversize-limit")
							? yield* Effect.result(decodeUAssetIoRequest(value))
							: yield* Effect.result(decodeUAssetIoEvent(value));
					expect(decoded._tag).toBe("Failure");
				}
			})
		);
	});
});
