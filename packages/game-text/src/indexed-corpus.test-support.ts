import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import {
	encodeLocalizationReviewFile,
	LocalizationTarget,
	type LocalizationReviewFile,
	type LocalizationTargetEvidence
} from "@ue-shed/localization";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import {
	GameTextIndexRefresh,
	GameTextIndexSource,
	type GameTextIndexRefreshResult
} from "./index-contract.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import type { LocalizationKeyChangePair } from "./localization-key-changes.js";
import type { TextCorpus, TextOccurrence } from "./schema.js";

type SavedOccurrence = SavedAssetPackageTextRecord["occurrences"][number];

/** The reader's form of a saved place. */
export function savedOccurrence(occurrence: TextOccurrence): SavedOccurrence {
	const location = occurrence.location;
	return {
		source: occurrence.source,
		dev_notes: occurrence.devNotes,
		identity:
			occurrence.identity.status === "string_table"
				? {
						status: "string_table",
						table_id: occurrence.identity.tableId,
						key: occurrence.identity.key
					}
				: occurrence.identity,
		edit_capability: occurrence.editCapability,
		location:
			location.kind === "string_table_entry"
				? {
						kind: location.kind,
						object_path: location.objectPath,
						entry_key: location.entryKey
					}
				: location.kind === "data_table_cell"
					? {
							kind: location.kind,
							object_path: location.objectPath,
							row: location.row,
							property_path: location.propertyPath
						}
					: {
							kind: location.kind,
							object_path: location.objectPath,
							class_path: location.classPath,
							property_path: location.propertyPath
						}
	};
}

const manifestJson = (entries: LocalizationTargetEvidence["manifest"]) =>
	entries.status !== "read"
		? undefined
		: JSON.stringify({
				FormatVersion: 1,
				Namespace: "",
				Subnamespaces: entries.value.entries.map((entry) => ({
					Namespace: entry.namespace,
					Children: [
						{
							Source: entry.source,
							Keys: [
								{
									Key: entry.key,
									Path: entry.path,
									Optional: entry.optional,
									MetaData: entry.metadata,
									DevNotes: entry.devNotes
								}
							]
						}
					]
				}))
			});

const archiveJson = (archive: LocalizationTargetEvidence["cultures"][number]["archive"]) =>
	archive.status !== "read"
		? undefined
		: JSON.stringify({
				FormatVersion: 2,
				Namespace: "",
				Subnamespaces: archive.value.entries.map((entry) => ({
					Namespace: entry.namespace,
					Children: [
						{
							Key: entry.key,
							Source: entry.source,
							Translation: entry.translation,
							Optional: entry.optional,
							MetaData: entry.metadata
						}
					]
				}))
			});

const poText = (po: LocalizationTargetEvidence["cultures"][number]["po"]) =>
	po.status !== "read"
		? undefined
		: po.value.entries
				.map((entry) =>
					[
						...entry.translatorComments.map((comment) => `# ${comment}`),
						...entry.extractedComments.map((comment) => `#. ${comment}`),
						...entry.referenceComments.map((comment) => `#: ${comment}`),
						...(entry.flags.length ? [`#, ${entry.flags.join(", ")}`] : []),
						...entry.previousMsgidLines,
						...(entry.msgctxt === undefined
							? []
							: [`msgctxt ${JSON.stringify(entry.msgctxt)}`]),
						`msgid ${JSON.stringify(entry.msgid)}`,
						...(entry.msgidPlural === undefined
							? []
							: [`msgid_plural ${JSON.stringify(entry.msgidPlural)}`]),
						...Object.entries(entry.msgstr).map(
							([plural, text]) =>
								`${entry.msgidPlural === undefined ? "msgstr" : `msgstr[${plural}]`} ${JSON.stringify(text)}`
						)
					].join("\n")
				)
				.join("\n\n") + "\n";

export interface IndexedCorpusInput {
	/** The target's files; without them the project has no localization target. */
	readonly files?: LocalizationTargetEvidence;
	readonly review?: LocalizationReviewFile;
	readonly keyChangePairs?: readonly LocalizationKeyChangePair[];
	/** Packages whose saved header says Unreal gathers no text from them. */
	readonly notGatherable?: readonly string[];
	/** Reader records saved beside the corpus's packages, at project-relative paths. */
	readonly records?: readonly SavedAssetPackageTextRecord[];
}

/**
 * Saves a corpus's places as packages, and the target's files, in a scratch project, refreshes
 * its index and reads the refreshed model in `use` while the model is open.
 */
export const withIndexedCorpus = <A, E>(
	text: Pick<TextCorpus, "units"> & Partial<Pick<TextCorpus, "packageCoverage">>,
	input: IndexedCorpusInput,
	use: (model: GameTextIndexRefreshResult) => Effect.Effect<A, E>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const packages = new Map<string, SavedOccurrence[]>();
			for (const unit of text.units)
				for (const occurrence of unit.occurrences)
					packages.set(occurrence.packageFile, [
						...(packages.get(occurrence.packageFile) ?? []),
						savedOccurrence(occurrence)
					]);
			for (const coverage of text.packageCoverage ?? [])
				if (!packages.has(coverage.packageFile)) packages.set(coverage.packageFile, []);
			const partial = new Set(
				(text.packageCoverage ?? [])
					.filter((coverage) => coverage.status === "partial")
					.map((coverage) => coverage.packageFile)
			);
			// Packages carry project-relative paths, as the project reader reports them.
			const records = [
				...[...packages].map(
					([path, occurrences]): SavedAssetPackageTextRecord => ({
						...emptyPackageTextRecord(path),
						occurrences,
						...(partial.has(path) ? { status: "partial" as const } : undefined)
					})
				),
				...(input.records ?? [])
			];
			const gatherable = {
				packageFlags: 0x00040000,
				gatherableTextDataCount: 1,
				gatherableTextDataOffset: 1,
				hasTextProperty: true
			};
			const inventory = [
				...records.map((record) => ({ path: record.path, headerData: gatherable })),
				...(input.notGatherable ?? []).map((path) => ({
					path,
					headerData: {
						packageFlags: 0,
						gatherableTextDataCount: 0,
						gatherableTextDataOffset: 0,
						hasTextProperty: false
					}
				}))
			]
				.sort((left, right) =>
					Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
				)
				.map((entry) => ({ ...entry, signature: "0" }));
			const source = Layer.succeed(GameTextIndexSource, {
				inventory: () => Effect.succeed(inventory),
				read: (_root, entries) => {
					const wanted = new Set(entries.map((entry) => entry.path));
					return Stream.fromIterable(records.filter((record) => wanted.has(record.path)));
				}
			});
			const files = input.files;
			let targetName: string | undefined;
			if (files === undefined) fixture.setTargets([]);
			else {
				const target = Schema.decodeUnknownSync(LocalizationTarget)({
					...files.target,
					poFormat:
						files.cultures.flatMap((culture) =>
							culture.po.status === "read" && culture.po.value.format
								? [culture.po.value.format]
								: []
						)[0] ?? files.target.poFormat,
					outputPaths: fixture.target.outputPaths
				});
				fixture.setTargets([target]);
				targetName = target.name;
				const write = (path: string, contents: string | undefined) =>
					Effect.promise(async () => {
						const absolute = join(fixture.projectRoot, path);
						if (contents === undefined) return rm(absolute, { force: true });
						await mkdir(dirname(absolute), { recursive: true });
						await writeFile(absolute, contents);
					});
				yield* write(target.outputPaths.manifest!, manifestJson(files.manifest));
				for (const culture of files.cultures) {
					yield* write(
						target.outputPaths.archives[culture.culture]!,
						archiveJson(culture.archive)
					);
					yield* write(
						target.outputPaths.portableObjects[culture.culture]!,
						poText(culture.po)
					);
				}
				if (input.review !== undefined)
					yield* write(
						`Config/UEShed/Localization/${target.name}.review.json`,
						encodeLocalizationReviewFile(input.review)
					);
			}
			return yield* Effect.gen(function* () {
				const model = yield* (yield* GameTextIndexRefresh).refresh({
					projectRoot: fixture.projectRoot,
					...(targetName === undefined ? undefined : { targetName }),
					...(input.keyChangePairs === undefined
						? undefined
						: { keyChangePairs: input.keyChangePairs })
				});
				return yield* use(model);
			}).pipe(Effect.provide(fixture.layer(source)));
		})
	);
