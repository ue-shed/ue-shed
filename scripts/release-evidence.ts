/**
 * Release gate evidence: which gates passed, for which inputs. `pnpm release:prepare` records a
 * result per gate with a fingerprint of the files that gate depends on, and `pnpm release` accepts a
 * gate only while that fingerprint still matches the release commit. Editing a changelog after the
 * gates ran therefore reruns only the gates that read changelogs, not the whole check.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";

const repositoryRoot = resolve(import.meta.dirname, "..");

/**
 * The files a gate depends on. `code` gates (the full check and Unreal gates) ignore release text:
 * package changelogs and release notes. `packed` gates read changelogs, which ship in the
 * tarballs, but not release notes. `everything` gates read every tracked file.
 */
export const GateScope = Schema.Literals(["code", "packed", "everything"]);
export type GateScope = typeof GateScope.Type;

export function isReleaseNotes(path: string) {
	return path.startsWith("docs/releases/");
}

export function isReleaseText(path: string) {
	return isReleaseNotes(path) || /(?:^|\/)CHANGELOG\.md$/.test(path);
}

export function inGateScope(scope: GateScope, path: string) {
	switch (scope) {
		case "code":
			return !isReleaseText(path);
		case "packed":
			return !isReleaseNotes(path);
		case "everything":
			return true;
	}
}

/** One `git ls-tree` entry: the path and the blob or link it names. */
export interface TreeEntry {
	readonly path: string;
	readonly object: string;
}

export function readTree(commit: string, cwd = repositoryRoot): readonly TreeEntry[] {
	const result = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", commit], {
		cwd,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		windowsHide: true
	});
	if (result.status !== 0) throw new Error(`git ls-tree ${commit} failed: ${result.stderr}`);
	return result.stdout
		.split("\0")
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf("\t");
			const object = line.slice(0, tab).split(" ")[2] ?? "";
			return { path: line.slice(tab + 1), object };
		});
}

/** A digest of the tracked files in `scope`, so equal inputs give equal fingerprints. */
export function gateFingerprint(scope: GateScope, tree: readonly TreeEntry[]) {
	const hash = createHash("sha256");
	for (const entry of tree.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		if (inGateScope(scope, entry.path)) hash.update(`${entry.object} ${entry.path}\n`);
	}
	return hash.digest("hex");
}

export const GateResult = Schema.Struct({
	status: Schema.Literals(["passed", "failed", "unavailable"]),
	scope: GateScope,
	fingerprint: Schema.String,
	commit: Schema.String,
	finishedAt: Schema.String,
	durationMs: Schema.Number,
	trace: Schema.String,
	detail: Schema.optional(Schema.String)
});
export type GateResult = typeof GateResult.Type;

export const ReleaseEvidence = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	version: Schema.String,
	gates: Schema.Record(Schema.String, GateResult),
	/** The directory `release:pack:clean-check` kept the validated tarballs in. */
	pack: Schema.optional(Schema.Struct({ directory: Schema.String, commit: Schema.String }))
});
export type ReleaseEvidence = typeof ReleaseEvidence.Type;

const decodeEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(ReleaseEvidence));

export function releaseEvidencePath(version: string, root = repositoryRoot) {
	return join(root, "out", "release-evidence", `${version}.json`);
}

export function readReleaseEvidence(version: string, root = repositoryRoot): ReleaseEvidence {
	const path = releaseEvidencePath(version, root);
	if (!existsSync(path)) return { schemaVersion: 1, version, gates: {} };
	const evidence = decodeEvidence(readFileSync(path, "utf8"));
	if (evidence.version !== version) {
		throw new Error(`${path} records ${evidence.version}, not ${version}.`);
	}
	return evidence;
}

export function writeReleaseEvidence(evidence: ReleaseEvidence, root = repositoryRoot) {
	const path = releaseEvidencePath(evidence.version, root);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(evidence, undefined, "\t")}\n`, "utf8");
	return path;
}

export type GateEvidenceState =
	| { readonly kind: "current"; readonly result: GateResult }
	| { readonly kind: "stale"; readonly result: GateResult }
	| { readonly kind: "failed"; readonly result: GateResult }
	| { readonly kind: "missing" };

/**
 * Whether recorded evidence still covers a gate: it passed (or its engine was unavailable) on
 * inputs with the same fingerprint as the release commit's.
 */
export function gateEvidenceState(
	result: GateResult | undefined,
	scope: GateScope,
	tree: readonly TreeEntry[]
): GateEvidenceState {
	if (result === undefined) return { kind: "missing" };
	if (result.status === "failed") return { kind: "failed", result };
	if (result.scope !== scope || result.fingerprint !== gateFingerprint(scope, tree)) {
		return { kind: "stale", result };
	}
	return { kind: "current", result };
}
