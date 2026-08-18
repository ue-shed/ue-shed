import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeEditorPlaySessionCommandResponse,
	decodeEditorPlaySessionStateResponse
} from "./editor-play-session.js";

async function fixture(name: string): Promise<Schema.Json> {
	const path = fileURLToPath(
		new URL(`../contracts/editor-session/v1/fixtures/${name}.json`, import.meta.url)
	);
	return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(path, "utf8")));
}

describe("editor play-session wire contract", () => {
	it("decodes every lifecycle state from language-neutral fixtures", async () => {
		for (const status of ["stopped", "starting", "running", "paused", "stopping"]) {
			const response = await Effect.runPromise(
				decodeEditorPlaySessionStateResponse(await fixture(`state-${status}`))
			);
			expect(response.state.status).toBe(status);
		}
	});

	it("decodes accepted, idempotent, and rejected command outcomes", async () => {
		for (const outcome of ["accepted", "already-satisfied", "rejected"]) {
			const response = await Effect.runPromise(
				decodeEditorPlaySessionCommandResponse(await fixture(`command-${outcome}`))
			);
			expect(response.outcome.replace("_", "-")).toBe(outcome);
		}
	});
});
