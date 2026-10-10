import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Result } from "effect";
import { expect } from "vitest";
import {
	parseArchive,
	parseManifest,
	parsePO,
	projectPOEvidence,
	defaultLocalizationLimits,
	type POParseOptions
} from "../packages/localization/dist/index.js";
import {
	importLocalizationFile,
	decodeLocalizationSnapshot,
	type LocalizationFileImportRequest
} from "../packages/game-text/src/localization-import.ts";
import { SnapshotStore, snapshotStoreNodeLayer } from "../packages/game-text/src/snapshot-store.ts";

/** Reusable parser oracle for any small committed or generated localization file. */
export async function expectLocalizationImportMatchesParser(
	request: LocalizationFileImportRequest
) {
	const path = resolve(request.projectRoot, request.relativePath);
	if ((await stat(path)).size > defaultLocalizationLimits.maxFileBytes)
		throw new Error("The parser oracle is only for bounded fixture/tiny-scale files.");
	const bytes = await readFile(path);
	const poOptions: POParseOptions = {};
	if (request.poFormat) Object.assign(poOptions, { format: request.poFormat });
	if (request.collapseMode) Object.assign(poOptions, { collapseMode: request.collapseMode });
	const expected =
		request.format === "manifest"
			? parseManifest(bytes)
			: request.format === "archive"
				? parseArchive(bytes)
				: parsePO(bytes, poOptions).pipe(Result.map(projectPOEvidence));
	if (expected._tag === "Failure") throw expected.failure;
	const imported = await Effect.runPromise(importLocalizationFile(request));
	const decoded = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const store = yield* SnapshotStore;
				const reader = yield* store.open();
				const entries: unknown[] = [];
				const ordinals: number[] = [];
				let start = 0;
				let count = 1;
				let meta;
				while (start < count) {
					const page = yield* decodeLocalizationSnapshot(reader, start, 50);
					meta = page;
					count = page.count;
					entries.push(...page.entries);
					ordinals.push(...page.ordinals);
					start += 50;
				}
				if (request.format === "po") {
					const order = ordinals
						.map((ordinal, index) => ({ ordinal, entry: entries[index] }))
						.sort((a, b) => a.ordinal - b.ordinal);
					return { entries: order.map((value) => value.entry), meta };
				}
				return { entries, meta };
			})
		).pipe(
			Effect.provide(
				snapshotStoreNodeLayer({
					cacheRoot: request.cacheRoot,
					projectKey: resolve(request.projectRoot),
					targetKey: `localization-file:${imported.key}`
				})
			)
		)
	);
	expect(decoded.entries).toEqual(expected.success.entries);
	if ("hasSourceText" in expected.success) {
		expect(decoded.meta?.hasSourceText).toBe(expected.success.hasSourceText);
		expect(decoded.meta?.poFormat).toBe(expected.success.format);
	}
	return imported;
}
