/**
 * Times the localization import through the native writer over a generated target: a manifest and,
 * per culture, an archive (both UTF-16, as Unreal writes them) and a PO file. It measures a cold
 * import, an unchanged warm refresh and a warm refresh after every file was rewritten. The target
 * and its cache live in a temporary directory, which is removed after; the script prints its
 * measurements as JSON.
 *
 * UE_SHED_UASSET_EXECUTABLE=<uasset> node --import tsx scripts/benchmark-localization-refresh.ts
 *   [--lines 130000] [--cultures 10] [--directory <parent>]
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Effect, Layer, Result } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	discoverLocalizationTargets
} from "../packages/localization/dist/index.js";
import { importLocalizationTarget } from "../packages/game-text/src/localization-import.ts";

const { values } = parseArgs({
	options: {
		lines: { type: "string", default: "130000" },
		cultures: { type: "string", default: "10" },
		directory: { type: "string", default: tmpdir() }
	}
});
if (!process.env.UE_SHED_UASSET_EXECUTABLE)
	throw new Error("Set UE_SHED_UASSET_EXECUTABLE to the native reader.");
const count = (name: "lines" | "cultures", minimum: number, maximum: number) => {
	const value = Number(values[name]);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new Error(`--${name} must be ${minimum}–${maximum}.`);
	return value;
};
const lines = count("lines", 100, 1_000_000);
const cultures = ["en", "de", "fr", "es", "it", "ja", "ko", "pl", "pt", "zh"].slice(
	0,
	count("cultures", 2, 10)
);
const discovered = discoverLocalizationTargets({
	dashboardText: "",
	configs: [
		{
			relativePath: "Config/Localization/Generated.ini",
			text: [
				"[CommonSettings]",
				"SourcePath=Content/Localization/Generated",
				"DestinationPath=Content/Localization/Generated",
				"ManifestName=Generated.manifest",
				"ArchiveName=Generated.archive",
				"PortableObjectName=Generated.po",
				`NativeCulture=${cultures[0]}`,
				...cultures.map((culture) => `CulturesToGenerate=${culture}`),
				"[GatherTextStep0]",
				"CommandletClass=GatherTextFromAssets",
				"IncludePathFilters=Content/Text/*",
				""
			].join("\n")
		}
	]
});
if (Result.isFailure(discovered)) throw discovered.failure;
const target = discovered.success.targets[0]!;
type Culture = (typeof target.cultures)[number];
const paths = {
	manifest: target.outputPaths.manifest!,
	archive: (culture: Culture) => target.outputPaths.archives[culture]!,
	po: (culture: Culture) => target.outputPaths.portableObjects[culture]!
};

const key = (index: number) => `K${index}`;
/** Every tenth source line carries the revision, so a new revision edits every file. */
const source = (index: number, revision: number) =>
	`Generated source text for the localization import ${index}` +
	(index % 10 === 0 ? ` (revision ${revision})` : "");
const utf16 = (text: string) =>
	Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
/** Writes every file; a new `revision` changes every file's content. */
async function generate(root: string, revision: number) {
	const write = async (path: string, bytes: string | Buffer) => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), bytes);
	};
	await write(
		paths.manifest,
		utf16(
			JSON.stringify(
				{
					FormatVersion: 1,
					Namespace: "UI",
					Children: Array.from({ length: lines }, (_, index) => ({
						Source: { Text: source(index, revision) },
						Keys: [{ Key: key(index), Path: `/Game/Text/Table.Table.${key(index)}` }]
					}))
				},
				null,
				"\t"
			)
		)
	);
	for (const culture of target.cultures) {
		const translation = (index: number) => `${culture} translation ${revision} ${index}`;
		await write(
			paths.archive(culture),
			utf16(
				JSON.stringify(
					{
						FormatVersion: 2,
						Namespace: "UI",
						Children: Array.from({ length: lines }, (_, index) => ({
							Key: key(index),
							Source: { Text: source(index, revision) },
							Translation: { Text: translation(index) }
						}))
					},
					null,
					"\t"
				)
			)
		);
		await write(
			paths.po(culture),
			Array.from(
				{ length: lines },
				(_, index) =>
					`#. Key:\t${key(index)}\n#: /Game/Text/Table.Table.${key(index)}\n` +
					`msgctxt "UI,${key(index)}"\nmsgid "${source(index, revision)}"\nmsgstr "${translation(index)}"\n`
			).join("\n")
		);
	}
}

const evidence = Layer.effect(
	LocalizationEvidence,
	Effect.gen(function* () {
		const live = yield* LocalizationEvidence;
		return LocalizationEvidence.of({
			...live,
			discover: () => Effect.succeed({ schemaVersion: 1, targets: [target], diagnostics: [] })
		});
	})
).pipe(Layer.provide(LocalizationEvidenceNodeLive));

const directory = await mkdtemp(join(values.directory, "ue-shed-localization-refresh-"));
try {
	const projectRoot = join(directory, "project");
	const cacheRoot = join(directory, "cache");
	await mkdir(projectRoot);
	const generated = performance.now();
	await generate(projectRoot, 0);
	const generateSeconds = (performance.now() - generated) / 1000;
	const measure = async (name: string) => {
		const started = performance.now();
		const result = await Effect.runPromise(
			importLocalizationTarget({ projectRoot, cacheRoot, targetName: target.name }).pipe(
				Effect.provide(evidence)
			)
		);
		const seconds = (performance.now() - started) / 1000;
		if (result.diagnostics.length)
			throw new Error(`${name}: ${result.diagnostics[0]!.error.message}`);
		const profile = result.profile;
		return {
			seconds,
			files: result.files.length,
			parsed: result.files.filter((file) => file.parsed).length,
			statHits: profile?.statHits ?? 0,
			nativeCalls: profile?.nativeCalls ?? 0,
			workerCount: profile?.workerCount ?? 0,
			parseMs: profile?.parseMs ?? 0,
			publishMs: profile?.publishMs ?? 0,
			lookupStrings: profile?.lookupStrings ?? 0,
			reusedStrings: profile?.reusedStrings ?? 0
		};
	};
	const cold = await measure("cold");
	const unchanged = await measure("unchanged");
	await generate(projectRoot, 1);
	const rewritten = await measure("rewritten");
	let inputBytes = 0;
	for (const entry of await readdir(projectRoot, { recursive: true, withFileTypes: true }))
		if (entry.isFile()) inputBytes += (await stat(join(entry.parentPath, entry.name))).size;
	console.log(
		JSON.stringify(
			{
				node: process.version,
				lines,
				cultures: cultures.length,
				files: 1 + cultures.length * 2,
				inputBytes,
				generateSeconds,
				cold,
				unchanged,
				rewritten
			},
			null,
			"\t"
		)
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
