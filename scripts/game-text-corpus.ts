import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";

/** File the corpus commandlet writes beside its packages; --clean requires it. */
export const corpusManifestName = "UEShedGameTextCorpus.json";
export const corpusManifestFormat = "ue-shed-game-text-corpus";

export const corpusUsage =
	"Usage: pnpm corpus:generate --project <path.uproject> [--lines 10000] [--seed 1] [--density 2] " +
	"[--root /Game/Developers/<user>/GameTextCorpus] [--engine-root <path>] [--clean] [--patch]";

export interface CorpusArguments {
	readonly project: string;
	readonly lines: number;
	readonly seed: number;
	readonly density: number | undefined;
	readonly root: string;
	readonly engineRoot: string | undefined;
	readonly clean: boolean;
	readonly patch: boolean;
	readonly scenario: "main" | "collapse";
}

/** Unreal's developer folder name: the user name with characters invalid in package names removed. */
export function developerFolderName(userName: string) {
	const sanitized = userName.replace(/[^A-Za-z0-9_-]/gu, "");
	return sanitized.length > 0 ? sanitized : "User";
}

function integerOption(name: string, value: string | undefined, fallback: number, max: number) {
	if (value === undefined) return fallback;
	if (!/^\d+$/u.test(value)) throw new Error(`--${name} must be a whole number.\n${corpusUsage}`);
	const parsed = Number(value);
	if (parsed > max) throw new Error(`--${name} must be at most ${max}.\n${corpusUsage}`);
	return parsed;
}

/** Parses the runner's command line; the default root is the user's developer folder. */
export function parseCorpusArguments(argv: readonly string[], userName: string): CorpusArguments {
	const { values } = parseArgs({
		args: [...argv],
		allowPositionals: false,
		strict: true,
		options: {
			project: { type: "string" },
			lines: { type: "string" },
			seed: { type: "string" },
			density: { type: "string" },
			root: { type: "string" },
			"engine-root": { type: "string" },
			clean: { type: "boolean", default: false },
			patch: { type: "boolean", default: false },
			scenario: { type: "string", default: "main" }
		}
	});
	if (!values.project?.toLowerCase().endsWith(".uproject")) {
		throw new Error(`--project must name a .uproject file.\n${corpusUsage}`);
	}
	const density =
		values.density === undefined ? undefined : integerOption("density", values.density, 2, 12);
	if (density !== undefined && density < 1) throw new Error("--density must be at least 1.");
	const lines = integerOption("lines", values.lines, 10_000, 1_000_000);
	if (values.scenario !== "main" && values.scenario !== "collapse")
		throw new Error("Unknown corpus scenario.");
	if (lines < 1) throw new Error(`--lines must be at least 1.\n${corpusUsage}`);
	const root = (
		values.root ?? `/Game/Developers/${developerFolderName(userName)}/GameTextCorpus`
	).replace(/\/+$/u, "");
	// The generator owns this folder outright, so keep it at least two levels below /Game.
	if (!/^\/Game(?:\/[A-Za-z0-9_-]+){2,}$/u.test(root)) {
		throw new Error(
			`--root must be a folder at least two levels below /Game, such as ` +
				`/Game/Developers/<user>/GameTextCorpus.\n${corpusUsage}`
		);
	}
	return {
		project: resolve(values.project),
		lines,
		seed: integerOption("seed", values.seed, 1, 2_147_483_647),
		density,
		root,
		engineRoot:
			values["engine-root"] === undefined ? undefined : resolve(values["engine-root"]),
		clean: values.clean,
		patch: values.patch,
		scenario: values.scenario
	};
}

/** `/Game/A/B` in `X/P.uproject` is the folder `X/Content/A/B`. */
export function corpusContentFolder(project: string, root: string) {
	return join(dirname(project), "Content", ...root.split("/").slice(2));
}

const CorpusText = Schema.Struct({
	kind: Schema.String,
	field: Schema.String,
	namespace: Schema.String,
	key: Schema.String,
	source: Schema.String,
	notes: Schema.optionalKey(Schema.String)
});

const CorpusPackage = Schema.Struct({
	path: Schema.String,
	kind: Schema.String,
	lines: Schema.Number,
	texts: Schema.Array(CorpusText)
});

/** The manifest the commandlet writes; the C++ writer in tools/unreal owns its shape. */
export const CorpusManifest = Schema.Struct({
	format: Schema.Literal(corpusManifestFormat),
	version: Schema.Literal(1),
	seed: Schema.Number,
	lines: Schema.Number,
	root: Schema.String,
	/** Absent in corpora written before the row struct became an asset; --clean still accepts them. */
	rowStruct: Schema.optionalKey(Schema.String),
	engineVersion: Schema.String,
	counts: Schema.Record(Schema.String, Schema.Number),
	duplicates: Schema.Struct({
		sharedSource: Schema.Number,
		keyConflicts: Schema.Number,
		empty: Schema.Number,
		whitespace: Schema.Number
	}),
	packages: Schema.Array(CorpusPackage)
});
export type CorpusManifest = typeof CorpusManifest.Type;

/** Decodes manifest JSON text, failing on anything the commandlet would not write. */
export function decodeCorpusManifest(contents: string): CorpusManifest {
	return Schema.decodeUnknownSync(Schema.fromJsonString(CorpusManifest))(contents);
}

/** Human summary of a manifest: totals, lines per text kind, packages per kind, duplicates. */
export function summarizeCorpusManifest(manifest: CorpusManifest) {
	const packagesByKind = new Map<string, number>();
	for (const corpusPackage of manifest.packages) {
		packagesByKind.set(corpusPackage.kind, (packagesByKind.get(corpusPackage.kind) ?? 0) + 1);
	}
	const width = Math.max(...Object.keys(manifest.counts).map((kind) => kind.length));
	return [
		`Game Text corpus: ${manifest.lines} lines in ${manifest.packages.length} packages ` +
			`(seed ${manifest.seed}, Unreal ${manifest.engineVersion})`,
		`Root: ${manifest.root}`,
		"Lines by kind:",
		...Object.entries(manifest.counts).map(
			([kind, count]) => `  ${kind.padEnd(width)}  ${count}`
		),
		"Packages by kind:",
		...[...packagesByKind].map(([kind, count]) => `  ${kind.padEnd(width)}  ${count}`),
		`Duplicates: ${manifest.duplicates.sharedSource} shared source, ` +
			`${manifest.duplicates.keyConflicts} key conflicts, ${manifest.duplicates.empty} empty, ` +
			`${manifest.duplicates.whitespace} whitespace-only`
	].join("\n");
}
