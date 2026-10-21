/**
 * Publishes the committed release from the evidence `pnpm release:prepare` recorded: every
 * required gate must have passed on inputs matching the release commit, and the tarballs published
 * are the ones the clean-pack gate validated, byte for byte, handed to `changeset publish
 * --from-pack-dir` (which runs `pnpm publish <tarball>`: no lifecycle scripts, no repacking).
 *
 *   pnpm release
 *   pnpm release --without-unreal "portable-only documentation fix"
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { PACK_EVIDENCE_FILE } from "./check-clean-release-pack.ts";
import { PUBLIC_VERSION } from "./pack-public-packages.ts";
import { validatePublicationManifest, type PublicationEntry } from "./publish-public-packages.ts";
import {
	gateEvidenceState,
	gateFingerprint,
	readReleaseEvidence,
	readTree,
	writeReleaseEvidence,
	type GateEvidenceState,
	type ReleaseEvidence,
	type TreeEntry
} from "./release-evidence.ts";
import { RELEASE_GATES, type ReleaseGate } from "./release-gates.ts";
import { assertCleanReleaseSource } from "./release-source.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");

export interface ReleaseSteps<Verification> {
	readonly validateSource: () => string;
	/** Confirms the recorded evidence covers `commit`; throws listing what does not. */
	readonly verify: (commit: string) => Verification;
	readonly confirm: (verification: Verification) => Promise<void>;
	readonly publish: (verification: Verification) => void;
}

export async function runRelease<Verification>({
	validateSource,
	verify,
	confirm,
	publish
}: ReleaseSteps<Verification>) {
	const validatedCommit = validateSource();
	const verification = verify(validatedCommit);
	await confirm(verification);
	const publicationCommit = validateSource();
	if (publicationCommit !== validatedCommit) {
		throw new Error(
			`Release source changed from ${validatedCommit} to ${publicationCommit} during validation.`
		);
	}
	publish(verification);
}

export interface GateCoverage {
	readonly gate: ReleaseGate;
	readonly state: GateEvidenceState;
}

/**
 * The state of every gate this release requires, and a problem line for each one the evidence
 * does not cover. Unreal gates are required unless `withoutUnreal` records why they are not.
 */
export function releaseGateCoverage(
	evidence: ReleaseEvidence,
	tree: readonly TreeEntry[],
	{
		gates = RELEASE_GATES,
		withoutUnreal
	}: { readonly gates?: readonly ReleaseGate[]; readonly withoutUnreal?: string | undefined } = {}
) {
	const required = gates.filter(
		(gate) => gate.requirement === "always" || withoutUnreal === undefined
	);
	const coverage: GateCoverage[] = required.map((gate) => ({
		gate,
		state: gateEvidenceState(evidence.gates[gate.id], gate.scope, tree)
	}));
	const problems = coverage.flatMap(({ gate, state }) => {
		switch (state.kind) {
			case "current":
				return [];
			case "missing":
				return [`${gate.id}: no evidence`];
			case "failed":
				return [`${gate.id}: failed on ${state.result.commit.slice(0, 10)}`];
			case "stale":
				return [
					`${gate.id}: inputs changed since it passed on ${state.result.commit.slice(0, 10)}`
				];
		}
	});
	return { coverage, problems };
}

const PackEvidence = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	version: Schema.String,
	commit: Schema.String
});

const PublicationManifestFile = Schema.Struct({
	schemaVersion: Schema.Number,
	version: Schema.String,
	packages: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			version: Schema.String,
			license: Schema.optional(Schema.String),
			filename: Schema.String,
			sha256: Schema.String,
			bytes: Schema.Number
		})
	)
});

function sha256(bytes: Buffer) {
	return createHash("sha256").update(bytes).digest();
}

/**
 * Checks the kept tarballs are the validated pack of `commit`: the pack evidence names it, the
 * publication manifest is the protected package set at `version`, and every tarball still has the
 * digest the pack recorded.
 */
export function verifyPackedRelease(directory: string, version: string, commit: string) {
	const evidencePath = join(directory, PACK_EVIDENCE_FILE);
	if (!existsSync(evidencePath)) {
		throw new Error(`${directory} has no ${PACK_EVIDENCE_FILE}; rerun pnpm release:prepare.`);
	}
	const evidence = Schema.decodeUnknownSync(Schema.fromJsonString(PackEvidence))(
		readFileSync(evidencePath, "utf8")
	);
	if (evidence.version !== version || evidence.commit !== commit) {
		throw new Error(
			`${directory} holds ${evidence.version} packed from ${evidence.commit}, not ${version} from ${commit}.`
		);
	}
	const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(PublicationManifestFile))(
		readFileSync(join(directory, "packages-manifest.json"), "utf8")
	);
	const entries = validatePublicationManifest({ manifest, expectedVersion: version });
	for (const entry of entries) {
		const digest = sha256(readFileSync(join(directory, entry.filename))).toString("hex");
		if (digest !== entry.sha256) {
			throw new Error(`${entry.filename} changed after it was packed (sha256 ${digest}).`);
		}
	}
	return entries;
}

const PublishRelease = Schema.Struct({
	kind: Schema.Literal("publish"),
	name: Schema.String,
	version: Schema.String,
	tag: Schema.String,
	access: Schema.optional(Schema.String)
});
const TagRelease = Schema.Struct({
	kind: Schema.Literal("tag-only"),
	name: Schema.String,
	version: Schema.String
});
const ChangesetsPublishPlan = Schema.Struct({
	version: Schema.Literal(1),
	plan: Schema.Array(Schema.Array(Schema.Union([PublishRelease, TagRelease])))
});
type ChangesetsPublishPlan = typeof ChangesetsPublishPlan.Type;

/**
 * Points every release Changesets plans to publish at its validated tarball, in Changesets'
 * packed-plan format (`changeset pack` writes the same shape). Fails for a planned package or
 * version the pack does not contain.
 */
export function packedPublishPlan(
	plan: ChangesetsPublishPlan,
	entries: readonly PublicationEntry[],
	integrity: (entry: PublicationEntry) => string
) {
	return {
		version: 1,
		plan: plan.plan.map((chunk) =>
			chunk.map((release) => {
				if (release.kind !== "publish") return release;
				const entry = entries.find((candidate) => candidate.name === release.name);
				if (entry === undefined || entry.version !== release.version) {
					throw new Error(
						`Changesets plans ${release.name}@${release.version}, which the validated pack does not contain.`
					);
				}
				return {
					...release,
					tarball: { path: entry.filename, integrity: integrity(entry) }
				};
			})
		)
	};
}

export function parseReleaseArguments(args: readonly string[]) {
	const { values } = parseArgs({
		args: [...args],
		options: { "without-unreal": { type: "string" } },
		strict: true
	});
	const withoutUnreal = values["without-unreal"]?.trim();
	if (withoutUnreal === "")
		throw new Error("--without-unreal needs the reason for this release.");
	return { withoutUnreal };
}

export function publicationConfirmationPhrase(version: string) {
	return `publish ${version}`;
}

export function assertPublicationConfirmation(answer: string, version: string) {
	const expected = publicationConfirmationPhrase(version);
	if (answer !== expected) {
		throw new Error(
			`Release publication aborted: expected the exact phrase ${JSON.stringify(expected)}.`
		);
	}
}

/** The environment with one PATH entry, led by the Node running this release. */
export function releaseEnvironment(environment: NodeJS.ProcessEnv = process.env) {
	const env = { ...environment };
	const path = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "path") delete env[key];
	}
	env.PATH = [dirname(process.execPath), path].join(delimiter);
	return env;
}

function runPnpm(args: readonly string[], env: NodeJS.ProcessEnv) {
	const pnpmCli = env.npm_execpath;
	if (!pnpmCli || !existsSync(pnpmCli)) {
		throw new Error("Run the release through pnpm: pnpm release.");
	}
	const isJavaScriptCli = /\.(?:c|m)?js$/i.test(pnpmCli);
	const command = isJavaScriptCli ? process.execPath : pnpmCli;
	const result = spawnSync(command, isJavaScriptCli ? [pnpmCli, ...args] : args, {
		cwd: repositoryRoot,
		env,
		shell: false,
		stdio: "inherit",
		windowsHide: true
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}.`);
	}
}

interface Verification {
	readonly commit: string;
	readonly coverage: readonly GateCoverage[];
	readonly packDirectory: string;
	readonly entries: readonly PublicationEntry[];
	readonly withoutUnreal: string | undefined;
}

function verifyRelease(
	commit: string,
	withoutUnreal: string | undefined,
	env: NodeJS.ProcessEnv
): Verification {
	const tree = readTree(commit);
	let evidence = readReleaseEvidence(PUBLIC_VERSION);
	const releaseText = RELEASE_GATES.find((gate) => gate.id === "release-text")!;
	// Release text is cheap and the release notes often change after the long gates, so rerun it
	// here rather than send the operator back to release:prepare.
	if (gateEvidenceState(evidence.gates["release-text"], "everything", tree).kind !== "current") {
		const startedAt = Date.now();
		runPnpm(["run", "format:check"], env);
		runPnpm(["run", "test:release"], env);
		evidence = {
			...evidence,
			gates: {
				...evidence.gates,
				"release-text": {
					status: "passed",
					scope: releaseText.scope,
					fingerprint: gateFingerprint(releaseText.scope, tree),
					commit,
					finishedAt: new Date().toISOString(),
					durationMs: Date.now() - startedAt,
					trace: "pnpm release"
				}
			}
		};
		writeReleaseEvidence(evidence);
	}
	const { coverage, problems } = releaseGateCoverage(evidence, tree, { withoutUnreal });
	if (problems.length > 0) {
		throw new Error(
			`Release evidence does not cover ${commit}:\n- ${problems.join("\n- ")}\n` +
				"Run pnpm release:prepare; it reruns only these gates."
		);
	}
	if (evidence.pack === undefined) {
		throw new Error("Release evidence has no kept pack; run pnpm release:prepare --only pack.");
	}
	const entries = verifyPackedRelease(
		evidence.pack.directory,
		PUBLIC_VERSION,
		evidence.pack.commit
	);
	return { commit, coverage, packDirectory: evidence.pack.directory, entries, withoutUnreal };
}

async function confirmPublication(verification: Verification) {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error(
			"Release publication requires an interactive terminal for confirmation and npm authentication."
		);
	}
	console.log(`\nRelease ${PUBLIC_VERSION} at ${verification.commit}:`);
	for (const { gate, state } of verification.coverage) {
		if (state.kind !== "current") continue;
		const { result } = state;
		console.log(
			`  ${gate.id.padEnd(14)} ${result.status} on ${result.commit.slice(0, 10)}${result.detail ? ` — ${result.detail}` : ""}`
		);
	}
	if (verification.withoutUnreal !== undefined) {
		console.log(`  Unreal gates not required: ${verification.withoutUnreal}`);
	}
	console.log(
		`  ${verification.entries.length} validated tarballs from ${verification.packDirectory}`
	);
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await terminal.question(
			`\nType ${JSON.stringify(publicationConfirmationPhrase(PUBLIC_VERSION))} ` +
				"to begin npm publication and immediate authentication; any other input aborts. "
		);
		assertPublicationConfirmation(answer, PUBLIC_VERSION);
	} finally {
		terminal.close();
	}
}

/**
 * The integrity Changesets records for a tarball, read at publication time and refused unless the
 * bytes still match the digest the clean pack validated. The confirmation prompt can wait
 * indefinitely, so the check before it does not cover what is published after it.
 */
export function validatedIntegrity(directory: string, entry: PublicationEntry) {
	const digest = sha256(readFileSync(join(directory, entry.filename)));
	if (digest.toString("hex") !== entry.sha256) {
		throw new Error(
			`${entry.filename} changed after it was validated (sha256 ${digest.toString("hex")}); ` +
				"rerun pnpm release:prepare --only pack."
		);
	}
	return `sha256-${digest.toString("base64")}`;
}

function publish(verification: Verification, env: NodeJS.ProcessEnv) {
	const planPath = join(verification.packDirectory, "changesets-plan.json");
	runPnpm(["exec", "changeset", "publish-plan", "--output", planPath], env);
	const plan = Schema.decodeUnknownSync(Schema.fromJsonString(ChangesetsPublishPlan))(
		readFileSync(planPath, "utf8")
	);
	const packed = packedPublishPlan(plan, verification.entries, (entry) =>
		validatedIntegrity(verification.packDirectory, entry)
	);
	writeFileSync(
		join(verification.packDirectory, "publish-plan.json"),
		`${JSON.stringify(packed, undefined, 2)}\n`
	);
	runPnpm(["exec", "changeset", "publish", "--from-pack-dir", verification.packDirectory], env);
}

async function main() {
	const { withoutUnreal } = parseReleaseArguments(process.argv.slice(2));
	const env = releaseEnvironment();
	await runRelease({
		validateSource: () => assertCleanReleaseSource(),
		verify: (commit) => verifyRelease(commit, withoutUnreal, env),
		confirm: confirmPublication,
		publish: (verification) => publish(verification, env)
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
