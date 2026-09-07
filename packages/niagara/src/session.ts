import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";

/** Trusted host seam. The host owns the process and a private, unique session directory. */
export async function submitNiagaraSessionRequest(input: {
	directory: string;
	requestPath: string;
	runId: string;
	signal: AbortSignal;
	timeoutMs?: number;
}): Promise<number> {
	if (!isAbsolute(input.directory) || !/^[a-f0-9-]{36}$/.test(input.runId)) {
		throw new Error("Invalid Niagara session request.");
	}
	const signal = AbortSignal.any([
		input.signal,
		AbortSignal.timeout(input.timeoutMs ?? 30 * 60_000)
	]);
	const ready = JSON.parse(await readFile(join(input.directory, "ready.json"), "utf8"));
	if (ready.protocol !== "ue-shed-niagara-session.v1") throw new Error("Session is not ready.");
	const prefix = join(input.directory, input.runId);
	let submitted = false;
	let completed = false;
	try {
		signal.throwIfAborted();
		await copyFile(input.requestPath, `${prefix}.pending`);
		await rename(`${prefix}.pending`, `${prefix}.request.json`);
		submitted = true;
		for (;;) {
			signal.throwIfAborted();

			try {
				const details = await stat(`${prefix}.result.json`);
				if (details.size > 4096) throw new Error("Oversized session result.");
				const result = JSON.parse(await readFile(`${prefix}.result.json`, "utf8"));
				if (
					result.protocol !== "ue-shed-niagara-session.v1" ||
					result.runId !== input.runId ||
					!Number.isSafeInteger(result.exitCode) ||
					result.exitCode < 0 ||
					result.exitCode > 255
				) {
					throw new Error("Invalid session result.");
				}
				completed = true;
				return result.exitCode;
			} catch (error) {
				// SAFETY: These filesystem/JSON operations and local throws produce Error objects; only ENOENT is retryable.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			try {
				await stat(join(input.directory, "closed"));
				throw new Error("Niagara session closed before completing capture.");
			} catch (error) {
				// SAFETY: These filesystem/JSON operations and local throws produce Error objects; only ENOENT is retryable.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await setTimeout(100, undefined, { signal });
		}
	} finally {
		if (submitted && !completed) await writeFile(`${prefix}.cancel`, "cancelled\n");
	}
}
