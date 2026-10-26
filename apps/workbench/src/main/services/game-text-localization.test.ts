import { it } from "@effect/vitest";
import {
	LocalizationError,
	LocalizationEvidenceNodeLive,
	LocalizationTargetName,
	makeLocalizationEvidenceTestLayer,
	TextKey,
	TextNamespace
} from "@ue-shed/localization";
import { Deferred, Effect, Fiber, Ref } from "effect";
import type { LocalizationKeyChangePair } from "@ue-shed/game-text/corpus";
import { LocalizationLineId, type LocalizationLineMark } from "@ue-shed/game-text/schema";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import {
	linesPage,
	makeCannedGameTextLocalization,
	poTranslations,
	searchPage,
	testProjectIndex,
	type CannedQuery
} from "./game-text-index.test-support.js";
import {
	corpus,
	cultureCode,
	evidence,
	poDocument,
	target,
	unit
} from "./game-text-localization.test-support.js";

it.effect("returns a recoverable reader failure without exposing file authority", () =>
	Effect.gen(function* () {
		const saved = corpus();
		const localization = yield* makeCannedGameTextLocalization(
			() => ({}),
			() => Effect.succeed(saved),
			() => Effect.succeed(testProjectIndex("C:/Project"))
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
								recovery: "C:/Private/PO",
								retrySafe: true,
								nextStep: "fix_input"
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

/**
 * The target's one line: not synced in either culture while the PO files hold Pending, and found
 * by that German translation.
 */
const pendingAnswers: CannedQuery = ({ evidence: files }) => {
	const pending = poTranslations(files).includes("Pending");
	return {
		search: (request) =>
			Effect.succeed(
				request.query === "Pending"
					? searchPage({
							total: pending ? 1 : 0,
							counts: { ...searchPage().counts, all: pending ? 1 : 0 }
						})
					: searchPage({
							total: 1,
							localization: linesPage(target.name, { notSynced: pending ? 2 : 0 })
						})
			),
		localizationDetail: (request) =>
			Effect.succeed(
				request.selection.kind === "unit" && request.selection.id === unit().id
					? {
							id: LocalizationLineId.make('Test:["NS","K"]'),
							origin: { kind: "corpus", unitIds: [unit().id] },
							identity: {
								namespace: TextNamespace.make("NS"),
								key: TextKey.make("K")
							},
							source: "Source",
							locations: ["/Game/Text/Table.Table"],
							translatorNotes: [],
							totalLocations: 1,
							translations: target.cultures.map((culture) => ({
								culture,
								state: "unknown",
								facts: ["not_synced", "unknown"],
								unknownReasons: ["gather_settings_unavailable"],
								reducedSourceChecking: false,
								gameTranslation: null,
								gameTextKind: "unavailable",
								archiveTranslation: "Translation",
								cultureState: "unknown",
								translationSource: "Source",
								poTranslation: pending ? "Pending" : "Translation",
								translatorComments: [],
								flags: [],
								remainingComments: 0,
								remainingFlags: 0
							})),
							totalCultures: 2
						}
					: undefined
			)
	};
};

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
			const localization = yield* makeCannedGameTextLocalization(
				pendingAnswers,
				() => Ref.get(text),
				() => Effect.succeed(testProjectIndex("C:/Project"))
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
		const localization = yield* makeCannedGameTextLocalization(
			() => ({}),
			() => Ref.get(text),
			() => Effect.succeed(testProjectIndex("C:/Project"))
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

const fixtureTarget = LocalizationTargetName.make("FixtureGame");
const editedTranslation = "Gespräch mit {PlayerName}";
/**
 * The fixture target's 24 lines, one of them not synced. Once the PO files hold the tests' edit,
 * its line is not synced too; with the review file's flag on that line, it counts as reviewed
 * until the edit lands and as changed since review after.
 */
const fixtureAnswers: CannedQuery = ({ evidence: files, review }) => {
	const edited = poTranslations(files).includes(editedTranslation);
	const flagged = (review?.records.length ?? 0) > 0;
	return {
		search: () =>
			Effect.succeed(
				searchPage({
					total: 24,
					localization: linesPage(fixtureTarget, {
						notSynced: edited ? 2 : 1,
						...(flagged
							? {
									reviewCounts: {
										reviewed: edited ? 0 : 1,
										not_reviewed: 0,
										not_proofread: 0,
										changed_since_review: edited ? 1 : 0,
										machine_translated: 0
									}
								}
							: undefined)
					})
				})
			)
	};
};

it.live("reviews and writes staged edits into the PO file, then reports them as not synced", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-wb-edits-")));
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(root, { recursive: true, force: true }))
		);
		for (const path of [
			"Config/DefaultEditor.ini",
			"Config/Localization/FixtureGame_Export.ini",
			"Content/Localization/FixtureGame"
		])
			yield* Effect.promise(() =>
				cp(join(resolve("fixtures/unreal-project"), path), join(root, path), {
					recursive: true
				})
			);
		const saved = corpus([]);
		const localization = yield* makeCannedGameTextLocalization(
			fixtureAnswers,
			() => Effect.succeed(saved),
			() => Effect.succeed(testProjectIndex(root))
		);
		const name = fixtureTarget;
		const selected = yield* localization.select(name);
		if (selected.status !== "ready") throw new Error("Fixture target did not load.");
		const edit = {
			culture: cultureCode("de"),
			namespace: TextNamespace.make("Fixture.Localization.Table"),
			key: TextKey.make("NamedArgument"),
			seenTranslation: "Gespräch mit {Name}",
			translation: editedTranslation
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

it.live("prepares every PO file an edit replaces, and writes nothing when that fails", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-wb-prepare-")));
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(root, { recursive: true, force: true }))
		);
		for (const path of [
			"Config/DefaultEditor.ini",
			"Config/Localization/FixtureGame_Export.ini",
			"Content/Localization/FixtureGame"
		])
			yield* Effect.promise(() =>
				cp(join(resolve("fixtures/unreal-project"), path), join(root, path), {
					recursive: true
				})
			);
		const prepared: (readonly string[])[] = [];
		let refuse = true;
		const saved = corpus([]);
		const localization = yield* makeCannedGameTextLocalization(
			fixtureAnswers,
			() => Effect.succeed(saved),
			() => Effect.succeed(testProjectIndex(root)),
			undefined,
			undefined,
			(paths) =>
				Effect.suspend(() => {
					prepared.push(paths);
					return refuse
						? Effect.fail({ message: "Checked out elsewhere.", recovery: "Ask them." })
						: Effect.void;
				})
		);
		const selected = yield* localization.select(fixtureTarget);
		if (selected.status !== "ready") throw new Error("Fixture target did not load.");
		const edit = {
			culture: cultureCode("de"),
			namespace: TextNamespace.make("Fixture.Localization.Table"),
			key: TextKey.make("NamedArgument"),
			seenTranslation: "Gespräch mit {Name}",
			translation: editedTranslation
		};
		const poPath = join(root, "Content/Localization/FixtureGame/de/FixtureGame.po");
		const before = yield* Effect.promise(() => readFile(poPath, "utf8"));
		const refused = yield* localization.edits({
			target: fixtureTarget,
			mode: "write",
			edits: [edit]
		});
		expect(refused).toEqual({
			status: "failed",
			code: "file_unwritable",
			message: "Checked out elsewhere.",
			recovery: "Ask them."
		});
		expect(prepared).toEqual([[resolve(poPath)]]);
		expect(yield* Effect.promise(() => readFile(poPath, "utf8"))).toBe(before);
		// A review stages nothing, so it prepares nothing.
		yield* localization.edits({ target: fixtureTarget, mode: "review", edits: [edit] });
		expect(prepared).toHaveLength(1);
		refuse = false;
		expect(
			yield* localization.edits({ target: fixtureTarget, mode: "write", edits: [edit] })
		).toMatchObject({ status: "written", files: [{ culture: "de", written: true }] });
		expect(prepared).toEqual([[resolve(poPath)], [resolve(poPath)]]);
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
			"Config/Localization/FixtureGame_Export.ini",
			"Content/Localization/FixtureGame"
		])
			yield* Effect.promise(() =>
				cp(join(resolve("fixtures/unreal-project"), path), join(root, path), {
					recursive: true
				})
			);
		const saved = corpus([]);
		const localization = yield* makeCannedGameTextLocalization(
			fixtureAnswers,
			() => Effect.succeed(saved),
			() => Effect.succeed(testProjectIndex(root))
		);
		const name = fixtureTarget;
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
					translation: editedTranslation
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

/** A gathered fixture line in the Source namespace, as a key-change read lists it. */
function sourceLine(key: string, source: string, line: number) {
	const identity = {
		namespace: TextNamespace.make("Fixture.Localization.Source"),
		key: TextKey.make(key)
	};
	return {
		id: LocalizationLineId.make(`FixtureGame:${JSON.stringify([identity.namespace, key])}`),
		identity,
		source,
		manifest: [
			{
				...identity,
				source: { Text: source },
				path: `Source/UEShedFixture/Private/UEShedLocalizationText.cpp(${line})`
			}
		]
	};
}
const translated = (culture: string, translation: string): LocalizationLineMark => ({
	culture: cultureCode(culture),
	state: "translated",
	facts: ["translated"],
	unknownReasons: [],
	reducedSourceChecking: false,
	translation
});

it.live("pairs a key that changed across a gather it ran, keeping the trimmed translations", () =>
	Effect.gen(function* () {
		const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-wb-keys-")));
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(root, { recursive: true, force: true }))
		);
		for (const path of [
			"Config/DefaultEditor.ini",
			"Config/Localization/FixtureGame_Export.ini",
			"Content/Localization/FixtureGame"
		])
			yield* Effect.promise(() =>
				cp(join(resolve("fixtures/unreal-project"), path), join(root, path), {
					recursive: true
				})
			);
		const saved = corpus([]);
		// Before the gather the fixture's Source lines hold RuntimeReady; after it, RuntimeStart in
		// the same place. Each refresh's carried pairs are what the host hands the index.
		const ordered = sourceLine("RuntimeOrdered", "Stage {0} of {1}", 10);
		const before = [
			{
				...ordered,
				marks: [translated("en", "Stage {0} of {1}"), translated("de", "Stufe {0} von {1}")]
			},
			{
				...sourceLine("RuntimeReady", "Ready to begin", 9),
				marks: [
					translated("en", "Ready to begin"),
					translated("de", "Bereit zum Start"),
					translated("fr", "Prêt à commencer")
				]
			}
		];
		const after = [ordered, sourceLine("RuntimeStart", "Ready to begin", 9)];
		const carried: (readonly LocalizationKeyChangePair[])[] = [];
		const localization = yield* makeCannedGameTextLocalization(
			(inputs) => {
				carried.push(inputs.request.keyChangePairs ?? []);
				const manifest = inputs.evidence?.manifest;
				const gathered =
					manifest?.status === "read" &&
					manifest.value.entries.some((entry) => entry.key === "RuntimeStart");
				return {
					...fixtureAnswers(inputs),
					selectLocalizationLines: () =>
						// SAFETY: the host's key-change reads name only `identity`, `source`,
						// `manifest` and `marks`, and the lines before the gather carry all four.
						Effect.succeed(gathered ? after : before) as never
				};
			},
			() => Effect.succeed(saved),
			() => Effect.succeed(testProjectIndex(root))
		);
		const name = fixtureTarget;
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
		expect(carried.flat()).toEqual([]);
		expect(yield* localization.select(name)).toMatchObject({ status: "ready" });
		const pairs = carried.at(-1) ?? [];
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({
			from: { key: "RuntimeReady" },
			to: { key: "RuntimeStart" },
			match: "same_place",
			sourceChanged: false
		});
		expect(pairs[0]?.translations).toContainEqual({
			culture: "de",
			translation: "Bereit zum Start"
		});
	}).pipe(Effect.scoped, Effect.provide(LocalizationEvidenceNodeLive))
);
