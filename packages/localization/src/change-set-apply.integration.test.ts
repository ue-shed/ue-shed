import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { afterEach, expect } from "vitest";
import { applyLocalizationChangeSet } from "./change-set-apply.js";
import { reviewLocalizationChangeSet } from "./change-set-review.js";
import { LocalizationChange, LocalizationChangeSet } from "./change-sets.js";
import {
	LocalizationFileAccess,
	LocalizationFileAccessLive,
	makeLocalizationFileAccessTestLayer
} from "./file-access.js";
import { parsePO } from "./po.js";
import { CultureCode, defaultLocalizationLimits, LocalizationTargetName } from "./schema.js";
import { TextKey, TextNamespace } from "./schema.js";
import { LocalizationEvidence, LocalizationEvidenceLive } from "./service.js";

const fixture = resolve("fixtures/unreal-project");
const layer = LocalizationEvidenceLive.pipe(Layer.provideMerge(LocalizationFileAccessLive));
const roots: string[] = [];
const dePO = "Content/Localization/FixtureGame/de/FixtureGame.po";
const deArchive = "Content/Localization/FixtureGame/de/FixtureGame.archive";

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A disposable project holding only the target's settings, configs and generated files. */
async function project() {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-loc-write-"));
	roots.push(root);
	for (const path of ["Config/DefaultEditor.ini", "Config/Localization", "Content/Localization"])
		await cp(join(fixture, path), join(root, path), { recursive: true });
	return root;
}

const hash = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");

function change(
	culture: string,
	key: string,
	source: string,
	previousTranslation: string | null,
	translation: string
) {
	return LocalizationChange.make({
		target: LocalizationTargetName.make("FixtureGame"),
		culture: CultureCode.make(culture),
		namespace: TextNamespace.make("Fixture.Localization.Table"),
		key: TextKey.make(key),
		source,
		previousTranslation,
		translation
	});
}

const changeSet = (...changes: LocalizationChange[]) =>
	LocalizationChangeSet.make({
		schemaVersion: 1,
		provenance: { producer: "test", files: [] },
		changes
	});

const named = change(
	"de",
	"NamedArgument",
	"Talking with {PlayerName}",
	"Gespräch mit {Name}",
	"Gespräch mit {PlayerName}"
);

function poTranslation(bytes: Uint8Array, key: string) {
	const document = parsePO(bytes);
	if (Result.isFailure(document)) throw document.failure;
	return document.success.blocks.find((block) => block.entry?.identity?.key === key)?.entry
		?.msgstr["0"];
}

it.effect("writes a current change into the culture's PO file and nothing else", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const archiveBefore = yield* Effect.promise(() => hash(join(root, deArchive)));
		const receipt = yield* applyLocalizationChangeSet({
			projectRoot: root,
			changeSet: changeSet(named)
		});
		expect(receipt.status).toBe("written");
		expect(receipt.files).toEqual([
			expect.objectContaining({ culture: "de", relativePath: dePO, changes: 1, error: null })
		]);
		const bytes = yield* Effect.promise(() => readFile(join(root, dePO)));
		expect(poTranslation(bytes, "NamedArgument")).toBe("Gespräch mit {PlayerName}");
		expect(receipt.files[0]?.afterHash).toBe(createHash("sha256").update(bytes).digest("hex"));
		// Unreal's files are untouched: the edit waits in the PO until the next sync.
		expect(yield* Effect.promise(() => hash(join(root, deArchive)))).toBe(archiveBefore);
	}).pipe(Effect.provide(layer))
);

it.effect("rejects the whole set when any change is stale, unless asked to skip it", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const before = yield* Effect.promise(() => hash(join(root, dePO)));
		const stale = change("de", "OrderedArgument", "Old source", "Kontrollpunkt {0}", "Neu {0}");
		const rejected = yield* applyLocalizationChangeSet({
			projectRoot: root,
			changeSet: changeSet(named, stale)
		});
		expect(rejected.status).toBe("rejected");
		expect(rejected.review.changes.map((item) => item.outcome)).toEqual([
			"ready",
			"stale_source"
		]);
		expect(yield* Effect.promise(() => hash(join(root, dePO)))).toBe(before);

		const partial = yield* applyLocalizationChangeSet({
			projectRoot: root,
			changeSet: changeSet(named, stale),
			skipStale: true
		});
		expect(partial.status).toBe("written");
		expect(partial.files[0]?.changes).toBe(1);
	}).pipe(Effect.provide(layer))
);

it.effect("revalidates against the translation that ships next", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		yield* applyLocalizationChangeSet({ projectRoot: root, changeSet: changeSet(named) });
		const evidence = yield* Effect.gen(function* () {
			const reader = yield* LocalizationEvidence;
			const discovery = yield* reader.discover({ projectRoot: root });
			const target = discovery.targets.find((item) => item.name === "FixtureGame");
			if (target === undefined) throw new Error("Fixture target missing.");
			return yield* reader.read({ projectRoot: root, target });
		});
		const review = reviewLocalizationChangeSet(
			evidence,
			changeSet(
				named,
				change(
					"de",
					"NamedArgument",
					"Talking with {PlayerName}",
					"Gespräch mit {PlayerName}",
					"Gespräch mit {PlayerName}"
				),
				// The pending, not-synced edit already ships next for this line.
				change(
					"de",
					"Unsynced",
					"Start a new session",
					"Eine frische Sitzung beginnen",
					"Eine neue Runde beginnen"
				),
				change("de", "AddedAfterGather", "A new instruction", null, "Neu"),
				change("xx", "NamedArgument", "Talking with {PlayerName}", null, "x")
			)
		);
		expect(review.changes.map((item) => item.outcome)).toEqual([
			"stale_translation",
			"unchanged",
			"ready",
			"not_in_manifest",
			"culture_unavailable"
		]);
		expect(review.changes[0]?.currentTranslation).toBe("Gespräch mit {PlayerName}");
	}).pipe(Effect.provide(layer))
);

it.effect("treats an absent previous translation as matching an empty one", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const reader = yield* LocalizationEvidence;
		const discovery = yield* reader.discover({ projectRoot: root });
		const target = discovery.targets.find((item) => item.name === "FixtureGame");
		if (target === undefined) throw new Error("Fixture target missing.");
		const evidence = yield* reader.read({ projectRoot: root, target });
		// An edit staged before a gather saw no translation; Unreal's gather then gives the key an
		// empty one. Both mean nothing ships, so the edit is still current.
		const carried = (previousTranslation: string | null) =>
			LocalizationChange.make({
				target: LocalizationTargetName.make("FixtureGame"),
				culture: CultureCode.make("fr"),
				namespace: TextNamespace.make("Fixture.Localization.Rows"),
				key: TextKey.make("EmptyFrench"),
				source: "Return to menu",
				previousTranslation,
				translation: "Retour au menu"
			});
		const review = reviewLocalizationChangeSet(evidence, changeSet(carried(null)));
		expect(review.changes.map((item) => item.outcome)).toEqual(["ready"]);
		expect(
			reviewLocalizationChangeSet(evidence, changeSet(carried("Menu"))).changes[0]?.outcome
		).toBe("stale_translation");
	}).pipe(Effect.provide(layer))
);

it.effect("refuses to replace a PO file that changed after it was read", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const files = yield* LocalizationFileAccess;
		const before = yield* Effect.promise(() => hash(join(root, dePO)));
		yield* Effect.promise(() => writeFile(join(root, dePO), "changed by a translator\n"));
		const result = yield* files
			.replace(
				root,
				dePO,
				new TextEncoder().encode("ours\n"),
				before,
				defaultLocalizationLimits
			)
			.pipe(Effect.result);
		expect(Result.isFailure(result) && result.failure.code).toBe("file_changed");
		expect(yield* Effect.promise(() => readFile(join(root, dePO), "utf8"))).toBe(
			"changed by a translator\n"
		);
	}).pipe(Effect.provide(layer))
);

it.effect("rejects a PO changed between evidence review and the full-fidelity reread", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(project);
		const files = yield* LocalizationFileAccess;
		let reads = 0;
		const updated = "# Changed after review\n";
		const port = makeLocalizationFileAccessTestLayer({
			...files,
			read: (base, path, limits) =>
				Effect.gen(function* () {
					if (path === dePO && ++reads === 2) {
						yield* Effect.promise(() => writeFile(join(root, dePO), updated));
					}
					return yield* files.read(base, path, limits);
				})
		});
		const result = yield* applyLocalizationChangeSet({
			projectRoot: root,
			changeSet: changeSet(named)
		}).pipe(
			Effect.provide(LocalizationEvidenceLive.pipe(Layer.provideMerge(port))),
			Effect.result
		);
		expect(Result.isFailure(result) && result.failure.code).toBe("file_changed");
		expect(reads).toBe(2);
		expect(yield* Effect.promise(() => readFile(join(root, dePO), "utf8"))).toBe(updated);
	}).pipe(Effect.provide(LocalizationFileAccessLive))
);
