import { Schema } from "effect";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

const cliScript = join(repositoryRoot, "scripts", "ue-shed.ts");

export const fixtureProject = join(repositoryRoot, "fixtures", "unreal-project");

export const fixtureReviewSet = join(
	fixtureProject,
	".ue-shed",
	"review",
	"sets",
	"fixture-structure.json"
);

export interface CliResult {
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

export function runCli(args: readonly string[]): CliResult {
	const result = spawnSync(process.execPath, [cliScript, ...args], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: process.env,
		timeout: 30_000,
		windowsHide: true
	});
	if (result.error) throw result.error;
	return {
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout
	};
}

export function runSuccessfulCli(args: readonly string[]): string {
	const result = runCli(args);
	if (result.status !== 0) {
		throw new Error(`CLI exited with ${result.status} for ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout;
}

export const JsonObject = Schema.Record(Schema.String, Schema.Json);

export function parseRecord(output: string): Schema.JsonObject {
	return Schema.decodeUnknownSync(JsonObject)(JSON.parse(output));
}
