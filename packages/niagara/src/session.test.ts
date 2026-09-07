import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	expect(await submitNiagaraSessionRequest(input)).toBe(0);
	expect(
		JSON.parse(await readFile(join(input.directory, `${runId}.request.json`), "utf8"))
	).toEqual({ runId });
});
test("a timeout leaves cancellation evidence for the producer", async () => {
	const input = await fixture();
	await expect(submitNiagaraSessionRequest({ ...input, timeoutMs: 30 })).rejects.toThrow();
	expect((await stat(join(input.directory, `${runId}.cancel`))).isFile()).toBe(true);
});
test("crashed sessions fail promptly rather than accepting stale output", async () => {
	const input = await fixture();
	await writeFile(join(input.directory, "closed"), "crashed");
	await expect(submitNiagaraSessionRequest(input)).rejects.toThrow("closed");
});
test("the final completed result remains valid when a bounded session retires", async () => {
	const input = await fixture();
	await writeFile(
		join(input.directory, `${runId}.result.json`),
		JSON.stringify({ protocol: "ue-shed-niagara-session.v1", runId, exitCode: 0 })
	);
	await writeFile(join(input.directory, "closed"), "retired");
	expect(await submitNiagaraSessionRequest(input)).toBe(0);
});
test("mismatched result identity cannot publish", async () => {
	const input = await fixture();
	await writeFile(
		join(input.directory, `${runId}.result.json`),
		JSON.stringify({ protocol: "ue-shed-niagara-session.v1", runId: "wrong", exitCode: 0 })
	);
	await expect(submitNiagaraSessionRequest(input)).rejects.toThrow("Invalid session result");
});
