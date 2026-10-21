import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stageSpans } from "./gate-trace.ts";
import { PUBLIC_VERSION } from "./pack-public-packages.ts";
import { releaseCargoTargetDirectory } from "./release-cargo.ts";

/**
 * Proves that `release:pack` succeeds from a clean checkout with no prior build: packs the
 * committed HEAD in a temporary git worktree, where no package `dist` output exists yet.
 *
 * With `--output <empty-dir>` the tarballs, checksums and publication manifest are kept there with
 * a `pack-evidence.json` naming the commit they were packed from, so `pnpm release` can publish
 * exactly the tarballs this check validated.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PackEvidence {
	readonly schemaVersion: 1;
	readonly version: string;
	readonly commit: string;
	readonly packedAt: string;
	readonly node: string;
}

export const PACK_EVIDENCE_FILE = "pack-evidence.json";

function run(command: string, args: readonly string[], cwd: string, env = process.env) {
	const isWindows = process.platform === "win32";
	const result = spawnSync(
		isWindows ? (process.env.ComSpec ?? "cmd.exe") : command,
		isWindows ? ["/d", "/s", "/c", command, ...args] : args,
		{ cwd, env, stdio: "inherit" }
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
}

function headCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		encoding: "utf8"
	});
	if (result.status !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function assertEmptyOutput(output: string) {
	if (existsSync(output) && (await readdir(output)).length > 0) {
		throw new Error(`Pack output must be absent or empty: ${output}`);
	}
}

export async function checkCleanReleasePack({
	output
}: { readonly output?: string | undefined } = {}) {
	const outputDirectory = output === undefined ? undefined : resolve(output);
	if (outputDirectory !== undefined) await assertEmptyOutput(outputDirectory);
	const commit = headCommit();
	const stages = stageSpans();
	const parent = await mkdtemp(join(tmpdir(), "ue-shed-clean-pack-"));
	const worktree = join(parent, "checkout");
	stages.start("create clean worktree", { "git.commit": commit });
	run("git", ["worktree", "add", "--detach", worktree, commit], repositoryRoot);
	let packed = false;
	try {
		stages.start("install dependencies");
		run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], worktree);
		// Reuse the native build cache; the check is about TypeScript build order, not Rust.
		const env = { ...process.env, CARGO_TARGET_DIR: releaseCargoTargetDirectory() };
		stages.start("release:pack");
		run("pnpm", ["run", "release:pack"], worktree, env);
		if (outputDirectory !== undefined) {
			stages.start("keep packed release");
			await mkdir(outputDirectory, { recursive: true });
			await cp(join(worktree, "out", "releases", "npm"), outputDirectory, {
				recursive: true
			});
			const evidence: PackEvidence = {
				schemaVersion: 1,
				version: PUBLIC_VERSION,
				commit,
				packedAt: new Date().toISOString(),
				node: process.version
			};
			await writeFile(
				join(outputDirectory, PACK_EVIDENCE_FILE),
				`${JSON.stringify(evidence, undefined, "\t")}\n`,
				"utf8"
			);
		}
		console.log(`release:pack succeeded from a clean checkout of ${commit}.`);
		if (outputDirectory !== undefined) {
			console.log(`Kept the packed release at ${relative(repositoryRoot, outputDirectory)}.`);
		}
		packed = true;
	} finally {
		stages.end(packed ? "ok" : "error");
		stages.start("remove clean worktree");
		// Node removes deep node_modules paths that `git worktree remove` cannot on Windows.
		await rm(parent, { recursive: true, force: true, maxRetries: 3 });
		run("git", ["worktree", "prune"], repositoryRoot);
		stages.end();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { output: { type: "string" } }, strict: true });
	await checkCleanReleasePack({ output: values.output });
}
