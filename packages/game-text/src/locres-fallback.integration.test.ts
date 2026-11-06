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
});
