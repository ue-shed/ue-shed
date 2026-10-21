import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	LocalizationReviewFile,
	localizationReviewFingerprint,
	TextNamespace,
	TextKey
} from "@ue-shed/localization";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { GameTextIndexBuilder } from "./index-builder.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { openJoinedTarget, hydrateJoinedTarget } from "./joined-target-reader.js";
import { sharedIndexNodeLayer } from "./shared-index.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { target } from "./localization.test-support.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const files = [
	["Test.manifest", "manifest"],
	["de.archive", "archive"],
	["de.po", "po"]
] as const;

describe.skipIf(!executable)("native join current evidence", () => {
	for (const identity of ["UI\u{f0000}\u{f0001}\u{f0800}", "UI😀"]) {
		it(`preserves current failures, pinned readers and policy identity ${JSON.stringify(identity)}`, async () => {
			if (!executable) throw new Error("Native reader is required");
			const root = await mkdtemp(join(tmpdir(), "ue-shed-native-evidence-"));
			try {
				const projectRoot = join(root, "project");
				await mkdir(projectRoot);
				const source = "A stable source long enough for incremental localization updates.";
				const key = TextKey.make(`K${identity}`);
				const namespace = TextNamespace.make(identity);
				const authored = {
					...target,
					outputPaths: {
						...target.outputPaths,
						manifest: "Test.manifest",
						archives: { de: "de.archive" },
						portableObjects: { de: "de.po" }
					}
				};
				const valid = [
					JSON.stringify({
						FormatVersion: 1,
						Namespace: identity,
						Children: [
							{
								Source: { Text: source },
								Keys: [{ Key: key, Path: "/Game/Text/Example.Example.Label" }]
							}
						]
					}),
					JSON.stringify({
						FormatVersion: 2,
						Namespace: identity,
						Children: [
							{ Key: key, Source: { Text: source }, Translation: { Text: "Shipped" } }
						]
					}),
					`msgctxt ${JSON.stringify(`${identity},${key}`)}\nmsgid ${JSON.stringify(source)}\nmsgstr "Shipped"\n`
				];
				const review = Schema.decodeUnknownSync(LocalizationReviewFile)({
					schemaVersion: 1,
					target: authored.name,
					acceptedFindings: [],
					records: [
						{
							namespace,
							key,
							culture: "de",
							flags: ["reviewed"],
							fingerprint: localizationReviewFingerprint(source, "Shipped"),
							by: "Fixture",
							at: "2026-10-17T00:00:00Z"
						}
					]
				});
				const outputs = [];
				for (const backend of ["javascript", "native"] as const) {
					const configuration = {
						cacheRoot: join(root, backend),
						projectKey: projectRoot,
						targetKey: authored.name,
						projectView: { kind: "localization" as const, target: authored.name }
					};
					outputs.push(
						await Effect.runPromise(
							Effect.scoped(
								Effect.gen(function* () {
									const builder = yield* GameTextIndexBuilder;
									const snapshots = [];
									let pinned:
										| Effect.Success<ReturnType<typeof openJoinedTarget>>
										| undefined;
									let pinnedValue:
										| Effect.Success<ReturnType<typeof hydrateJoinedTarget>>
										| undefined;
									// Every repair republishes the current evidence; readers reopen between stages.
									for (const failed of [
										null,
										...files.map(([name]) => name),
										null
									]) {
										for (const [index, [name]] of files.entries())
											yield* Effect.promise(() =>
												writeFile(
													join(projectRoot, name),
													name === failed
														? "malformed localization file"
														: valid[index]!
												)
											);
										yield* builder.withSession(
											{ configuration },
											Effect.gen(function* () {
												const fileErrors: Record<string, string> = {};
												for (const [relativePath, format] of files) {
													const result = yield* Effect.result(
														builder.importLocalizationFile({
															projectRoot,
															cacheRoot: configuration.cacheRoot,
															relativePath,
															format,
															poFormat: "Unreal",
															sharedTargetKey: authored.name,
															projectScoped: true
														})
													);
													if (Result.isFailure(result)) {
														if (
															failed === null ||
															result.failure._tag !==
																"LocalizationError"
														)
															return yield* Effect.fail(
																result.failure
															);
														expect(relativePath).toBe(failed);
														fileErrors[relativePath] =
															result.failure._tag ===
															"LocalizationError"
																? result.failure.code
																: "invalid_schema";
													}
												}
												expect(Object.keys(fileErrors)).toEqual(
													failed ? [failed] : []
												);
												yield* builder.refreshPackageTextLayer({
													inventory: [
														{
															path: "Content/Text/Example.uasset",
															signature: "stable",
															headerData: {
																packageFlags: 0x40000,
																gatherableTextDataCount: 0,
																gatherableTextDataOffset: 0,
																hasTextProperty: false
															}
														}
													],
													read: () =>
														Stream.succeed({
															...emptyPackageTextRecord(
																"Content/Text/Example.uasset"
															),
															occurrences: [
																{
																	source,
																	dev_notes: "",
																	identity: {
																		status: "resolved",
																		namespace,
																		key
																	},
																	location: {
																		kind: "asset_property",
																		object_path:
																			"/Game/Text/Example.Example",
																		class_path:
																			"/Script/Engine.DataAsset",
																		property_path: "Label"
																	},
																	edit_capability: "read_only"
																}
															]
														})
												});
												yield* builder.refreshJoinedTarget({
													projectRoot,
													target: authored,
													fileErrors,
													review,
													keyChangePairs: [
														{
															from: {
																namespace,
																key: TextKey.make(
																	"Old\ud800x\udfff\u{f0001}"
																)
															},
															to: { namespace, key },
															match: "same_place",
															sourceChanged: false,
															previousSource: source,
															translations: []
														}
													]
												});
											})
										);
										const joined = yield* openJoinedTarget().pipe(
											Effect.provide(sharedIndexNodeLayer(configuration))
										);
										const value = yield* hydrateJoinedTarget(joined);
										expect(
											value.lines.find((line) => line.identity?.key === key)
												?.keyChange?.direction
										).toBe("to");
										if (!pinned) {
											pinned = joined;
											pinnedValue = value;
											expect(
												value.lines
													.find((line) => line.identity?.key === key)
													?.cultures.find((c) => c.culture === "de")
													?.review?.status
											).toBe("current");
										}
										expect(yield* hydrateJoinedTarget(pinned)).toEqual(
											pinnedValue
										);
										snapshots.push(value);
									}
									expect(snapshots.at(-1)).toEqual(snapshots[0]);
									return snapshots;
								})
							).pipe(
								Effect.provide(
									backend === "native"
										? nativeIndexBuilderLayer({
												executable,
												timeoutMs: 30_000,
												catalogTimeoutMs: 120_000
											})
										: typeScriptIndexBuilderLayer
								)
							)
						)
					);
				}
				expect(outputs[1]).toEqual(outputs[0]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}, 120_000);
	}
});
