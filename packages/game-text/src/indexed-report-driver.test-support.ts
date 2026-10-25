// Synchronous test-fixture transport only. Reports themselves use the production index API.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationTarget,
	LocalizationTargetEvidence
} from "@ue-shed/localization";
import type {
	SavedAssetPackageTextRecord,
	SavedAssetPackageTextEvent
} from "@ue-shed/unreal-assets";
import { TextCorpus } from "./schema.js";
import { GameTextRuleDocument } from "./game-text-rules.js";
import { LocalizationCheckOptions } from "./localization-quality-schema.js";
import {
	GameTextIndexRefresh,
	GameTextIndexSource,
	gameTextIndexRefreshLayer
} from "./index-refresh.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { GameTextIndexBuilder } from "./index-builder.js";
import { LocalizationImportSource } from "./localization-import.js";
import { emptyPackageTextRecord } from "./package-text-record.js";

const Input = Schema.Struct({
	directory: Schema.String,
	corpus: TextCorpus,
	evidence: Schema.optionalKey(LocalizationTargetEvidence),
	kind: Schema.Literals(["source", "localization", "corpus"]),
	document: Schema.optionalKey(GameTextRuleDocument),
	options: Schema.optionalKey(LocalizationCheckOptions)
});
const input = Schema.decodeUnknownSync(Schema.fromJsonString(Input))(readFileSync(0, "utf8"));
// Evidence is already schema-owned test input; its actual files are parsed again by the builder.
const files = input.evidence;
const projectRoot = resolve(input.directory, "project");
mkdirSync(projectRoot, { recursive: true });
const target =
	files &&
	Schema.decodeUnknownSync(LocalizationTarget)({
		...files.target,
		poFormat:
			files.cultures.flatMap((culture) =>
				culture.po.status === "read" && culture.po.value.format
					? [culture.po.value.format]
					: []
			)[0] ?? files.target.poFormat,
		outputPaths: {
			...files.target.outputPaths,
			manifest: "Localization/Test.manifest",
			archives: Object.fromEntries(
				files.target.cultures.map((culture) => [culture, `Localization/${culture}.archive`])
			),
			portableObjects: Object.fromEntries(
				files.target.cultures.map((culture) => [culture, `Localization/${culture}.po`])
			),
			locmeta: null,
			wordCount: null
		}
	});
const write = (path: string, text: string) => {
	const absolute = join(projectRoot, path);
	mkdirSync(dirname(absolute), { recursive: true });
	if (!existsSync(absolute)) writeFileSync(absolute, text);
};
if (files && target) {
	if (files.manifest.status === "read")
		write(
			target.outputPaths.manifest!,
			JSON.stringify({
				FormatVersion: 1,
				Namespace: "",
				Subnamespaces: files.manifest.value.entries.map((entry) => ({
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
			})
		);
	for (const culture of files.cultures) {
		if (culture.archive.status === "read")
			write(
				target.outputPaths.archives[culture.culture]!,
				JSON.stringify({
					FormatVersion: 2,
					Namespace: "",
					Subnamespaces: culture.archive.value.entries.map((entry) => ({
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
				})
			);
		if (culture.po.status === "read")
			write(
				target.outputPaths.portableObjects[culture.culture]!,
				culture.po.value.entries
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
					.join("\n\n") + "\n"
			);
	}
}
const records = new Map<string, SavedAssetPackageTextRecord>();
const failures = new Map<string, Extract<SavedAssetPackageTextEvent, { event: "error" }>>();
for (const unit of input.corpus.units)
	for (const occurrence of unit.occurrences) {
		const path = join(projectRoot, occurrence.packageFile);
		const record = records.get(path) ?? emptyPackageTextRecord(path);
		const location = occurrence.location;
		const saved: SavedAssetPackageTextRecord["occurrences"][number] = {
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
			...(occurrence.audienceReason === "gather_table_editor_only"
				? { gather_editor_only: true }
				: occurrence.audienceReason === "gather_table_runtime"
					? { gather_editor_only: false }
					: undefined),
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
		records.set(path, { ...record, occurrences: [...record.occurrences, saved] });
	}
for (const coverage of input.corpus.packageCoverage ?? []) {
	const path = join(projectRoot, coverage.packageFile);
	const record = records.get(path) ?? emptyPackageTextRecord(path);
	records.set(path, {
		...record,
		status: coverage.status === "partial" ? "partial" : record.status
	});
}
for (const diagnostic of input.corpus.diagnostics) {
	if (
		diagnostic.code === "package_inspection_failed" ||
		diagnostic.code === "package_partially_decoded"
	) {
		const path = join(projectRoot, diagnostic.packageFile);
		const record = records.get(path) ?? emptyPackageTextRecord(path);
		if (diagnostic.code === "package_inspection_failed")
			failures.set(path, {
				event: "error",
				path,
				code: "asset_malformed_data",
				message: diagnostic.message,
				retrySafe: false
			});
		records.set(path, {
			...record,
			status: "partial",
			decodeErrors: diagnostic.code === "package_partially_decoded" ? 1 : 0
		});
		continue;
	}
	if (diagnostic.code !== "unsupported_text_history") continue;
	const path = join(projectRoot, diagnostic.packageFile);
	const record = records.get(path) ?? emptyPackageTextRecord(path);
	records.set(path, {
		...record,
		status: "partial",
		gapCounts: {
			...record.gapCounts,
			unsupported_text_history: record.gapCounts.unsupported_text_history + 1
		},
		gapSamples: [
			...record.gapSamples,
			{
				reason: "unsupported_text_history",
				object_path: diagnostic.objectPath ?? "",
				property_path: diagnostic.propertyPath ?? ""
			}
		]
	});
}
const source = Layer.succeed(GameTextIndexSource, {
	inventory: () =>
		Effect.succeed(
			[...records.keys()]
				.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
				.map((path) => ({
					path,
					signature: "immutable-suite-fixture",
					headerData: {
						packageFlags: 0x00040000,
						gatherableTextDataCount: 1,
						gatherableTextDataOffset: 1,
						hasTextProperty: true
					}
				}))
		),
	read: (_root, entries) =>
		Stream.fromIterable(
			entries.map((entry) => failures.get(entry.path) ?? records.get(entry.path)!)
		)
});
const evidence = Layer.effect(
	LocalizationEvidence,
	Effect.map(LocalizationEvidence, (live) =>
		LocalizationEvidence.of({
			...live,
			discover: () =>
				Effect.succeed({
					schemaVersion: 1,
					targets: target ? [target] : [],
					diagnostics: []
				})
		})
	)
).pipe(Layer.provide(LocalizationEvidenceNodeLive));
const builder = Layer.effect(
	GameTextIndexBuilder,
	Effect.map(GameTextIndexBuilder, (builder) =>
		GameTextIndexBuilder.of({
			...builder,
			importLocalizationTarget: (request) =>
				builder.importLocalizationTarget(request).pipe(
					Effect.provideService(LocalizationImportSource, {
						...LocalizationImportSource.defaultValue()
					})
				)
		})
	)
).pipe(Layer.provide(typeScriptIndexBuilderLayer));
const layer = gameTextIndexRefreshLayer(join(input.directory, "cache")).pipe(
	Layer.provide(source),
	Layer.provide(builder),
	Layer.provide(typeScriptIndexBuilderLayer),
	Layer.provide(evidence)
);
const report = await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const model = yield* (yield* GameTextIndexRefresh).refresh({
				projectRoot,
				...(target ? { targetName: target.name } : undefined)
			});
			if (input.kind === "corpus") return yield* model.corpus;
			if (input.kind === "localization")
				return yield* model.localizationCheck(input.document, input.options);
			if (!input.document) throw new Error("A source report needs its rule document.");
			return yield* (yield* model.sourceQuality(input.document)).export("all");
		})
	).pipe(Effect.provide(layer))
);
process.stdout.write(JSON.stringify(report));
