import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { LocalizationEvidence, LocalizationTarget } from "@ue-shed/localization";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { target } from "./localization.test-support.js";
import { localizationResourceSourceHash } from "./localization.js";
import { localizationShippedTranslation } from "./localization-shipped-translation.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import {
	GameTextIndexSource,
	GameTextIndexRefresh,
	gameTextIndexRefreshLayer
} from "./index-refresh.js";
import { LocalizationSelectionObserved } from "./localization-import.js";
import { LocalizationReviewFile } from "@ue-shed/localization";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
import type { LocalizationQualityReport } from "./localization-quality-schema.js";

const decodeLocalizationTarget = Schema.decodeSync(LocalizationTarget);
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

/** A version 3 `.locres` with one namespace, as `FTextLocalizationResource::SaveToArchive` writes. */
function locres(namespace: string, entries: readonly (readonly [string, string, string])[]) {
	const bytes: number[] = [];
	const u32 = (value: number) => {
		const view = new DataView(new ArrayBuffer(4));
		view.setUint32(0, value >>> 0, true);
		bytes.push(...new Uint8Array(view.buffer));
	};
	const string = (value: string) => {
		u32(-(value.length + 1));
		for (let index = 0; index < value.length; index++) {
			const unit = value.charCodeAt(index);
			bytes.push(unit & 0xff, unit >>> 8);
		}
		bytes.push(0, 0);
	};
	bytes.push(
		...[0x0e, 0x14, 0x74, 0x75, 0x67, 0x4a, 0x03, 0xfc, 0x4a, 0x15, 0x90, 0x9d, 0xc3, 0x37],
		...[0x7f, 0x1b, 3]
	);
	const offsetAt = bytes.length;
	bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
	u32(entries.length);
	u32(1);
	u32(0);
	string(namespace);
	u32(entries.length);
	for (const [index, [key, source]] of entries.entries()) {
		u32(0);
		string(key);
		u32(localizationResourceSourceHash(source));
		u32(index);
	}
	const offset = bytes.length;
	for (let byte = 0; byte < 8; byte++)
		bytes[offsetAt + byte] = byte < 4 ? (offset >>> (byte * 8)) & 0xff : 0;
	u32(entries.length);
	for (const [, , text] of entries) {
		string(text);
		u32(1);
	}
	return Uint8Array.from(bytes);
}

describe.skipIf(!executable)("a culture with only a compiled resource", () => {
	it("shows the resource's translations with states against the saved source", async () => {
		if (!executable) throw new Error("The native reader is required.");
		const directory = await mkdtemp(join(tmpdir(), "ue-shed-locres-fallback-"));
		try {
			const projectRoot = await realpath(directory);
			// Shaped like a project with a Dashboard target and only its `id` resource.
			const resource = "Content/Localization/Game/id/Game.locres";
			const authored = decodeLocalizationTarget({
				...target,
				name: "Game",
				cultures: ["en", "id"],
				resourcesDiscovered: true,
				outputPaths: {
					manifest: null,
					archives: {},
					portableObjects: {},
					resources: { id: resource },
					locmeta: null,
					wordCount: null,
					conflicts: null
				}
			});
			await mkdir(dirname(join(projectRoot, resource)), { recursive: true });
			await writeFile(
				join(projectRoot, resource),
				locres("UI", [
					["Kills", "Kills", "Jumlah Bunuh"],
					["Time", "Old time", "Waktu Hidup"],
					["Same", "OK", "OK"]
				])
			);
			const path = "Content/Text/Table.uasset";
			const occurrence = (key: string, source: string) => ({
				source,
				dev_notes: "",
				identity: { status: "resolved" as const, namespace: "UI", key },
				location: {
					kind: "asset_property" as const,
					object_path: "/Game/Text/Table.Table",
					class_path: "/Script/Engine.DataAsset",
					property_path: key
				},
				edit_capability: "read_only" as const
			});
			const source = Layer.succeed(GameTextIndexSource, {
				inventory: () =>
					Effect.succeed([
						{
							path,
							signature: "one",
							headerData: {
								packageFlags: 0x40000,
								gatherableTextDataCount: 0,
								gatherableTextDataOffset: 0,
								hasTextProperty: false
							}
						}
					]),
				read: () =>
					Stream.succeed({
						...emptyPackageTextRecord(path),
						occurrences: [
							occurrence("Kills", "Kills"),
							occurrence("Time", "Time alive"),
							occurrence("Same", "OK"),
							occurrence("Missing", "Not compiled")
						]
					})
			});
			const evidence = Layer.succeed(LocalizationEvidence, {
				discover: () =>
					Effect.succeed({ schemaVersion: 1, targets: [authored], diagnostics: [] }),
				read: () => Effect.die("Index refresh reads no localization files as objects."),
				targets: () => Effect.die("Index refresh discovers target configuration directly.")
			});
			const lines = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const refresh = yield* GameTextIndexRefresh;
						const result = yield* refresh.refresh({
							projectRoot,
							targetName: authored.name
						});
						return yield* result.query.readLocalizationLines;
					})
				).pipe(
					Effect.provide(
						gameTextIndexRefreshLayer(join(projectRoot, "cache"), {}).pipe(
							Layer.provide(source),
							Layer.provide(
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30_000,
									catalogTimeoutMs: 120_000
								})
							),
							Layer.provide(evidence)
						)
					)
				)
			);
			const indonesian = (key: string) => {
				const line = lines.find((item) => item.identity?.key === key);
				const culture = line?.cultures.find((item) => item.culture === "id");
				if (!culture) throw new Error(`No Indonesian state for ${key}.`);
				return culture;
			};
			expect(indonesian("Kills").state).toBe("translated");
			expect(localizationShippedTranslation(indonesian("Kills"))).toEqual({
				origin: "locres",
				value: "Jumlah Bunuh"
			});
			expect(indonesian("Kills").unknownReasons).toContain("missing_manifest");
			expect(indonesian("Time").state).toBe("needs_update");
			expect(indonesian("Time").locres?.text).toBe("Waktu Hidup");
			expect(indonesian("Same").state).toBe("not_translated");
			expect(indonesian("Missing").state).toBe("unknown");
			expect(indonesian("Missing").locres).toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("follows a culture between its resource and its archive through scoped refreshes", async () => {
		if (!executable) throw new Error("The native reader is required.");
		const directory = await mkdtemp(join(tmpdir(), "ue-shed-locres-switch-"));
		try {
			const projectRoot = await realpath(directory);
			const resource = "Content/Localization/Game/de/Game.locres";
			const archive = "Content/Localization/Game/de/Game.archive";
			const authored = decodeLocalizationTarget({
				...target,
				name: "Game",
				cultures: ["en", "de"],
				outputPaths: {
					manifest: null,
					archives: { de: archive },
					portableObjects: {},
					resources: { de: resource },
					locmeta: null,
					wordCount: null,
					conflicts: null
				}
			});
			const writeResource = (text: string) =>
				writeFile(join(projectRoot, resource), locres("UI", [["Kills", "Kills", text]]));
			const writeArchive = () =>
				writeFile(
					join(projectRoot, archive),
					JSON.stringify({
						FormatVersion: 2,
						Namespace: "",
						Subnamespaces: [
							{
								Namespace: "UI",
								Children: [
									{
										Source: { Text: "Kills" },
										Translation: { Text: "Archiv" },
										Key: "Kills"
									}
								]
							}
						]
					})
				);
			await mkdir(dirname(join(projectRoot, resource)), { recursive: true });
			await writeResource("Erste");
			const path = "Content/Text/Table.uasset";
			const source = Layer.succeed(GameTextIndexSource, {
				inventory: () =>
					Effect.succeed([
						{
							path,
							signature: "one",
							headerData: {
								packageFlags: 0x40000,
								gatherableTextDataCount: 0,
								gatherableTextDataOffset: 0,
								hasTextProperty: false
							}
						}
					]),
				read: () =>
					Stream.succeed({
						...emptyPackageTextRecord(path),
						occurrences: [
							{
								source: "Kills",
								dev_notes: "",
								identity: {
									status: "resolved" as const,
									namespace: "UI",
									key: "Kills"
								},
								location: {
									kind: "asset_property" as const,
									object_path: "/Game/Text/Table.Table",
									class_path: "/Script/Engine.DataAsset",
									property_path: "Kills"
								},
								edit_capability: "read_only" as const
							}
						]
					})
			});
			const evidence = Layer.succeed(LocalizationEvidence, {
				discover: () =>
					Effect.succeed({ schemaVersion: 1, targets: [authored], diagnostics: [] }),
				read: () => Effect.die("Index refresh reads no localization files as objects."),
				targets: () => Effect.die("Index refresh discovers target configuration directly.")
			});
			const german = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const refresh = yield* GameTextIndexRefresh;
						const state = (changedFiles?: readonly string[]) =>
							refresh
								.refresh({
									projectRoot,
									targetName: authored.name,
									...(changedFiles === undefined ? undefined : { changedFiles })
								})
								.pipe(
									Effect.flatMap((result) => result.query.readLocalizationLines),
									Effect.map((lines) => {
										const culture = lines
											.find((line) => line.identity?.key === "Kills")
											?.cultures.find((item) => item.culture === "de");
										if (!culture) throw new Error("No German state.");
										return localizationShippedTranslation(culture);
									})
								);
						const states = [yield* state()];
						// The archive appears: it takes precedence over the resource.
						yield* Effect.promise(writeArchive);
						states.push(yield* state([archive]));
						// A later scoped refresh must not see the retired resource as superseded.
						states.push(yield* state([]));
						// The resource is recompiled, then the archive is removed: only the archive is
						// named, yet the culture now reads the new resource.
						yield* Effect.promise(() => writeResource("Zweite"));
						yield* Effect.promise(() => rm(join(projectRoot, archive)));
						states.push(yield* state([archive]));
						return states;
					})
				).pipe(
					Effect.provide(
						gameTextIndexRefreshLayer(join(projectRoot, "cache"), {}).pipe(
							Layer.provide(source),
							Layer.provide(
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30_000,
									catalogTimeoutMs: 120_000
								})
							),
							Layer.provide(evidence)
						)
					)
				)
			);
			expect(german).toEqual([
				{ origin: "locres", value: "Erste" },
				{ origin: "archive", value: "Archiv" },
				{ origin: "archive", value: "Archiv" },
				{ origin: "locres", value: "Zweite" }
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reads the resource when the archive disappears after the inputs were chosen", async () => {
		if (!executable) throw new Error("The native reader is required.");
		const directory = await mkdtemp(join(tmpdir(), "ue-shed-locres-race-"));
		try {
			const projectRoot = await realpath(directory);
			const resource = "Content/Localization/Game/de/Game.locres";
			const archive = "Content/Localization/Game/de/Game.archive";
			const authored = decodeLocalizationTarget({
				...target,
				name: "Game",
				cultures: ["en", "de"],
				outputPaths: {
					manifest: null,
					archives: { de: archive },
					portableObjects: {},
					resources: { de: resource },
					locmeta: null,
					wordCount: null,
					conflicts: null
				}
			});
			const writeResource = (text: string) =>
				writeFile(join(projectRoot, resource), locres("UI", [["Kills", "Kills", text]]));
			const writeArchive = () =>
				writeFile(
					join(projectRoot, archive),
					JSON.stringify({
						FormatVersion: 2,
						Namespace: "",
						Subnamespaces: [
							{
								Namespace: "UI",
								Children: [
									{
										Source: { Text: "Kills" },
										Translation: { Text: "Archiv" },
										Key: "Kills"
									}
								]
							}
						]
					})
				);
			const removeArchive = () =>
				rm(join(projectRoot, archive), { recursive: true, force: true });
			await mkdir(dirname(join(projectRoot, resource)), { recursive: true });
			const path = "Content/Text/Table.uasset";
			const source = Layer.succeed(GameTextIndexSource, {
				inventory: () =>
					Effect.succeed([
						{
							path,
							signature: "one",
							headerData: {
								packageFlags: 0x40000,
								gatherableTextDataCount: 0,
								gatherableTextDataOffset: 0,
								hasTextProperty: false
							}
						}
					]),
				read: () =>
					Stream.succeed({
						...emptyPackageTextRecord(path),
						occurrences: [
							{
								source: "Kills",
								dev_notes: "",
								identity: {
									status: "resolved" as const,
									namespace: "UI",
									key: "Kills"
								},
								location: {
									kind: "asset_property" as const,
									object_path: "/Game/Text/Table.Table",
									class_path: "/Script/Engine.DataAsset",
									property_path: "Kills"
								},
								edit_capability: "read_only" as const
							}
						]
					})
			});
			const evidence = Layer.succeed(LocalizationEvidence, {
				discover: () =>
					Effect.succeed({ schemaVersion: 1, targets: [authored], diagnostics: [] }),
				read: () => Effect.die("Index refresh reads no localization files as objects."),
				targets: () => Effect.die("Index refresh discovers target configuration directly.")
			});
			const german = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const refresh = yield* GameTextIndexRefresh;
						// One refresh; `between` runs after its inputs are chosen, before they are read.
						const state = (
							changedFiles: readonly string[] | undefined,
							between?: () => Promise<unknown>
						) =>
							refresh
								.refresh({
									projectRoot,
									targetName: authored.name,
									...(changedFiles === undefined ? undefined : { changedFiles })
								})
								.pipe(
									Effect.flatMap((result) => result.query.readLocalizationLines),
									Effect.map((lines) => {
										const culture = lines
											.find((line) => line.identity?.key === "Kills")
											?.cultures.find((item) => item.culture === "de");
										return culture === undefined
											? null
											: (localizationShippedTranslation(culture) ?? null);
									}),
									Effect.provideService(LocalizationSelectionObserved, () =>
										between === undefined
											? Effect.void
											: Effect.promise(between)
									)
								);
						const states = [];
						// Cold: the archive is there when the inputs are chosen, gone when it is read.
						yield* Effect.promise(() => writeResource("Erste"));
						yield* Effect.promise(writeArchive);
						states.push(yield* state(undefined, removeArchive));
						// Warm, full refresh: an older resource layer must not stand in for the new file.
						yield* Effect.promise(writeArchive);
						states.push(yield* state([archive]));
						yield* Effect.promise(() => writeResource("Zweite"));
						states.push(yield* state(undefined, removeArchive));
						// Warm, scoped refresh naming only the archive.
						yield* Effect.promise(writeArchive);
						states.push(yield* state([archive]));
						yield* Effect.promise(() => writeResource("Dritte"));
						states.push(yield* state([archive], removeArchive));
						// Control: an archive that is present but unreadable keeps its culture.
						yield* Effect.promise(() => writeResource("Vierte"));
						states.push(
							yield* state(undefined, async () => {
								await removeArchive();
								await mkdir(join(projectRoot, archive), { recursive: true });
							})
						);
						return states;
					})
				).pipe(
					Effect.provide(
						gameTextIndexRefreshLayer(join(projectRoot, "cache"), {}).pipe(
							Layer.provide(source),
							Layer.provide(
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30_000,
									catalogTimeoutMs: 120_000
								})
							),
							Layer.provide(evidence)
						)
					)
				)
			);
			expect(german.slice(0, 5)).toEqual([
				{ origin: "locres", value: "Erste" },
				{ origin: "archive", value: "Archiv" },
				{ origin: "locres", value: "Zweite" },
				{ origin: "archive", value: "Archiv" },
				{ origin: "locres", value: "Dritte" }
			]);
			expect(german[5]).not.toEqual({ origin: "locres", value: "Vierte" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps a finding accepted against a resource's translation hidden", async () => {
		if (!executable) throw new Error("The native reader is required.");
		const directory = await mkdtemp(join(tmpdir(), "ue-shed-locres-accept-"));
		try {
			const projectRoot = await realpath(directory);
			const resource = "Content/Localization/Game/de/Game.locres";
			const manifest = "Content/Localization/Game/Game.manifest";
			const authored = decodeLocalizationTarget({
				...target,
				name: "Game",
				cultures: ["en", "de"],
				outputPaths: {
					manifest,
					archives: {},
					portableObjects: {},
					resources: { de: resource },
					locmeta: null,
					wordCount: null,
					conflicts: null
				}
			});
			// A trailing space the compiled translation lost: a whitespace finding on German.
			const source = "Ready ";
			const writeResource = (text: string) =>
				writeFile(join(projectRoot, resource), locres("UI", [["Ready", source, text]]));
			await mkdir(dirname(join(projectRoot, resource)), { recursive: true });
			await writeFile(
				join(projectRoot, manifest),
				JSON.stringify({
					FormatVersion: 1,
					Namespace: "UI",
					Children: [
						{
							Source: { Text: source },
							Keys: [{ Key: "Ready", Path: "/Game/Text/Table.Table.Ready" }]
						}
					]
				})
			);
			await writeResource("Bereit");
			const path = "Content/Text/Table.uasset";
			let signature = 0;
			const packages = Layer.succeed(GameTextIndexSource, {
				inventory: () =>
					Effect.succeed([
						{
							path,
							signature: String(signature),
							headerData: {
								packageFlags: 0x40000,
								gatherableTextDataCount: 0,
								gatherableTextDataOffset: 0,
								hasTextProperty: false
							}
						}
					]),
				read: () =>
					Stream.succeed({
						...emptyPackageTextRecord(path),
						occurrences: [
							{
								source,
								dev_notes: "",
								identity: {
									status: "resolved" as const,
									namespace: "UI",
									key: "Ready"
								},
								location: {
									kind: "asset_property" as const,
									object_path: "/Game/Text/Table.Table",
									class_path: "/Script/Engine.DataAsset",
									property_path: "Ready"
								},
								edit_capability: "read_only" as const
							}
						]
					})
			});
			const evidence = Layer.succeed(LocalizationEvidence, {
				discover: () =>
					Effect.succeed({ schemaVersion: 1, targets: [authored], diagnostics: [] }),
				read: () => Effect.die("Index refresh reads no localization files as objects."),
				targets: () => Effect.die("Index refresh discovers target configuration directly.")
			});
			const outcome = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const refresh = yield* GameTextIndexRefresh;
						const opened = () =>
							refresh.refresh({ projectRoot, targetName: authored.name });
						let result = yield* opened();
						// The rules that found something on the line in German.
						const german = (findings: LocalizationQualityReport["findings"]) =>
							findings.flatMap((finding) =>
								"culture" in finding &&
								finding.culture === "de" &&
								JSON.stringify(finding.identity).includes('"Ready"')
									? [finding.ruleId]
									: []
							);
						const found = german(
							(yield* result.localizationCheck(STARTER_CHECK_RULES, {})).findings
						);
						// The fingerprint a review writes, as the host reads it for an accept.
						const [line] = yield* result.query.reviewLines({
							target: authored.name,
							culture: "de",
							identities: [{ namespace: "UI", key: "Ready" }]
						});
						if (line?.status !== "found") throw new Error("The line was not gathered.");
						const review = yield* Schema.decodeUnknownEffect(LocalizationReviewFile)({
							schemaVersion: 1,
							target: authored.name,
							records: [],
							acceptedFindings: found.map((ruleId) => ({
								check: ruleId,
								culture: "de",
								namespace: "UI",
								key: "Ready",
								fingerprint: line.fingerprint,
								by: "Reviewer",
								at: "2026-11-10T00:00:00Z"
							}))
						}).pipe(Effect.orDie);
						const reviewed = () =>
							result.localizationCheck(STARTER_CHECK_RULES, { review });
						const accepted = yield* reviewed();
						// The compiled translation changes: the acceptance no longer holds.
						yield* Effect.promise(() => writeResource("Fertig"));
						signature++;
						result = yield* opened();
						const changed = yield* reviewed();
						return {
							translation: line.translation,
							found: found.length,
							acceptedVisible: german(accepted.findings).length,
							acceptedCount: accepted.acceptedFindings,
							changedVisible: german(changed.findings).length
						};
					})
				).pipe(
					Effect.provide(
						gameTextIndexRefreshLayer(join(projectRoot, "cache"), {}).pipe(
							Layer.provide(packages),
							Layer.provide(
								nativeIndexBuilderLayer({
									executable,
									timeoutMs: 30_000,
									catalogTimeoutMs: 120_000
								})
							),
							Layer.provide(evidence)
						)
					)
				)
			);
			expect(outcome.translation).toBe("Bereit");
			expect(outcome.found).toBeGreaterThan(0);
			expect(outcome).toEqual({
				translation: "Bereit",
				found: outcome.found,
				acceptedVisible: 0,
				acceptedCount: outcome.found,
				changedVisible: outcome.found
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
