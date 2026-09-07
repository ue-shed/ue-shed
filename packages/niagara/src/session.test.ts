import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { submitNiagaraSessionRequest } from "./session.js";

const runId = "11111111-1111-4111-8111-111111111111";
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "niagara-session-test-"));
	const requestPath = join(directory, "source.json");
	await writeFile(requestPath, JSON.stringify({ runId }));
	await writeFile(
		join(directory, "ready.json"),
		JSON.stringify({ protocol: "ue-shed-niagara-session.v1" })
	);
	return { directory, requestPath, runId, signal: new AbortController().signal };
}
test("session transport accepts only the matching completed request", async () => {
	const input = await fixture();
	await writeFile(
		join(input.directory, `${runId}.result.json`),
		JSON.stringify({ protocol: "ue-shed-niagara-session.v1", runId, exitCode: 0 })
	);
	expect(await Effect.runPromise(submitNiagaraSessionRequest(input))).toBe(0);
	expect(
		JSON.parse(await readFile(join(input.directory, `${runId}.request.json`), "utf8"))
	).toEqual({ runId });
});
test("a timeout leaves cancellation evidence for the producer", async () => {
	const input = await fixture();
	await expect(
		Effect.runPromise(submitNiagaraSessionRequest({ ...input, timeoutMs: 30 }))
	).rejects.toThrow();
	expect((await stat(join(input.directory, `${runId}.cancel`))).isFile()).toBe(true);
});

test("caller interruption leaves cancellation evidence before completing", async () => {
	const input = await fixture();
	const controller = new AbortController();
	const completion = Effect.runPromise(submitNiagaraSessionRequest(input), {
		signal: controller.signal
	}).catch((error) => error);
	await expect
		.poll(async () => {
			try {
				return (await stat(join(input.directory, `${runId}.request.json`))).isFile();
			} catch {
				return false;
			}
		})
		.toBe(true);
	controller.abort();
	await completion;
	expect((await stat(join(input.directory, `${runId}.cancel`))).isFile()).toBe(true);
});
test("crashed sessions fail promptly rather than accepting stale output", async () => {
	const input = await fixture();
	await writeFile(join(input.directory, "closed"), "crashed");
	await expect(Effect.runPromise(submitNiagaraSessionRequest(input))).rejects.toThrow("closed");
});
test("the final completed result remains valid when a bounded session retires", async () => {
	const input = await fixture();
	await writeFile(
		join(input.directory, `${runId}.result.json`),
		JSON.stringify({ protocol: "ue-shed-niagara-session.v1", runId, exitCode: 0 })
	);
	await writeFile(join(input.directory, "closed"), "retired");
	expect(await Effect.runPromise(submitNiagaraSessionRequest(input))).toBe(0);
});
test("mismatched result identity cannot publish", async () => {
	const input = await fixture();
	await writeFile(
		join(input.directory, `${runId}.result.json`),
		JSON.stringify({ protocol: "ue-shed-niagara-session.v1", runId: "wrong", exitCode: 0 })
	);
	await expect(Effect.runPromise(submitNiagaraSessionRequest(input))).rejects.toThrow(
		"Invalid session result"
	);
});
