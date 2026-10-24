import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assetReaderLayer, extractProjectTextPackages } from "@ue-shed/unreal-assets";
import { parseManifest } from "@ue-shed/localization/browser";
import { Effect, Result, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { savedFixtureCorpus } from "./saved-corpus.test-support.js";
import { textCorpusFromExtractionEvents } from "./corpus.js";
import { textCorpusQuery } from "./query.test-support.js";

const ROOT = "/Game/Fixture/GameTextActions/";
// World Partition external actors are saved in their own packages beside the content root.
const EXTERNAL_ROOT = "/Game/__ExternalActors__/Fixture/GameTextActions/";
const ENGINES = ["5.7", "5.8"] as const;

const Place = Schema.Struct({ site: Schema.String, source: Schema.String });
// Slice 1 is PR #99's cases; slice 2 (Plan 058 A4) adds String Tables, compiled literals of each
// kind, Blueprint inheritance, a level and a World Partition external actor.
const Slice = Schema.Literals([1, 2]);
const Cases = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: Schema.Literal("GameTextActions"),
	// The newest slice each engine's committed evidence covers.
	evidenceSlices: Schema.Struct({ "5.7": Slice, "5.8": Slice }),
	cases: Schema.Array(
		Schema.Struct({
			case: Schema.String,
			slice: Schema.optionalKey(Slice),
			a: Place,
			b: Place,
			id: Schema.Literals(["same", "different"]),
			packageNamespace: Schema.optionalKey(Schema.Literals(["same", "different"]))
		})
	),
	// Places Unreal does not gather, and why.
	notGathered: Schema.Array(
		Schema.Struct({
			site: Schema.String,
			source: Schema.String,
			slice: Slice,
			reason: Schema.String
		})
	),
	// Places Unreal gathers that the saved-package reader does not read yet, pinned so a change in
	// either direction is noticed.
	readerGaps: Schema.Array(Schema.Struct({ site: Schema.String, source: Schema.String }))
});
const Evidence = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: Schema.Literal("GameTextActions"),
	engineVersion: Schema.String,
	packages: Schema.Array(
		Schema.Struct({
			package: Schema.String,
			packageNamespace: Schema.String,
			texts: Schema.Array(
				Schema.Struct({
					site: Schema.String,
					namespace: Schema.String,
					key: Schema.String,
					source: Schema.String,
					devNotes: Schema.optionalKey(Schema.String),
					editorOnly: Schema.Boolean
				})
			)
		})
	)
});
type Evidence = typeof Evidence.Type;

const generatedRoot = process.env.UE_SHED_GAME_TEXT_ACTIONS_FIXTURE_ROOT;
const fixture = generatedRoot === undefined ? useSavedFixtureProject() : { root: generatedRoot };
const fixtureEngine = Schema.decodeUnknownSync(Schema.Literals(ENGINES))(
	process.env.UE_SHED_GAME_TEXT_ACTIONS_FIXTURE_ENGINE ?? "5.7"
);
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

const readCases = async () =>
	Schema.decodeUnknownSync(Schema.fromJsonString(Cases))(
		await readFile(
			join(fixture.root, "FixtureSource/GameTextActions/expected-cases.json"),
			"utf8"
		)
	);

const readEvidence = async (engine: (typeof ENGINES)[number]) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(Evidence))(
		await readFile(
			join(fixture.root, `FixtureExpected/game-text-actions/evidence.ue${engine}.json`),
			"utf8"
		)
	);

/** Unreal's gather records for one place: its site and source, by gathered (runtime) text first. */
function place(evidence: Evidence, wanted: typeof Place.Type) {
	const site = ROOT + wanted.site;
	const packageName = site.slice(0, site.indexOf("."));
	const entry = evidence.packages.find((item) => item.package === packageName);
	const texts = entry?.texts.filter(
		(text) => text.site === site && text.source === wanted.source
	);
	const text = texts?.find((item) => !item.editorOnly) ?? texts?.[0];
	if (!entry || !text) throw new Error(`No gathered text at ${wanted.site}: ${wanted.source}`);
	return { ...text, packageNamespace: entry.packageNamespace };
}

/** Unreal's conflict report: one block per id, listing each place and its source. */
function conflicts(report: string) {
	return report
		.replaceAll("\r\n", "\n")
		.split("\n\n")
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block) => {
			const [id, ...places] = block.split("\n");
			return {
				// "Namespace - Key"; typed text has an empty namespace.
				key: id!.replace(/^(?:.* )?- /u, "").trim(),
				places: places
					.map((line) =>
						line
							.trim()
							.replace(/ - ".*$/u, "")
							.replace(ROOT, "")
					)
					.sort()
			};
		})
		.sort((left, right) => left.key.localeCompare(right.key));
}

describe("Game Text identity cases in the saved fixture", () => {
	it.each(ENGINES)("records what UE %s did to each id", async (engine) => {
		const cases = await readCases();
		const evidence = await readEvidence(engine);
		expect(evidence.engineVersion).toBe(engine);

		const covered = cases.evidenceSlices[engine];
		const inEvidence = (slice: 1 | 2 | undefined) => (slice ?? 1) <= covered;

		// Typed text never has a user namespace: Unreal keys it with a GUID inside its package's
		// localization namespace, and the gather strips that namespace from the id. A String
		// Table's entries keep the table's namespace and keys.
		for (const entry of evidence.packages) {
			expect(entry.packageNamespace).toMatch(/^[0-9A-F]{32}$/u);
			if (/\/ST_[^/]+$/u.test(entry.package)) continue;
			for (const text of entry.texts.filter((item) => !item.site.includes(".SCS_Node_")))
				expect([text.namespace, text.key]).toEqual([
					"",
					expect.stringMatching(/^[0-9A-F]{32}$/u)
				]);
		}

		// Unreal gathers none of these places.
		const gatheredPlaces = new Set(
			evidence.packages.flatMap((entry) =>
				entry.texts.map((text) => JSON.stringify([text.site, text.source]))
			)
		);
		expect(
			cases.notGathered
				.filter((item) => inEvidence(item.slice))
				.filter((item) =>
					gatheredPlaces.has(JSON.stringify([ROOT + item.site, item.source]))
				)
		).toEqual([]);

		// Every mismatch is listed at once.
		expect(
			cases.cases
				.filter((item) => inEvidence(item.slice))
				.flatMap((item) => {
					const a = place(evidence, item.a);
					const b = place(evidence, item.b);
					const id =
						a.namespace === b.namespace && a.key === b.key ? "same" : "different";
					const packageNamespace =
						a.packageNamespace === b.packageNamespace ? "same" : "different";
					return id === item.id &&
						(item.packageNamespace ?? packageNamespace) === packageNamespace
						? []
						: [{ case: item.case, id, packageNamespace }];
				})
		).toEqual([]);
	});

	it("records C++ LOCTEXT as Unreal gathers it from source (gather-only)", async () => {
		// The saved-package reader never sees C++ text; this case pins only Unreal's source gather
		// (GameTextActions_Source.ini) over FixtureSource/GameTextActions/GameTextActionsLoctext.cpp.
		const manifest = parseManifest(
			await readFile(
				join(
					fixture.root,
					"Content/Localization/GameTextActionsSource/GameTextActionsSource.manifest"
				)
			)
		);
		expect(Result.isSuccess(manifest)).toBe(true);
		if (!Result.isSuccess(manifest)) return;
		const file = "FixtureSource/GameTextActions/GameTextActionsLoctext.cpp";
		expect(
			manifest.success.entries.map(({ namespace, key, source, path }) => ({
				namespace,
				key,
				source: source.Text,
				path
			}))
		).toEqual([
			// A dotted LOCTEXT namespace is one id namespace; the repeated LOCTEXT with the same id
			// and text is one entry, recorded at its first place only.
			{
				namespace: "GameTextActions.Source",
				key: "HarborClosed",
				source: "The harbor is closed",
				path: `${file}(9)`
			},
			{
				namespace: "GameTextActions.Tides",
				key: "TideTable",
				source: "Tide table",
				path: `${file}(22)`
			}
		]);
	});

	it("matches Unreal's conflict report: one id, different text, only across branch copies", async () => {
		const cases = await readCases();
		const evidence = await readEvidence(fixtureEngine);
		const report = await readFile(
			join(
				fixture.root,
				"Content/Localization/GameTextActions/GameTextActions_Conflicts.txt"
			),
			"utf8"
		);
		const expected = cases.cases
			.filter((item) => item.id === "same" && item.a.source !== item.b.source)
			.map((item) => ({
				key: place(evidence, item.a).key,
				places: [item.a.site, item.b.site].sort()
			}))
			.sort((left, right) => left.key.localeCompare(right.key));
		expect(conflicts(report)).toEqual(expected);
	});

	it.skipIf(!executable)(
		"reads the id and source Unreal gathers from every place an action edits",
		async () => {
			const cases = await readCases();
			const evidence = await readEvidence(fixtureEngine);
			const corpus = await Effect.runPromise(
				generatedRoot === undefined
					? savedFixtureCorpus(fixture.root, executable!, true)
					: Effect.map(
							Stream.runCollect(
								extractProjectTextPackages({ projectRoot: fixture.root })
							),
							(events) =>
								textCorpusFromExtractionEvents({
									projectRoot: fixture.root,
									events
								})
						).pipe(Effect.provide(assetReaderLayer({ executable: executable! })))
			);
			const fromReader = new Set<string>();
			for (const unit of corpus.units)
				for (const occurrence of unit.occurrences) {
					if (occurrence.identity.status !== "resolved") continue;
					const packageName = `/Game/${occurrence.packageFile
						.replaceAll("\\", "/")
						.replace(/^Content\//u, "")
						.replace(/\.(?:uasset|umap)$/u, "")}`;
					if (!packageName.startsWith(ROOT) && !packageName.startsWith(EXTERNAL_ROOT))
						continue;
					for (const source of [
						occurrence.source,
						...(occurrence.copies ?? []).map((copy) => copy.source)
					])
						fromReader.add(
							JSON.stringify([packageName, occurrence.identity.key, source])
						);
				}
			// Each runtime text Unreal gathers, by site, that the reader has no matching id and source for.
			const missing = evidence.packages.flatMap((entry) =>
				entry.texts
					.filter(
						(text) =>
							!text.editorOnly &&
							!fromReader.has(JSON.stringify([entry.package, text.key, text.source]))
					)
					.map((text) => ({ site: text.site.replace(ROOT, ""), source: text.source }))
			);
			const key = (item: typeof Place.Type) => JSON.stringify([item.site, item.source]);
			expect([...new Set(missing.map(key))].sort()).toEqual(cases.readerGaps.map(key).sort());
			if (fixtureEngine === "5.8") {
				const notes = evidence.packages.flatMap((entry) =>
					entry.texts.filter((text) => text.source === "Lamp lit" && !text.editorOnly)
				);
				expect(notes.length).toBeGreaterThan(0);
				expect(
					notes.every((text) => text.devNotes === "A lit lantern, not a command")
				).toBe(true);
				expect(
					corpus.units
						.flatMap((unit) => unit.occurrences)
						.some(
							(occurrence) =>
								occurrence.source === "Lamp lit" &&
								occurrence.devNotes === "A lit lantern, not a command" &&
								occurrence.location.kind === "asset_property" &&
								(occurrence.location.propertyPath.startsWith("ScriptBytecode") ||
									occurrence.copies?.some(
										(copy) =>
											copy.kind === "generated_class" &&
											copy.source === "Lamp lit"
									))
						)
				).toBe(true);
			}

			// Nor does the reader give a place Unreal leaves ungathered a localized id of its own:
			// any localized text it reads there with that source carries an id Unreal gathered.
			const gatheredIds = new Set(
				evidence.packages.flatMap((entry) =>
					entry.texts.map((text) => JSON.stringify([entry.package, text.key]))
				)
			);
			const invented = cases.notGathered
				.filter((item) => item.slice <= cases.evidenceSlices[fixtureEngine])
				.filter((item) => {
					const packageName = ROOT + item.site.slice(0, item.site.indexOf("."));
					return [...fromReader].some((entry) => {
						const [readPackage, readKey, readSource] = Schema.decodeUnknownSync(
							Schema.fromJsonString(
								Schema.Tuple([Schema.String, Schema.String, Schema.String])
							)
						)(entry);
						return (
							readPackage === packageName &&
							readSource === item.source &&
							!gatheredIds.has(JSON.stringify([readPackage, readKey]))
						);
					});
				});
			expect(invented).toEqual([]);
		}
	);

	it.skipIf(!executable)(
		"keeps two keys with the same text in one compiled function apart",
		async () => {
			// The duplicated Blueprint's ubergraph prints "The door is locked" under two keys: the
			// Content Browser duplicate re-keyed the original node but not its pasted copy.
			const corpus = textCorpusFromExtractionEvents({
				projectRoot: fixture.root,
				events: await Effect.runPromise(
					Stream.runCollect(
						extractProjectTextPackages({
							projectRoot: fixture.root,
							paths: [
								join(
									fixture.root,
									"Content/Fixture/GameTextActions/BP_ActionSign_Duplicate.uasset"
								)
							]
						})
					).pipe(Effect.provide(assetReaderLayer({ executable: executable! })))
				)
			});
			const locked = corpus.units.flatMap((unit) =>
				unit.occurrences.filter(
					(occurrence) =>
						occurrence.source === "The door is locked" &&
						occurrence.location.kind === "asset_property" &&
						occurrence.location.propertyPath === "Pins[4].DefaultTextValue"
				)
			);
			expect(new Set(locked.map((occurrence) => occurrence.id)).size).toBe(2);
			const matches = textCorpusQuery(corpus).search({
				capability: "all",
				pageSize: 50,
				query: "The door is locked"
			}).units;
			// Each compiled literal folds into its saved pin's package-stamped identity. Unreal
			// gathers two keys; both authored places and their compiled provenance remain visible.
			const evidence = await readEvidence(fixtureEngine);
			const packageNamespace = evidence.packages.find(
				(entry) => entry.package === `${ROOT}BP_ActionSign_Duplicate`
			)!.packageNamespace;
			expect(matches).toHaveLength(2);
			expect(
				matches
					.map((unit) =>
						unit.identity.status === "resolved" ? unit.identity.namespace : undefined
					)
					.sort()
			).toEqual([`[${packageNamespace}]`, `[${packageNamespace}]`]);
			for (const match of matches) {
				const unit = corpus.units.find((unit) => unit.id === match.id)!;
				expect(unit.occurrences).toHaveLength(1);
				expect(unit.occurrences[0]).toMatchObject({
					location: { propertyPath: "Pins[4].DefaultTextValue" },
					copies: [
						{
							kind: "generated_class",
							source: "The door is locked",
							objectPath: expect.stringContaining(".ExecuteUbergraph_")
						}
					]
				});
			}
			expect(
				new Set(
					matches.map((unit) =>
						unit.identity.status === "resolved" ? unit.identity.key : undefined
					)
				).size
			).toBe(2);
		}
	);
});
