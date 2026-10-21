import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import type { CliResult } from "./cli-process.test-support.js";
import { CliRuntime, inputIssueDetail } from "./cli-runtime.js";
import { runCli } from "./command.js";
export {
	fixtureProject,
	fixtureReviewSet,
	JsonObject,
	parseRecord,
	repositoryRoot
} from "./cli-process.test-support.js";

/** Run the real command tree with fresh command resources and captured host output. */
export async function runInProcessCli(args: readonly string[]): Promise<CliResult> {
	let stdout = "";
	let stderr = "";
	let status = 0;
	const runtime = Layer.succeed(
		CliRuntime,
		CliRuntime.of({
			print: (value) =>
				Effect.sync(() => {
					stdout += value;
				}),
			printError: (value) =>
				Effect.sync(() => {
					stderr += value;
				}),
			setExitCode: (value) =>
				Effect.sync(() => {
					status = value;
				})
		})
	);
	const exit = await Effect.runPromiseExit(runCli(args).pipe(Effect.provide(runtime)));
	if (Exit.isFailure(exit)) {
		const error = Cause.findErrorOption(exit.cause);
		if (Option.isNone(error)) throw Cause.squash(exit.cause);
		const detail = inputIssueDetail(error.value);
		stderr += `ue-shed: ${error.value.message}\n`;
		if (detail !== undefined) stderr += `${detail}\n`;
		status = 2;
	}
	return { status, stderr, stdout };
}

export async function runSuccessfulCli(args: readonly string[]): Promise<string> {
	const result = await runInProcessCli(args);
	if (result.status !== 0) {
		throw new Error(`CLI exited with ${result.status} for ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout;
}

let cacheRoot: string;
beforeAll(async () => {
	cacheRoot = await mkdtemp(join(tmpdir(), "ue-shed-cli-command-cache-"));
	vi.stubEnv("UE_SHED_PROJECT_INDEX_CACHE_ROOT", cacheRoot);
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await rm(cacheRoot, { recursive: true, force: true });
});
