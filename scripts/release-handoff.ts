/**
 * Moves a prepared release to the machine that publishes it. `pnpm release:prepare` runs the
 * gates where the engines and toolchains are; the machine with the npm login only needs the same
 * commit, the gate evidence and the validated tarballs.
 *
 *   pnpm release:handoff            # here: after release:prepare, upload the handoff
 *   pnpm release --checked          # there: fetches the handoff when it has no evidence of its own
 *
 * The handoff is a draft GitHub release named `release-handoff-<version>`: visible only to people
 * who can push to the repository, and never a tag. It holds the evidence file and the kept pack
 * (tarballs, publication manifest, pack evidence). Nothing in it is trusted on arrival: the
 * publishing machine checks the evidence against its own clean checkout's tree and every tarball
 * against the digest the pack recorded, exactly as for local evidence.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { PACK_EVIDENCE_FILE } from "./check-clean-release-pack.ts";
import { PUBLIC_VERSION } from "./pack-public-packages.ts";
import {
	ReleaseEvidence,
	readReleaseEvidence,
	readTree,
	releaseEvidencePath,
	writeReleaseEvidence
} from "./release-evidence.ts";
import { assertCleanReleaseSource } from "./release-source.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** The evidence file inside a handoff; the tarballs sit beside it. */
export const HANDOFF_EVIDENCE_FILE = "release-evidence.json";

export function handoffRelease(version: string) {
	return `release-handoff-${version}`;
}

/** Where `pnpm release --checked` puts a fetched handoff. */
export function handoffDirectory(version: string, root = repositoryRoot) {
	return join(root, "out", "release-handoff", version);
}

/**
 * The evidence as it travels: the pack is wherever the handoff is unpacked, so its directory is
 * left for the receiver to fill in.
 */
export function handoffEvidence(evidence: ReleaseEvidence): ReleaseEvidence {
	if (evidence.pack === undefined) {
		throw new Error("Release evidence has no kept pack; run pnpm release:prepare --only pack.");
	}
	return { ...evidence, pack: { directory: ".", commit: evidence.pack.commit } };
}

/** Received evidence, pointed at the directory the handoff was unpacked into. */
export function receivedEvidence(text: string, version: string, directory: string) {
	const evidence = Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseEvidence))(text);
	if (evidence.version !== version) {
		throw new Error(`The handoff holds ${evidence.version}, not ${version}.`);
	}
	if (evidence.pack === undefined) throw new Error("The handoff has no validated pack.");
	return { ...evidence, pack: { directory, commit: evidence.pack.commit } };
}

function gh(args: readonly string[], options: { readonly quiet?: boolean } = {}) {
	const result = spawnSync("gh", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		shell: false,
		stdio: options.quiet ? "pipe" : ["ignore", "inherit", "inherit"],
		windowsHide: true
	});
	if (result.error) {
		throw new Error(
			"The release handoff needs the GitHub CLI, signed in to an account that can push to this repository (gh auth login).",
			{ cause: result.error }
		);
	}
	return result;
}

/**
 * Fetches the handoff for `version` and records its evidence, unless this checkout already has
 * evidence for that version. Returns whether it fetched.
 */
export function fetchReleaseHandoff(version: string, root = repositoryRoot) {
	if (existsSync(releaseEvidencePath(version, root))) return false;
	const directory = handoffDirectory(version, root);
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	console.log(`No release evidence here for ${version}; fetching ${handoffRelease(version)}.`);
	const download = gh(["release", "download", handoffRelease(version), "--dir", directory]);
	if (download.status !== 0) {
		throw new Error(
			`Could not fetch ${handoffRelease(version)}. Run pnpm release:handoff on the machine that ran pnpm release:prepare.`
		);
	}
	const evidence = receivedEvidence(
		readFileSync(join(directory, HANDOFF_EVIDENCE_FILE), "utf8"),
		version,
		directory
	);
	writeReleaseEvidence(evidence, root);
	return true;
}

/** The files a handoff uploads: the evidence, then everything the kept pack holds. */
export function handoffFiles(packDirectory: string) {
	const files = readdirSync(packDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		// Written by `pnpm release` itself on the publishing machine.
		.filter((name) => name !== "changesets-plan.json" && name !== "publish-plan.json");
	if (!files.includes(PACK_EVIDENCE_FILE) || !files.includes("packages-manifest.json")) {
		throw new Error(
			`${packDirectory} is not a kept pack; run pnpm release:prepare --only pack.`
		);
	}
	return files.map((name) => join(packDirectory, name));
}

async function main() {
	const commit = assertCleanReleaseSource();
	const version = PUBLIC_VERSION;
	// The same checks `pnpm release --checked` makes, so a handoff that would be refused is not sent.
	const { releaseGateCoverage, verifyPackedRelease } = await import("./release.ts");
	const evidence = readReleaseEvidence(version);
	const { problems } = releaseGateCoverage(evidence, readTree(commit));
	if (problems.length > 0) {
		throw new Error(
			`Release evidence does not cover ${commit}:\n- ${problems.join("\n- ")}\n` +
				"Run pnpm release:prepare first; it reruns only these gates."
		);
	}
	const travelling = handoffEvidence(evidence);
	const packDirectory = evidence.pack!.directory;
	const entries = verifyPackedRelease(packDirectory, version, travelling.pack!.commit);
	const staging = join(repositoryRoot, "out", "release-handoff-upload", version);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	const evidenceFile = join(staging, HANDOFF_EVIDENCE_FILE);
	writeFileSync(evidenceFile, `${JSON.stringify(travelling, undefined, "\t")}\n`, "utf8");

	const name = handoffRelease(version);
	// A handoff is replaced whole, so no tarball from an earlier preparation stays beside it.
	if (gh(["release", "view", name], { quiet: true }).status === 0) {
		if (gh(["release", "delete", name, "--yes"]).status !== 0) {
			throw new Error(`Could not replace the earlier ${name}.`);
		}
	}
	const created = gh([
		"release",
		"create",
		name,
		"--draft",
		"--target",
		commit,
		"--title",
		`${version} handoff (unpublished)`,
		"--notes",
		`Gate evidence and ${entries.length} validated tarballs for ${version} at ${commit}, ` +
			"for `pnpm release --checked` on the publishing machine. Not a release: delete it after publishing.",
		evidenceFile,
		...handoffFiles(packDirectory)
	]);
	if (created.status !== 0) throw new Error(`Could not upload ${name}.`);
	console.log(
		`\nUploaded ${name}: evidence for ${commit.slice(0, 10)} and ${entries.length} tarballs.\n` +
			"On the publishing machine, check out this commit in a clean checkout, then:\n" +
			"  pnpm install --frozen-lockfile\n  npm whoami\n  pnpm release --checked"
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
