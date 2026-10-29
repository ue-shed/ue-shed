import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { AssetReader, AssetReaderLive } from "@ue-shed/unreal-assets";
import { LocalizationTargetName } from "@ue-shed/localization";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, expectTypeOf } from "vitest";
import { typeScriptIndexBuilderLayer } from "./index-builder-reference.test-support.js";
import { nativeIndexQueryLayer } from "./index-query-native.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { gameTextIndexStepsLayer } from "./index-steps.js";
import type { TextCorpusSearchRequest, TextCorpusSearchResult } from "./schema.js";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
import { makeGameTextWorkspace, type GameTextWorkspaceApi } from "./workspace.js";
import {
	GameTextWorkspaceContract,
	type GameTextWorkspaceContractEntry,
	type GameTextWorkspaceContractMismatch
} from "./workspace-contract.js";
import type { GameTextWorkspaceFileHooks } from "./workspace-host.js";

/** Files kept in memory; dialogs are cancelled, as a headless host answers them. */
function memoryFiles(): GameTextWorkspaceFileHooks {
	const contents = new Map<string, Uint8Array>();
	const read = (path: string) =>
		Effect.suspend(() => {
			const bytes = contents.get(path);
			return bytes === undefined
				? Effect.fail({ message: "Missing file.", recovery: "Create it." })
				: Effect.succeed(bytes);
		});
	return {
		chooseFile: () => Effect.succeed({ status: "cancelled" }),
		chooseSaveFile: () => Effect.succeed({ status: "cancelled" }),
		readFile: read,
		readFileWithin: (root, path) => read(resolve(root, path)),
		writeFile: (path, bytes) => Effect.sync(() => void contents.set(path, bytes))
	};
}

/** A JSON transport: values cross it as text, as an IPC or WebSocket host sends them. */
const overJson = <A>(value: A): A => JSON.parse(JSON.stringify(value));

describe("GameTextWorkspaceContract", () => {
	it("matches GameTextWorkspaceApi, and fails to compile when either changes alone", () => {
		expectTypeOf<
			GameTextWorkspaceContractMismatch<GameTextWorkspaceApi>
		>().toEqualTypeOf<never>();
		// A method with no entry.
		expectTypeOf<
			GameTextWorkspaceContractMismatch<
				GameTextWorkspaceApi & { readonly renameTarget: () => Effect.Effect<void> }
			>
		>().toEqualTypeOf<"renameTarget">();
		// An entry with no method.
		expectTypeOf<
			GameTextWorkspaceContractMismatch<Omit<GameTextWorkspaceApi, "related">>
		>().toEqualTypeOf<"related">();
		// A parameter, a success and a stream element that differ from their entries.
		expectTypeOf<
			GameTextWorkspaceContractMismatch<
				Omit<GameTextWorkspaceApi, "search" | "progress" | "progressChanges"> & {
					readonly search: (
						request: TextCorpusSearchRequest,
						pageSize: number
					) => Effect.Effect<TextCorpusSearchResult>;
					readonly progress: () => Effect.Effect<{ readonly phase: "idle" }>;
					readonly progressChanges: () => Stream.Stream<number>;
				}
			>
		>().toEqualTypeOf<"search" | "progress" | "progressChanges">();
		// A typed error the entry does not declare.
		expectTypeOf<
			GameTextWorkspaceContractMismatch<
				Omit<GameTextWorkspaceApi, "localizationTargets"> & {
					readonly localizationTargets: () => Effect.Effect<
						Effect.Success<ReturnType<GameTextWorkspaceApi["localizationTargets"]>>,
						Error
					>;
				}
			>
		>().toEqualTypeOf<"localizationTargets">();
		// Host-only methods stay out of it.
		expectTypeOf<
			GameTextWorkspaceContractMismatch<Omit<GameTextWorkspaceApi, "beginOperation">>
		>().toEqualTypeOf<never>();
	});

	it.live(
		"carries every method's params and result over JSON, served from a real workspace",
		() =>
			Effect.gen(function* () {
				const fixture = yield* makeIndexRegressionFixture();
				const nativeQuery = Layer.unwrap(
					Effect.flatMap(AssetReader, (reader) => reader.configuration()).pipe(
						Effect.map(nativeIndexQueryLayer),
						Effect.provide(AssetReaderLive),
						Effect.orDie
					)
				);
				const layer = Layer.mergeAll(
					gameTextIndexStepsLayer(join(fixture.projectRoot, "cache")).pipe(
						Layer.provide(fixture.source),
						Layer.provide(fixture.evidence),
						Layer.provide(typeScriptIndexBuilderLayer),
						Layer.provide(nativeQuery)
					),
					fixture.evidence
				);
				const ready = {
					status: "ready" as const,
					project: { projectRoot: fixture.projectRoot, generation: 3 }
				};
				yield* Effect.gen(function* () {
					const workspace = yield* makeGameTextWorkspace({
						project: {
							current: () => Effect.succeed(ready),
							refresh: () => Effect.succeed(ready),
							candidates: () =>
								Effect.succeed({
									generation: 3,
									summary: { projectRoot: fixture.projectRoot }
								}),
							progress: () =>
								Effect.succeed({ completed: 0, total: 0, phase: "idle" })
						},
						files: memoryFiles()
					});
					const served = new Set<GameTextWorkspaceContractEntry>();
					/** Serves one method as a host does: decode its params, call it, encode its result. */
					const serve = <A, I, B, J>(
						entry: {
							readonly params: Schema.Codec<A, I>;
							readonly success: Schema.Codec<B, J>;
						},
						method: (params: NoInfer<A>) => Effect.Effect<NoInfer<B>>,
						params: NoInfer<I>
					) =>
						Effect.gen(function* () {
							const decoded = yield* Schema.decodeEffect(entry.params)(
								overJson(params)
							);
							expect(
								overJson(yield* Schema.encodeEffect(entry.params)(decoded))
							).toEqual(overJson(params));
							const result = yield* method(decoded);
							const wire = overJson(
								yield* Schema.encodeEffect(entry.success)(result)
							);
							expect(yield* Schema.decodeEffect(entry.success)(wire)).toEqual(result);
							served.add(entry);
							return result;
						});

					expect(
						(yield* serve(
							GameTextWorkspaceContract.configuredRefresh,
							workspace.configuredRefresh,
							{}
						)).status
					).toBe("completed");
					expect(
						(yield* serve(GameTextWorkspaceContract.progress, workspace.progress, {}))
							.phase
					).toBe("idle");
					const [first] = yield* Stream.runCollect(
						workspace.progressChanges().pipe(Stream.take(1))
					);
					expect(
						yield* Schema.decodeUnknownEffect(
							GameTextWorkspaceContract.progressChanges.events
						)(
							overJson(
								yield* Schema.encodeUnknownEffect(
									GameTextWorkspaceContract.progressChanges.events
								)(first)
							)
						)
					).toEqual(first);

					const search = { capability: "all", pageSize: 10, query: "" } as const;
					const found = yield* serve(
						GameTextWorkspaceContract.search,
						workspace.search,
						search
					);
					expect(found.status).toBe("ready");
					const unit = found.status === "ready" ? found.page.units[0] : undefined;
					expect(unit).toBeDefined();
					const id = unit!.id;
					yield* serve(
						GameTextWorkspaceContract.searchRows,
						workspace.searchRows,
						search
					);
					yield* serve(GameTextWorkspaceContract.focus, workspace.focus, {
						id,
						pageSize: 10
					});
					yield* serve(GameTextWorkspaceContract.related, workspace.related, {
						selection: { kind: "unit", id },
						pageSize: 10
					});

					expect(
						(yield* serve(
							GameTextWorkspaceContract.createStarterRules,
							workspace.createStarterRules,
							{ loadExisting: false }
						)).status
					).toBe("completed");
					yield* serve(
						GameTextWorkspaceContract.reloadQualityRules,
						workspace.reloadQualityRules,
						{}
					);
					yield* serve(
						GameTextWorkspaceContract.chooseQualityRules,
						workspace.chooseQualityRules,
						{}
					);
					yield* serve(
						GameTextWorkspaceContract.previewQualityRules,
						workspace.previewQualityRules,
						STARTER_CHECK_RULES
					);
					yield* serve(
						GameTextWorkspaceContract.saveQualityRules,
						workspace.saveQualityRules,
						STARTER_CHECK_RULES
					);
					const findings = yield* serve(
						GameTextWorkspaceContract.qualitySearch,
						workspace.qualitySearch,
						{ filter: "all", pageSize: 50 }
					);
					expect(findings.status).toBe("ready");
					const finding =
						findings.status === "ready" ? findings.page.findings[0] : undefined;
					if (finding)
						yield* serve(
							GameTextWorkspaceContract.qualityFocus,
							workspace.qualityFocus,
							{ id: finding.id, pageSize: 10 }
						);

					const target = LocalizationTargetName.make("Review");
					expect(
						(yield* serve(
							GameTextWorkspaceContract.localizationTargets,
							workspace.localizationTargets,
							{}
						)).status
					).toBe("ready");
					expect(
						(yield* serve(
							GameTextWorkspaceContract.localizationTarget,
							workspace.localizationTarget,
							target
						)).status
					).toBe("ready");
					const quality = { target, filter: "all", offset: 0 } as const;
					const checked = yield* serve(
						GameTextWorkspaceContract.localizationQualitySearch,
						workspace.localizationQualitySearch,
						quality
					);
					expect(checked.status).toBe("ready");
					const translation =
						checked.status === "ready" ? checked.page.findings[0] : undefined;
					if (translation)
						yield* serve(
							GameTextWorkspaceContract.localizationQualityFocus,
							workspace.localizationQualityFocus,
							{
								target,
								id: translation.id,
								occurrenceOffset: 0,
								poContextOffset: 0
							}
						);
					yield* serve(
						GameTextWorkspaceContract.localizationChanges,
						workspace.localizationChanges,
						quality
					);
					// A host with no change reads says so, rather than failing the request.
					expect(
						yield* serve(
							GameTextWorkspaceContract.compareChange,
							workspace.compareChange,
							{
								change: { kind: "submitted", change: 1200 },
								target: "Review",
								changes: { offset: 0, limit: 50 },
								findings: { offset: 0, limit: 50 }
							}
						)
					).toMatchObject({ status: "failed", code: "capability_missing" });
					// A headless host cancels the file dialog, and files nobody chose are not read.
					expect(
						yield* serve(
							GameTextWorkspaceContract.chooseLocalizationFile,
							workspace.chooseLocalizationFile,
							{ side: "before" }
						)
					).toEqual({ status: "cancelled" });
					expect(
						yield* serve(
							GameTextWorkspaceContract.compareLocalizationFiles,
							workspace.compareLocalizationFiles,
							{
								files: { before: "C:/old/Game.po", after: "C:/new/Game.po" },
								filter: { groups: ["added"], query: "", asset: "", preview: 0 },
								changes: { offset: 0, limit: 50 }
							}
						)
					).toMatchObject({ status: "failed", code: "file_not_chosen" });
					const lines = yield* serve(GameTextWorkspaceContract.search, workspace.search, {
						...search,
						localization: { target, cultures: ["de"] }
					});
					const line =
						lines.status === "ready" ? lines.page.localization?.lines[0] : undefined;
					expect(line).toBeDefined();
					yield* serve(
						GameTextWorkspaceContract.localizationFocus,
						workspace.localizationFocus,
						{
							target,
							selection: { kind: "line", id: line!.id }
						}
					);
					const edit = { culture: "de", namespace: "UI", key: "K" } as const;
					yield* serve(
						GameTextWorkspaceContract.localizationEdits,
						workspace.localizationEdits,
						{
							target,
							mode: "review",
							edits: [
								{ ...edit, seenTranslation: "Shipped", translation: "Geliefert" }
							]
						}
					);
					yield* serve(
						GameTextWorkspaceContract.localizationReview,
						workspace.localizationReview,
						{
							target,
							changes: [{ kind: "set", ...edit, flags: ["reviewed"] }]
						}
					);
					yield* serve(
						GameTextWorkspaceContract.localizationReport,
						workspace.localizationReport,
						{ target, offset: 0 }
					);
					yield* serve(
						GameTextWorkspaceContract.localizationReportFile,
						workspace.localizationReportFile,
						{ target, operation: "export_csv" }
					);
					yield* serve(
						GameTextWorkspaceContract.localizationLinesFile,
						workspace.localizationLinesFile,
						{
							...search,
							localization: { target, cultures: ["de"] }
						}
					);

					const query = {
						mode: "corpus",
						query: "",
						capability: "all",
						qualityFilter: "all"
					} as const;
					yield* serve(
						GameTextWorkspaceContract.investigationExport,
						workspace.investigationExport,
						{ query, format: "json" }
					);
					yield* serve(
						GameTextWorkspaceContract.investigationSave,
						workspace.investigationSave,
						query
					);
					yield* serve(
						GameTextWorkspaceContract.investigationOpen,
						workspace.investigationOpen,
						{}
					);

					// The fixture's source text breaks no source rule, so no source finding has a focus.
					const unserved = new Set(["progressChanges", "qualityFocus"]);
					expect(
						Object.entries(GameTextWorkspaceContract)
							.filter(([name, entry]) => !unserved.has(name) && !served.has(entry))
							.map(([name]) => name)
					).toEqual([]);
				}).pipe(Effect.provide(layer));
			}).pipe(Effect.scoped),
		60_000
	);
});
