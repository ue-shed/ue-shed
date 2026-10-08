import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Ref, Deferred, Fiber } from "effect";
import { expect } from "vitest";
import {
	makeLocalizationEvidenceTestLayer,
	LocalizationError,
	LocalizationEvidenceNodeLive,
	LocalizationTargetName,
	TextKey,
	TextNamespace
} from "@ue-shed/localization";
import {
	corpus,
	evidence,
	poDocument,
	target,
	unit,
	cultureCode
} from "./game-text-localization.test-support.js";
import { makeGameTextLocalization } from "./game-text-localization.js";

it.effect("returns a recoverable reader failure without exposing file authority", () =>
	Effect.gen(function* () {
		const saved = corpus();
		const localization = yield* makeGameTextLocalization(
			() => Effect.succeed(saved),
			() => Effect.succeed("C:/Project")
		).pipe(
			Effect.provide(
				makeLocalizationEvidenceTestLayer({
					discover: () =>
						Effect.succeed({ schemaVersion: 1, targets: [target], diagnostics: [] }),
					read: () =>
						Effect.fail(
							new LocalizationError({
								code: "file_unreadable",
								message: "C:/Private/Archive",
								recovery: "C:/Private/PO"
							})
						),
					targets: () => Effect.die("Not used")
				})
			)
		);
		const result = yield* localization.select(target.name);
		expect(result).toMatchObject({ status: "failed", code: "file_unreadable" });
		expect(JSON.stringify(result)).not.toContain("C:/Private");
	})
);

it.effect("discovers no-target projects without reading evidence", () =>
	Effect.gen(function* () {
		const saved = corpus();
		const localization = yield* makeGameTextLocalization(
			() => Effect.succeed(saved),
			() => Effect.succeed("C:/Project")
		);
		expect(yield* localization.targets()).toEqual({ status: "ready", targets: [] });
	}).pipe(
		Effect.provide(
			makeLocalizationEvidenceTestLayer({
				discover: () => Effect.succeed({ schemaVersion: 1, targets: [], diagnostics: [] }),
				read: () => Effect.die("Evidence must not be read"),
				targets: () => Effect.die("Not used")
			})
		)
	)
);

it.effect(
	"retains evidence across remounts, reloads it after rescan and returns bounded joined pages",
	() =>
		Effect.gen(function* () {
			const text = yield* Ref.make(corpus());
			let reads = 0;
			const api = makeLocalizationEvidenceTestLayer({
				discover: () =>
					Effect.succeed({ schemaVersion: 1, targets: [target], diagnostics: [] }),
				read: () =>
					Effect.sync(() => {
						reads++;
						return evidence(poDocument(reads === 1 ? "Pending" : "Translation"));
					}),
				targets: () => Effect.die("Not used")
			});
			const localization = yield* makeGameTextLocalization(
				() => Ref.get(text),
				() => Effect.succeed("C:/Project")
			).pipe(Effect.provide(api));
			expect(yield* localization.targets()).toMatchObject({
				status: "ready",
				targets: [{ name: target.name, cultures: ["en", "de"] }]
			});
			const loaded = yield* localization.select(target.name);
			expect(loaded).toMatchObject({ status: "ready", lines: 1, notSynced: 2 });
			yield* localization.select(target.name);
			expect(reads).toBe(1);
			const page = yield* localization.search({
				query: "Pending",
				capability: "all",
				pageSize: 1,
				localization: {
					target: target.name,
					culture: cultureCode("de"),
					searchTranslations: true
				}
			});
			expect(page).toMatchObject({ status: "ready", page: { total: 1, counts: { all: 1 } } });
			const focused = yield* localization.focus({
				target: target.name,
				selection: { kind: "unit", id: unit().id }
			});
			expect(focused).toMatchObject({
				status: "found",
				focus: {
					translations: [{ poTranslation: "Pending" }, { poTranslation: "Pending" }]
				}
			});
			expect(JSON.stringify(focused)).not.toContain("provenance");
			yield* Ref.set(text, corpus());
			yield* localization.reset();
			expect(yield* localization.select(target.name)).toMatchObject({
				status: "ready",
				notSynced: 0
			});
			expect(reads).toBe(2);
		})
);

it.effect("discards evidence loaded for a corpus that changed during the read", () =>
	Effect.gen(function* () {
		const text = yield* Ref.make(corpus());
		const started = yield* Deferred.make<void>();
		const result = yield* Deferred.make<ReturnType<typeof evidence>>();
		const localization = yield* makeGameTextLocalization(
			() => Ref.get(text),
			() => Effect.succeed("C:/Project")
		).pipe(
			Effect.provide(
				makeLocalizationEvidenceTestLayer({
					discover: () =>
						Effect.succeed({ schemaVersion: 1, targets: [target], diagnostics: [] }),
					read: () =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Deferred.await(result))
						),
					targets: () => Effect.die("Not used")
				})
			)
		);
		const fiber = yield* localization.select(target.name).pipe(Effect.forkChild);
		yield* Deferred.await(started);
		yield* Ref.set(text, corpus([unit("Another")]));
		yield* localization.reset();
		yield* Deferred.succeed(result, evidence());
		expect(yield* Fiber.join(fiber)).toEqual({ status: "not_ready" });
		expect(
			yield* localization.focus({
				target: target.name,
				selection: { kind: "unit", id: unit().id }
			})
		).toEqual({ status: "not_ready" });
	})
);

it.live("reviews and writes staged edits into the PO file, then reports them as not synced", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-wb-edits-")));
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(root, { recursive: true, force: true }))
		);
		for (const path of [
			"Config/DefaultEditor.ini",
			"Config/Localization",
			"Content/Localization"
		])
			yield* Effect.promise(() =>
				cp(join(resolve("fixtures/unreal-project"), path), join(root, path), {
					recursive: true
				})
			);
		const saved = corpus([]);
		const localization = yield* makeGameTextLocalization(
			() => Effect.succeed(saved),
			() => Effect.succeed(root)
		);
		const name = LocalizationTargetName.make("FixtureGame");
		const selected = yield* localization.select(name);
		if (selected.status !== "ready") throw new Error("Fixture target did not load.");
		const edit = {
			culture: cultureCode("de"),
			namespace: TextNamespace.make("Fixture.Localization.Table"),
			key: TextKey.make("NamedArgument"),
			seenTranslation: "Gespräch mit {Name}",
			translation: "Gespräch mit {PlayerName}"
		};
		const review = yield* localization.edits({ target: name, mode: "review", edits: [edit] });
		expect(review).toMatchObject({
			status: "reviewed",
			edits: [{ outcome: "ready" }],
			files: [{ culture: "de", changes: 1, written: false }]
		});
		const written = yield* localization.edits({ target: name, mode: "write", edits: [edit] });
		expect(written).toMatchObject({
			status: "written",
			files: [{ culture: "de", changes: 1, written: true }],
			notSynced: selected.notSynced + 1
		});
		const po = yield* Effect.promise(() =>
			readFile(join(root, "Content/Localization/FixtureGame/de/FixtureGame.po"), "utf8")
		);
		expect(po).toContain('msgstr "Gespräch mit {PlayerName}"');
		// The same staged edit is stale now: its translation already ships next.
		const again = yield* localization.edits({ target: name, mode: "write", edits: [edit] });
		expect(again).toMatchObject({
			status: "rejected",
			edits: [{ outcome: "stale_translation" }]
		});
	}).pipe(Effect.scoped, Effect.provide(LocalizationEvidenceNodeLive))
);

it.live("writes review flags and shows a later edit as changed since review", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-wb-review-")));
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(root, { recursive: true, force: true }))
		);
		for (const path of [
			"Config/DefaultEditor.ini",
			"Config/Localization",
			"Content/Localization"
		])
			yield* Effect.promise(() =>
				cp(join(resolve("fixtures/unreal-project"), path), join(root, path), {
					recursive: true
				})
			);
		const saved = corpus([]);
		const localization = yield* makeGameTextLocalization(
			() => Effect.succeed(saved),
			() => Effect.succeed(root)
		);
		const name = LocalizationTargetName.make("FixtureGame");
		yield* localization.select(name);
		const line = {
			culture: cultureCode("de"),
			namespace: TextNamespace.make("Fixture.Localization.Table"),
			key: TextKey.make("NamedArgument")
		};
		const written = yield* localization.review(
			{ target: name, changes: [{ kind: "set", ...line, flags: ["reviewed"] }] },
			"tester"
		);
		expect(written).toEqual({
			status: "written",
			relativePath: "Config/UEShed/Localization/FixtureGame.review.json"
		});
		const counts = Effect.gen(function* () {
			const result = yield* localization.search({
				query: "",
				capability: "all",
				pageSize: 50,
				localization: { target: name, culture: line.culture }
			});
			return result.status === "ready" ? result.page.localization?.reviewCounts : undefined;
		});
		expect(yield* counts).toMatchObject({ reviewed: 1, changed_since_review: 0 });
		// Editing the translation afterwards invalidates the review.
		yield* localization.edits({
			target: name,
			mode: "write",
			edits: [
				{
					...line,
					seenTranslation: "Gespräch mit {Name}",
					translation: "Gespräch mit {PlayerName}"
				}
			]
		});
		expect(yield* counts).toMatchObject({ reviewed: 0, changed_since_review: 1 });
	}).pipe(Effect.scoped, Effect.provide(LocalizationEvidenceNodeLive))
);

/**
 * Renames a key in an Unreal manifest or archive, as a gather does after the key changes; in an
 * archive, `translation` replaces the key's translation.
 */
async function renameGatheredKey(path: string, from: string, to: string, translation?: string) {
	const text = new TextDecoder("utf-16le").decode(await readFile(path)).replace(/^\uFEFF/u, "");
	const key = `"Key": "${from}"`;
	const renamed =
		translation === undefined
			? text.replaceAll(key, `"Key": "${to}"`)
			: text.replace(
					new RegExp(
						`("Translation": \\{\\s*"Text": )"(?:[^"\\\\]|\\\\.)*"(\\s*\\},\\s*)${key}`,
						"u"
					),
					`$1${JSON.stringify(translation)}$2"Key": "${to}"`
				);
	if (renamed === text) throw new Error(`${from} was not found in ${path}.`);
	await writeFile(path, Buffer.from("\uFEFF" + renamed, "utf16le"));
}

it.live("pairs a key that changed across a gather it ran, keeping the trimmed translations", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-wb-keys-")));
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(root, { recursive: true, force: true }))
		);
		for (const path of [
			"Config/DefaultEditor.ini",
			"Config/Localization",
			"Content/Localization"
		])
			yield* Effect.promise(() =>
				cp(join(resolve("fixtures/unreal-project"), path), join(root, path), {
					recursive: true
				})
			);
		const saved = corpus([]);
		const localization = yield* makeGameTextLocalization(
			() => Effect.succeed(saved),
			() => Effect.succeed(root)
		);
		const name = LocalizationTargetName.make("FixtureGame");
		yield* localization.select(name);
		yield* localization.beforeGather(name);
		// What Unreal's gather writes after a LOCTEXT key is renamed: the earlier key leaves the
		// manifest and archives, and the new key joins with an empty translation.
		const folder = join(root, "Content/Localization/FixtureGame");
		yield* Effect.promise(async () => {
			await renameGatheredKey(
				join(folder, "FixtureGame.manifest"),
				"RuntimeReady",
				"RuntimeStart"
			);
			await renameGatheredKey(
				join(folder, "en/FixtureGame.archive"),
				"RuntimeReady",
				"RuntimeStart"
			);
			for (const culture of ["de", "fr"])
				await renameGatheredKey(
					join(folder, culture, "FixtureGame.archive"),
					"RuntimeReady",
					"RuntimeStart",
					""
				);
		});
		yield* localization.reset();
		yield* localization.select(name);
		const result = yield* localization.search({
			query: "",
			capability: "all",
			pageSize: 50,
			localization: { target: name, keyChanged: true }
		});
		if (result.status !== "ready") throw new Error("Expected the target to load.");
		const lines = result.page.localization?.lines ?? [];
		expect(lines.map((line) => line.identity?.key)).toEqual(["RuntimeStart"]);
		expect(lines[0]?.keyChange).toMatchObject({
			direction: "to",
			other: { key: "RuntimeReady" },
			match: "same_place",
			sourceChanged: false
		});
		expect(lines[0]?.keyChange?.translations).toContainEqual({
			culture: "de",
			translation: "Bereit zum Start"
		});
	}).pipe(Effect.scoped, Effect.provide(LocalizationEvidenceNodeLive))
);
