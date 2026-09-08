import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

export const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

const cliScript = join(repositoryRoot, "scripts", "ue-shed.ts");

const cliIndex = join(repositoryRoot, "apps", "cli", "src", "index.ts");

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

export function runSuccessfulHeadlessCli(args: readonly string[]): string {
	const result = spawnSync(process.execPath, ["--import", "tsx", cliIndex, ...args], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: process.env,
		timeout: 30_000,
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`CLI exited with ${result.status} for ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout;
}

export function runCliAsync(args: readonly string[]): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliScript, ...args], {
			cwd: repositoryRoot,
			env: process.env,
			windowsHide: true
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stderr, stdout }));
	});
}

export const JsonObject = Schema.Record(Schema.String, Schema.Json);

export function parseRecord(output: string): Schema.JsonObject {
	return Schema.decodeUnknownSync(JsonObject)(JSON.parse(output));
}
