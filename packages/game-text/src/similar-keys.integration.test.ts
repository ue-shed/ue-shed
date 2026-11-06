import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameTextIndexRefresh } from "./index-contract.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import type { LocalizationLine } from "./localization-schema.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import type { SimilarKeys } from "./related-lines.js";
import {
	type ReferenceLine,
	referenceSimilarKeyChanges,
	similarKeysCorpus
} from "./similar-keys-reference.test-support.js";
import { textFileKey } from "./text-origin.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

describe.skipIf(!executable)("similar keys through related", () => {
	it("pairs exactly the keys the reference matcher pairs, on a seeded random target", async () => {
		if (!executable) throw new Error("Native reader required");
		const corpus = similarKeysCorpus({
			seed: 20261106,
			earlier: 1500,
			fresh: 1500,
			packages: Array.from({ length: 60 }, (_, index) => `Content/Text/P${index}.uasset`)
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					yield* Effect.promise(async () => {
						const root = fixture.projectRoot;
						await writeFile(join(root, "Review.manifest"), corpus.manifest);
						await writeFile(join(root, "en.archive"), corpus.archive("en"));
						await writeFile(join(root, "de.archive"), corpus.archive("de"));
						for (const culture of ["en", "de"])
							await writeFile(join(root, `${culture}.po`), 'msgid ""\nmsgstr ""\n');
					});
					fixture.update([]);
					fixture.addPackages(corpus.packages);
					yield* Effect.gen(function* () {
						const indexes = yield* GameTextIndexRefresh;
						const model = yield* indexes.refresh(fixture.request);
						const lines = yield* model.query.readLocalizationLines();
						const inState = (line: LocalizationLine, state: string) =>
							line.cultures.some((mark) => mark.state === state);
						// The reference's inputs, chosen as a host chooses them: earlier lines are
						// gathered evidence `not_found`, new lines saved `not_gathered`, and neither
						// has a key change. Packages: an earlier line's manifest files, a new line's
						// saved packages.
						const olds: ReferenceLine[] = lines
							.filter(
								(line) =>
									line.origin.kind === "evidence" &&
									inState(line, "not_found") &&
									line.keyChange === undefined
							)
							.map((line) => ({
								id: line.id,
								identity: line.identity,
								source: line.source,
								packages: line.manifest.map((entry) => textFileKey(entry.path))
							}));
						const news: ReferenceLine[] = lines
							.filter(
								(line) =>
									line.origin.kind === "corpus" &&
									inState(line, "not_gathered") &&
									line.keyChange === undefined
							)
							.map((line) => ({
								id: line.id,
								identity: line.identity,
								source: line.source,
								packages: (
									corpus.packagesOf.get(line.identity?.key ?? "") ?? []
								).map((path) => textFileKey(path))
							}));
						const exact = lines.filter((line) => line.keyChange !== undefined).length;
						expect(olds.length).toBeGreaterThan(1000);
						expect(news.length).toBeGreaterThan(1000);
						// Some keys keep their exact text: the join pairs those, and this tier
						// leaves them alone.
						expect(exact).toBeGreaterThan(0);
						const reference = referenceSimilarKeyChanges(olds, news);
						expect(reference.truncated).toBe(false);
						expect(reference.pairs.length).toBeGreaterThan(300);
						const expected = new Map<string, { other: string; distance: number }>();
						for (const pair of reference.pairs) {
							expected.set(pair.to.id, {
								other: pair.from.id,
								distance: pair.distance
							});
							expected.set(pair.from.id, {
								other: pair.to.id,
								distance: pair.distance
							});
						}
						const compared = new Set([...olds, ...news].map((line) => line.id));
						const actual = new Map<string, { other: string; distance: number }>();
						let answers = 0;
						const scopes = new Set<string>();
						let first: SimilarKeys | undefined;
						for (const line of lines) {
							if (!inState(line, "not_found") && !inState(line, "not_gathered"))
								continue;
							const related = yield* model.query.related({
								target: fixture.target.name,
								selection: { kind: "line", id: line.id },
								pageSize: 1,
								similarKeys: { limit: 5 }
							});
							const similar = related?.similarKeys;
							if (similar === undefined)
								throw new Error(`No similar keys for ${line.id}.`);
							first ??= similar;
							answers++;
							expect(similar.pairs).toBe(reference.pairs.length);
							expect(similar.truncated).toBe(false);
							// Trivial text drops a line from both sides; the reference drops it too.
							if (similar.state === undefined) {
								expect(similar.pair).toBeUndefined();
								continue;
							}
							expect(compared.has(line.id)).toBe(true);
							expect(similar.state).toBe(
								line.origin.kind === "evidence" ? "not_found" : "not_gathered"
							);
							if (similar.pair !== undefined) {
								scopes.add(similar.pair.scope);
								actual.set(line.id, {
									other: similar.pair.line.id,
									distance: similar.pair.distance
								});
								// A new line's nearest candidate is its pair. An earlier line may be
								// nearer to a new line that tied with another earlier line.
								const nearest = similar.candidates[0]?.distance ?? Infinity;
								if (similar.state === "not_gathered")
									expect(nearest).toBe(similar.pair.distance);
								else expect(nearest).toBeLessThanOrEqual(similar.pair.distance);
							}
						}
						expect(answers).toBeGreaterThan(2000);
						expect([...scopes].toSorted()).toEqual(["cross_package", "same_package"]);
						expect(first?.buildMs).toBeGreaterThan(0);
						expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));

						// A pair as the host shows it: the earlier key, its translations, and how
						// it was found.
						const sample = reference.pairs[0];
						const selected = lines.find((line) => line.id === sample?.to.id);
						if (sample === undefined || selected === undefined)
							throw new Error("No reference pair.");
						const shown = yield* model.query.related({
							target: fixture.target.name,
							selection: { kind: "line", id: selected.id },
							pageSize: 1,
							similarKeys: { limit: 5 }
						});
						expect(shown?.similarKeys?.pair).toMatchObject({
							line: {
								id: sample.from.id,
								namespace: "UI",
								key: sample.from.identity?.key,
								source: sample.from.source,
								state: "not_found"
							},
							distance: sample.distance,
							translations: [
								{ culture: "de", translation: `DE ${sample.from.source}` }
							]
						});
						expect(["same_package", "cross_package"]).toContain(
							shown?.similarKeys?.pair?.scope
						);
						expect(shown?.similarKeys?.buildMs).toBe(0);
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
	}, 300_000);
});
