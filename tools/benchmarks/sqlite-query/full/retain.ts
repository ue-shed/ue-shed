/** Complete upstream data in bounded batches; no single corpus-sized JSON string. */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { Effect } from "effect";
import { GameTextEngineSession } from "../../../../packages/unreal-assets/dist/game-text-engine-session.js";
import {
	answerJson,
	answerRows
} from "../../../../packages/unreal-assets/dist/game-text-engine-client.js";
import { gameTextEngineContract } from "../../../../packages/protocol/dist/index.js";
import { LocalizationLineField } from "../../../../packages/game-text/src/index-reads.ts";
import { withCorpusUnrealLock } from "../../../../scripts/game-text-corpus-lock.ts";
import { withNative } from "./native.ts";
import { LocalizationTargetName } from "../../../../packages/localization/dist/browser.js";
import { LocalizationLineId } from "../../../../packages/game-text/src/localization-schema.ts";
import { TextUnitId } from "../../../../packages/game-text/src/schema.ts";
import { ndjson } from "./store.ts";
import { UnitRecordCodec } from "./model.ts";
import { Schema } from "effect";

const [sourcePath, outputPath, executablePath = "target/release/uasset.exe"] =
	process.argv.slice(2);
if (!sourcePath || !outputPath) throw new Error("retain.ts PREPARED_INPUT NEW_OUTPUT [READER]");
const source = resolve(sourcePath),
	output = resolve(outputPath),
	executable = resolve(executablePath);
await mkdir(output);
const input = JSON.parse(await readFile(resolve(source, "input.json"), "utf8"));
const target = LocalizationTargetName.make(input.target ?? "Generated");
await withCorpusUnrealLock(async () => {
	await withNative(input, executable, async (query) => {
		const header = await Effect.runPromise(query.readCorpusHeader());
		const first = await Effect.runPromise(
			query.searchRows({
				query: "",
				capability: "all",
				pageSize: 1,
				localization: { target }
			})
		);
		const info = {
			...input,
			target,
			nativeCulture: input.nativeCulture ?? "en",
			cultures:
				input.cultures ??
				first.localization?.lines[0]?.cultures.map((mark) => mark.culture) ??
				[],
			corpus: header
		};
		await writeFile(resolve(output, "input.json"), JSON.stringify(info));
		const session = new GameTextEngineSession(executable);
		let unitCount = 0,
			lineCount = 0;
		try {
			const identity = answerJson<{ contractHash: string }>(
				await Effect.runPromise(session.call({ action: "capabilities" }))
			);
			if (identity?.contractHash !== gameTextEngineContract.contractHash)
				throw new Error("Contract mismatch");
			const opened = answerJson<{ reader: string }>(
				await Effect.runPromise(
					session.call({
						action: "open",
						configuration: input.settings.configuration,
						expectedGeneration: input.settings.generation,
						expectedJoined: input.settings.joinedKey,
						policy: { audienceRules: [] }
					})
				)
			);
			if (!opened) throw new Error("Missing native reader");
			for (const localized of [false, true]) {
				const file = createWriteStream(
					resolve(output, localized ? "lines.ndjson" : "units.ndjson")
				);
				const raw = localized
					? createWriteStream(resolve(output, "raw-lines.ndjson"))
					: undefined;
				const emit = async <A>(value: A, stream = file) => {
					if (!stream.write(JSON.stringify(value) + "\n")) await once(stream, "drain");
				};
				let after: string | undefined;
				let total = 0;
				do {
					const answer = await Effect.runPromise(
						session.call({
							action: "query",
							reader: opened.reader,
							request: {
								selection: localized ? { target } : {},
								parts: { rows: { limit: 1000, ...(after && { after }) } }
							}
						})
					);
					const rows = answerRows(answer, localized ? "lines" : "units");
					if (localized) {
						const unitRows = new Map(
							answerRows(answer, "units").map((unit) => [String(unit.id), unit])
						);
						const views = await Effect.runPromise(
							query.selectLocalizationLines(
								{
									query: "",
									capability: "all",
									localization: { target },
									lines: rows.map((row) =>
										LocalizationLineId.make(String(row.id))
									)
								},
								LocalizationLineField.literals
							)
						);
						const byId = new Map(views.map((view) => [String(view.id), view]));
						for (const preview of rows) {
							const view = byId.get(String(preview.id));
							if (!view) throw new Error("A visible line has no full view");
							const {
								marks: _marks,
								problems: _problems,
								signals: _signals,
								places: _places,
								...line
							} = view;
							const ids = line.origin.kind === "corpus" ? line.origin.unitIds : [];
							const unitPreview = ids.map((id) => unitRows.get(id)).find(Boolean);
							await emit({
								line,
								view,
								preview,
								...(unitPreview && { unitPreview })
							});
							await emit(line, raw!);
						}
					} else {
						const previews = new Map(rows.map((row) => [String(row.id), row]));
						const units = await Effect.runPromise(
							query.readUnits(rows.map((row) => TextUnitId.make(String(row.id))))
						);
						for (const unit of units)
							await emit({ unit, preview: previews.get(unit.id) });
					}
					total += rows.length;
					after = answerJson<{ nextCursor?: string }>(answer)?.nextCursor;
					if (total % 25000 === 0)
						console.log(
							JSON.stringify({ phase: localized ? "lines" : "units", total })
						);
				} while (after);
				file.end();
				await once(file, "finish");
				if (raw) {
					raw.end();
					await once(raw, "finish");
				}
				if (localized) lineCount = total;
				else unitCount = total;
				console.log(JSON.stringify({ phase: localized ? "lines" : "units", total }));
			}
		} finally {
			await session.close();
		}
		// Generated scale cohorts have no blank sources: verify, rather than silently lose provenance.
		// Small semantic fixtures may contain blanks; their raw path keeps those full objects too.
		if (unitCount !== header.coverage.textUnits) {
			const previews = new Map();
			for await (const value of ndjson(resolve(output, "units.ndjson"))) {
				const record = Schema.decodeUnknownSync(UnitRecordCodec)(value);
				previews.set(record.unit.id, record.preview);
			}
			const corpus = await Effect.runPromise(query.readCorpus());
			const stream = createWriteStream(resolve(output, "units.ndjson"));
			for (const unit of corpus.units)
				if (
					!stream.write(
						JSON.stringify({ unit, preview: previews.get(unit.id) ?? null }) + "\n"
					)
				)
					await once(stream, "drain");
			stream.end();
			await once(stream, "finish");
			unitCount = corpus.units.length;
		}
		if (input.rawLineCount !== undefined && lineCount !== input.rawLineCount) {
			const lines = await Effect.runPromise(query.readLocalizationLines());
			const stream = createWriteStream(resolve(output, "raw-lines.ndjson"));
			for (const line of lines)
				if (!stream.write(JSON.stringify(line) + "\n")) await once(stream, "drain");
			stream.end();
			await once(stream, "finish");
			lineCount = lines.length;
		}
		await writeFile(
			resolve(output, "retention.json"),
			JSON.stringify({
				units: unitCount,
				rawLines: lineCount,
				completeRawUnitCount: header.coverage.textUnits,
				completeRawLineCount: input.rawLineCount ?? null,
				retainedAt: new Date().toISOString()
			})
		);
	});
});
