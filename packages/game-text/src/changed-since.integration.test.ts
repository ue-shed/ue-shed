import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameTextIndexRefresh } from "./index-contract.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

describe.skipIf(!executable)("a target's generation and what changed since one", () => {
	it("keeps the generation through an unchanged refresh and lists lines and packages changed after it", async () => {
		if (!executable) throw new Error("Native reader required");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const fixture = yield* makeIndexRegressionFixture();
					yield* Effect.gen(function* () {
						const indexes = yield* GameTextIndexRefresh;
						const first = yield* Effect.scoped(indexes.refresh(fixture.request));
						const since = first.generation;
						if (since === undefined) throw new Error("The refresh has no generation.");
						expect(since).toBe(first.join.key);

						// A refresh that changes nothing keeps the generation, and nothing changed.
						const unchanged = yield* Effect.scoped(
							Effect.gen(function* () {
								const model = yield* indexes.refresh(fixture.request);
								return {
									generation: model.generation,
									answer: yield* model.query.changedSince({
										since,
										kind: "lines",
										limit: 10
									})
								};
							})
						);
						expect(unchanged).toEqual({
							generation: since,
							answer: { status: "same" }
						});

						// German's PO entry changes, and a new package saves a new key.
						yield* Effect.promise(() =>
							writeFile(
								join(fixture.projectRoot, "de.po"),
								'msgctxt "UI,K"\nmsgid "Source"\nmsgstr "Geliefert"\n'
							)
						);
						fixture.addPackages([
							{
								path: "Content/Text/Added.uasset",
								occurrences: [
									{
										source: "Added",
										dev_notes: "",
										identity: {
											status: "resolved",
											namespace: "UI",
											key: "Added"
										},
										location: {
											kind: "asset_property",
											object_path: "/Game/Text/Added.Added",
											class_path: "/Script/Engine.DataAsset",
											property_path: "Label"
										},
										edit_capability: "read_only"
									}
								]
							}
						]);
						const changed = yield* Effect.scoped(
							Effect.gen(function* () {
								const model = yield* indexes.refresh(fixture.request);
								const read = (kind: "lines" | "packages", after?: string) =>
									model.query.changedSince({
										since,
										kind,
										limit: 1,
										...(after === undefined ? undefined : { after })
									});
								// Every page, a change at a time.
								const pages = (kind: "lines" | "packages") =>
									Effect.gen(function* () {
										const items = [];
										let after: string | undefined;
										do {
											const page = yield* read(kind, after);
											if (page.status !== "changes")
												throw new Error(
													`Expected changes, not ${page.status}.`
												);
											items.push(...page.items);
											after = page.nextCursor;
										} while (after !== undefined);
										return items;
									});
								return {
									generation: model.generation,
									lines: yield* pages("lines"),
									packages: yield* pages("packages"),
									unknown: yield* model.query.changedSince({
										since: "not a generation",
										kind: "lines",
										limit: 10
									})
								};
							})
						);
						expect(changed.generation).toBeDefined();
						expect(changed.generation).not.toBe(since);
						const target = fixture.target.name;
						expect(changed.lines).toEqual([
							{
								change: "added",
								id: `${target}:["UI","Added"]`,
								namespace: "UI",
								key: "Added"
							},
							{
								change: "changed",
								id: `${target}:["UI","K"]`,
								namespace: "UI",
								key: "K"
							}
						]);
						// The fixture's inventory gives every package one signature, so the saved
						// package changes with the new one.
						expect(changed.packages.map(({ change, id }) => [change, id])).toEqual([
							["added", join(fixture.projectRoot, "Content/Text/Added.uasset")],
							["changed", join(fixture.projectRoot, "Content/Text/Table.uasset")]
						]);
						expect(changed.unknown).toEqual({ status: "too_old", reason: "unknown" });
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
	}, 120_000);
});
