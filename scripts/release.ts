import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_VERSION } from "./pack-public-packages.ts";
import { assertCleanReleaseSource } from "./release-source.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

export interface ReleaseSteps {
	readonly validateSource: () => string;
	readonly check: () => void;
	readonly confirm: () => Promise<void>;
	readonly publish: () => void;
}

export async function runRelease({ validateSource, check, confirm, publish }: ReleaseSteps) {
	const validatedCommit = validateSource();
	check();
	await confirm();
	const publicationCommit = validateSource();
	if (publicationCommit !== validatedCommit) {
		throw new Error(
			`Release source changed from ${validatedCommit} to ${publicationCommit} during validation.`
		);
	}
	publish();
}

function executable(name: string) {
	return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command: string, args: readonly string[]) {
	const isCommandShim = process.platform === "win32" && command.endsWith(".cmd");
	const result = spawnSync(
		isCommandShim ? (process.env.ComSpec ?? "cmd.exe") : command,
		isCommandShim ? ["/d", "/s", "/c", command, ...args] : args,
		{
			cwd: repositoryRoot,
			shell: false,
			stdio: "inherit",
			windowsHide: true
		}
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}.`);
	}
}

async function confirmPublication() {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error(
			"Release publication requires an interactive terminal for confirmation and npm authentication."
		);
	}
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	try {
		await terminal.question(
			`\nAll release checks passed. Press Enter to publish UE Shed ${PUBLIC_VERSION} to npm, or Ctrl+C to abort. `
		);
	} finally {
		terminal.close();
	}
}

async function main() {
	await runRelease({
		validateSource: () => assertCleanReleaseSource(),
		check: () => run(executable("pnpm"), ["check"]),
		confirm: confirmPublication,
		publish: () => run(executable("pnpm"), ["exec", "changeset", "publish"])
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
