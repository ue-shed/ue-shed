import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Result, Schema } from "effect";
import { expect } from "vitest";
import { localizationError } from "./decode.js";
import {
	LocalizationFileAccess,
	LocalizationFileAccessLive,
	makeLocalizationFileAccessTestLayer
} from "./file-access.js";
import {
	defaultLocalizationLimits,
	LocalizationTargetEvidence,
	LocalizationTargetsReport
} from "./schema.js";
import {
	LocalizationEvidence,
	LocalizationEvidenceLive,
	LocalizationEvidenceNodeLive
} from "./service.js";

const projectRoot = resolve("fixtures/unreal-project");
const legacyRoot = resolve("fixtures/unreal-427-localization");

it.effect("reads the real target and every culture with independent provenance", () =>
	Effect.gen(function* () {
		const reader = yield* LocalizationEvidence;
		const report = yield* reader.targets({ projectRoot });
		yield* Schema.decodeUnknownEffect(LocalizationTargetsReport)(report);
		const target = report.targets.find((item) => item.name === "FixtureGame");
		if (target === undefined) throw new Error("Fixture target missing.");
		const evidence = yield* reader.read({ projectRoot, target });
		yield* Schema.decodeUnknownEffect(LocalizationTargetEvidence)(evidence);
		expect(evidence.manifest.status).toBe("read");
		expect(
			evidence.cultures.every(
				(culture) => culture.archive.status === "read" && culture.po.status === "read"
			)
		).toBe(true);
		expect(evidence.locmeta.status).toBe("read");
		expect(evidence.wordCount.status).toBe("read");
		expect(
			report.presence
				.find((item) => item.target === target.name)
				?.cultures.every((culture) => culture.archive && culture.po && culture.resource)
		).toBe(true);
		if (evidence.manifest.status === "read") {
			const bytes = readFileSync(
				resolve(projectRoot, evidence.manifest.provenance.relativePath)
			);
			expect(evidence.manifest.provenance.size).toBe(bytes.length);
			expect(evidence.manifest.provenance.contentHash).toBe(
				createHash("sha256").update(bytes).digest("hex")
			);
			expect(Number.isFinite(Date.parse(evidence.manifest.provenance.modifiedTime))).toBe(
				true
			);
		}
	}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
);

it.effect("discovers and reads the standalone 4.27 recipe without DefaultEditor.ini", () =>
	Effect.gen(function* () {
		const reader = yield* LocalizationEvidence;
		const discovery = yield* reader.discover({ projectRoot: legacyRoot });
		expect(discovery.diagnostics).toEqual([]);
		expect(discovery.targets[0]?.source).toBe("config_only");
		const target = discovery.targets[0];
		if (target === undefined) throw new Error("Fixture target missing.");
		const evidence = yield* reader.read({ projectRoot: legacyRoot, target });
		expect(evidence.cultures).toHaveLength(3);
		expect(
			evidence.cultures.every(
				(culture) => culture.archive.status === "read" && culture.po.status === "read"
			)
		).toBe(true);
	}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
);

it.effect("keeps a missing French PO as that culture's typed diagnostic", () =>
	Effect.gen(function* () {
		const base = yield* LocalizationFileAccess;
		const modified = makeLocalizationFileAccessTestLayer({
			...base,
			read: (root, path, limits) =>
				path.endsWith("/fr/FixtureGame.po")
					? Effect.fail(localizationError("file_missing"))
					: base.read(root, path, limits)
		});
		const evidence = yield* Effect.gen(function* () {
			const reader = yield* LocalizationEvidence;
			const discovery = yield* reader.discover({ projectRoot });
			const target = discovery.targets.find((item) => item.name === "FixtureGame");
			if (target === undefined) throw new Error("Fixture target missing.");
			return yield* reader.read({ projectRoot, target });
		}).pipe(Effect.provide(LocalizationEvidenceLive.pipe(Layer.provide(modified))));
		expect(evidence.cultures.find((culture) => culture.culture === "fr")?.po).toMatchObject({
			status: "failed",
			error: { code: "file_missing" }
		});
		expect(evidence.cultures.find((culture) => culture.culture === "fr")?.archive.status).toBe(
			"read"
		);
		expect(
			evidence.cultures
				.filter((culture) => culture.culture !== "fr")
				.every((culture) => culture.po.status === "read")
		).toBe(true);
	}).pipe(Effect.provide(LocalizationFileAccessLive))
);

it.effect("rejects oversize reads before allocation and project-root traversal", () =>
	Effect.gen(function* () {
		const files = yield* LocalizationFileAccess;
		const oversize = yield* files
			.read(projectRoot, "Config/DefaultEditor.ini", {
				...defaultLocalizationLimits,
				maxFileBytes: 1
			})
			.pipe(Effect.result);
		expect(Result.isFailure(oversize) && oversize.failure.code).toBe("limit_exceeded");
		const escaped = yield* files
			.read(projectRoot, "../../package.json", defaultLocalizationLimits)
			.pipe(Effect.result);
		expect(Result.isFailure(escaped) && escaped.failure.code).toBe("unsafe_path");
	}).pipe(Effect.provide(LocalizationFileAccessLive))
);

it.effect("reports a typed failure for an unavailable project root", () =>
	Effect.gen(function* () {
		const reader = yield* LocalizationEvidence;
		const result = yield* reader
			.discover({ projectRoot: resolve(legacyRoot, "unavailable-project") })
			.pipe(Effect.result);
		expect(Result.isFailure(result) && result.failure.code).toBe("directory_unreadable");
	}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
);

it("defaults to larger per-file limits and a bounded target file count", () => {
	expect(defaultLocalizationLimits).toEqual({
		maxFileBytes: 320 * 1024 * 1024,
		maxEntries: 1_000_000,
		maxDepth: 64,
		maxFiles: 2_560
	});
});

it.effect("reads files whose combined entries exceed the per-file limit", () =>
	Effect.gen(function* () {
		const reader = yield* LocalizationEvidence;
		const discovery = yield* reader.discover({ projectRoot: legacyRoot });
		const target = discovery.targets[0];
		if (target === undefined) throw new Error("Fixture target missing.");
		const evidence = yield* reader.read({
			projectRoot: legacyRoot,
			target,
			limits: { ...defaultLocalizationLimits, maxEntries: 20 }
		});
		expect(evidence.manifest.status).toBe("read");
		let total =
			evidence.manifest.status === "read" ? evidence.manifest.value.entries.length : 0;
		for (const culture of evidence.cultures) {
			expect(culture.archive.status).toBe("read");
			expect(culture.po.status).toBe("read");
			if (culture.archive.status === "read") {
				expect(culture.archive.value.entries.length).toBeLessThanOrEqual(20);
				total += culture.archive.value.entries.length;
			}
			if (culture.po.status === "read") {
				const entries = culture.po.value.blocks.filter((block) => block.kind === "entry");
				expect(entries.length).toBeLessThanOrEqual(20);
				total += entries.length;
			}
		}
		expect(total).toBeGreaterThan(20);
	}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
);

it.effect("keeps a single file's entry limit failure with provenance", () =>
	Effect.gen(function* () {
		const reader = yield* LocalizationEvidence;
		const discovery = yield* reader.discover({ projectRoot: legacyRoot });
		const target = discovery.targets[0];
		if (target === undefined) throw new Error("Fixture target missing.");
		const evidence = yield* reader.read({
			projectRoot: legacyRoot,
			target,
			limits: { ...defaultLocalizationLimits, maxEntries: 1 }
		});
		expect(evidence.manifest).toMatchObject({
			status: "failed",
			error: { code: "limit_exceeded" },
			provenance: { size: expect.any(Number) }
		});
	}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
);

it.effect("preserves cancellation while reading through the file port", () =>
	Effect.gen(function* () {
		const entered = yield* Deferred.make<void>();
		const released = yield* Deferred.make<void>();
		const layer = makeLocalizationFileAccessTestLayer({
			read: () =>
				Effect.gen(function* () {
					yield* Deferred.succeed(entered, undefined);
					return yield* Effect.never;
				}).pipe(Effect.ensuring(Deferred.succeed(released, undefined))),
			listConfigs: () => Effect.succeed([]),
			presence: () => Effect.succeed(false),
			replace: () => Effect.fail(localizationError("file_unwritable")),
			create: () => Effect.fail(localizationError("file_unwritable"))
		});
		const work = Effect.flatMap(LocalizationEvidence, (reader) =>
			reader.discover({ projectRoot })
		).pipe(Effect.provide(LocalizationEvidenceLive.pipe(Layer.provide(layer))));
		const fiber = yield* work.pipe(Effect.forkChild);
		yield* Deferred.await(entered);
		yield* Fiber.interrupt(fiber);
		expect(yield* Deferred.isDone(released)).toBe(true);
	})
);
