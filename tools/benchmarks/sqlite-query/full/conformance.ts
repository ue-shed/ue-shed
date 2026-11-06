import { Effect, Schema } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withNative } from "./native.ts";
import { ndjson } from "./store.ts";
import { workload, type Case } from "./workload.ts";
import { digest } from "./evaluate.ts";
import {
	json,
	LineRecordCodec,
	UnitRecordCodec,
	type Json,
	type RetainedInput,
	type LineRecord,
	type UnitRecord
} from "./model.ts";
import type { NativeTextQuery } from "../../../../packages/game-text/src/native-query-contract.ts";
import { LocalizationLineField } from "../../../../packages/game-text/src/index-reads.ts";
import { LocalizationLineId } from "../../../../packages/game-text/src/localization-schema.ts";

export async function nativeAnswer(query: NativeTextQuery, entry: Case): Promise<Json> {
	switch (entry.operation) {
		case "rows":
			return json(await Effect.runPromise(query.searchRows(entry.request)));
		case "search":
			return json(await Effect.runPromise(query.search(entry.request)));
		case "select":
			return json(
				await Effect.runPromise(
					query.selectLocalizationLines(
						entry.request,
						(entry.fields ?? []).map((field) =>
							Schema.decodeUnknownSync(LocalizationLineField)(field)
						)
					)
				)
			);
		case "export":
			return json(await Effect.runPromise(query.export(entry.request)));
		case "corpus":
			return json(await Effect.runPromise(query.readCorpus()));
		case "fingerprint":
			return Effect.runPromise(query.corpusFingerprint());
		case "lines":
			return json(await Effect.runPromise(query.readLocalizationLines()));
		case "line":
			return json(
				(await Effect.runPromise(
					query.localizationFocus(LocalizationLineId.make(entry.id))
				)) ?? null
			);
		case "detail":
			return json((await Effect.runPromise(query.localizationDetail(entry.request))) ?? null);
		case "aggregate":
			return json(await Effect.runPromise(query.aggregate(entry.request)));
	}
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/full/conformance.ts")) {
	const [rootPath, executablePath = "target/release/uasset.exe"] = process.argv.slice(2);
	if (!rootPath) throw new Error("conformance.ts BUNDLE [READER]");
	const root = resolve(rootPath),
		input: RetainedInput = JSON.parse(await readFile(resolve(root, "input.json"), "utf8"));
	const lines: LineRecord[] = [],
		units: UnitRecord[] = [];
	for await (const line of ndjson(resolve(root, "lines.ndjson"))) {
		lines.push(Schema.decodeUnknownSync(LineRecordCodec)(line));
		if (lines.length === (input.scale >= 0.1 ? 1000 : 20)) break;
	}
	for await (const unit of ndjson(resolve(root, "units.ndjson"))) {
		units.push(Schema.decodeUnknownSync(UnitRecordCodec)(unit));
		if (units.length === 20) break;
	}
	const cases = workload(input, lines, units).filter(
		(entry) =>
			input.scale < 0.1 || (entry.operation !== "corpus" && entry.operation !== "lines")
	);
	const hashes: string[] = [];
	await withNative(input, resolve(executablePath), async (query) => {
		for (const [index, entry] of cases.entries()) {
			const value = await nativeAnswer(query, entry);
			hashes.push(digest(value));
			await writeFile(resolve(root, `expected-${index}.json`), JSON.stringify(value));
			if ((index + 1) % 25 === 0)
				console.log(
					JSON.stringify({
						phase: "native-parity",
						complete: index + 1,
						total: cases.length
					})
				);
		}
	});
	await writeFile(resolve(root, "expected.json"), JSON.stringify({ workload: cases, hashes }));
	console.log(JSON.stringify({ nativeCases: cases.length }));
}
