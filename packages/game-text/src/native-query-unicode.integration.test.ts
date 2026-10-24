import { Effect, Layer, Schema, Stream } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameTextIndexRefresh, GameTextIndexSource } from "./index-contract.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { textCorpusQuery } from "./query.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { LocalizationFocusRequest, localizationFocusPage } from "./localization-view.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

describe.skipIf(!executable)("native nested JSON evidence", () => {
	it("preserves reserved scalars and lone units in exported package errors", async () => {
		if (!executable) throw new Error("Native reader required");
		const message = "decode \u{f0000} \u{f0001} \u{f0800} \ud800x\udfff";
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					const source = Layer.effect(
						GameTextIndexSource,
						Effect.gen(function* () {
							const original = yield* GameTextIndexSource;
							return GameTextIndexSource.of({
								...original,
								read: (_project, entries) =>
									Stream.fromIterable(
										entries.map((entry) => ({
											event: "error" as const,
											code: "invalid_data",
											path: entry.path,
											message,
											retrySafe: false
										}))
									)
							});
						})
					).pipe(Layer.provide(fixture.source));
					yield* Effect.gen(function* () {
						const model = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
						const corpus = yield* model.query.readCorpus();
						expect(corpus.diagnostics).toContainEqual(
							expect.objectContaining({
								code: "package_inspection_failed",
								message
							})
						);
					}).pipe(
						Effect.provide(
							fixture.layer(
								source,
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30000,
									catalogTimeoutMs: 120000
								})
							)
						)
					);
				})
			)
		);
	}, 120000);

	it("preserves reserved scalars and JSON escapes through exports and detail", async () => {
		if (!executable) throw new Error("Native reader required");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					const scalars = "literal \u{f0000} \u{f0001} \u{f0800} \u{100000} 😀";
					const value = `${scalars} \\ud800 \"quoted\"\n`;
					const extra = { [value]: { value, nested: [value, null, 7, true] } };
					yield* Effect.promise(async () => {
						await writeFile(
							join(fixture.projectRoot, "Review.manifest"),
							JSON.stringify({
								FormatVersion: 1,
								Namespace: "UI",
								Children: [
									{
										Source: { Text: "Source", ...extra },
										Keys: [
											{
												Key: "K",
												Path: "/Game/Text/Table.Table.Label",
												DevNotes: scalars,
												MetaData: { Info: { Comment: value }, ...extra }
											}
										]
									}
								]
							})
						);
						for (const culture of fixture.target.cultures) {
							await writeFile(
								join(fixture.projectRoot, `${culture}.archive`),
								JSON.stringify({
									FormatVersion: 2,
									Namespace: "UI",
									Children: [
										{
											Key: "K",
											Source: { Text: "Source", ...extra },
											Translation: { Text: "Shipped", ...extra },
											MetaData: extra
										}
									]
								})
							);
							// Unreal localization files require paired Unicode scalars.
							await writeFile(
								join(fixture.projectRoot, `${culture}.po`),
								`# ${scalars}\n#. ${scalars}\n#: ${scalars}\n#, flag-${scalars}\nmsgctxt "UI,K"\nmsgid "Source"\nmsgstr "Shipped"\n`
							);
						}
					});
					yield* Effect.gen(function* () {
						const model = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
						const oracle = textCorpusQuery(
							fixture.raw(),
							undefined,
							joinLocalizationTarget(fixture.raw(), model.evidence)
						);
						const request = {
							query: "",
							capability: "all" as const,
							localization: { target: fixture.target.name }
						};
						const expected = oracle.localizationLines(request);
						expect(expected).toHaveLength(1);
						expect(expected[0]!.manifest[0]!.source[value]).toEqual(extra[value]);
						expect(expected[0]!.manifest[0]!.metadata).toEqual({
							Info: { Comment: value },
							...extra
						});
						expect(yield* model.query.localizationLines(request)).toEqual(expected);
						expect(yield* model.query.readLocalizationLines()).toEqual(expected);
						expect(yield* model.query.localizationFocus(expected[0]!.id)).toEqual(
							expected[0]
						);
						const detail = Schema.decodeUnknownSync(LocalizationFocusRequest)({
							target: fixture.target.name,
							selection: { kind: "line", id: expected[0]!.id }
						});
						// The engine adds the line's problems; with no culture scope, every culture's.
						expect(yield* model.query.localizationDetail(detail)).toEqual({
							...localizationFocusPage(model.localization, expected[0]!, detail),
							problems: ["translation"]
						});
					}).pipe(
						Effect.provide(
							fixture.layer(
								fixture.source,
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30000,
									catalogTimeoutMs: 120000
								})
							)
						)
					);
				})
			)
		);
	}, 120000);
});
