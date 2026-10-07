import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { parseArchive, parseManifest } from "./json-formats.js";
import { defaultLocalizationLimits, LocalizationError } from "./schema.js";

const project = resolve("fixtures/unreal-project");
const output = resolve(project, "Content/Localization/FixtureGame");
const legacy = resolve("fixtures/unreal-427-localization/Content/Localization/Fixture427");
const OracleEntry = Schema.Struct({
	culture: Schema.String,
	namespace: Schema.String,
	key: Schema.String,
	manifestSource: Schema.NullOr(Schema.String),
	archiveSource: Schema.NullOr(Schema.String),
	archiveTranslation: Schema.NullOr(Schema.String),
	manifestKeyPaths: Schema.Array(Schema.String),
	manifestDevNotes: Schema.optionalKey(Schema.Array(Schema.String))
});
const Oracle = Schema.Struct({ entries: Schema.Array(OracleEntry) });
const oracle = (version: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(Oracle))(
		readFileSync(
			resolve(project, `FixtureExpected/localization/evidence.ue${version}.json`),
			"utf8"
		)
	);
const utf8 = (value: Schema.Json) => new TextEncoder().encode(JSON.stringify(value));
function success<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}

describe("manifest and archive evidence", () => {
	for (const version of ["5.7", "5.8"]) {
		it(`matches manifest and archive bytes to Unreal ${version}'s oracle`, () => {
			const directory =
				version === "5.8"
					? resolve(project, "FixtureExpected/localization/ue5.8-output")
					: output;
			const manifest = success(
				parseManifest(readFileSync(resolve(directory, "FixtureGame.manifest")))
			);
			for (const culture of ["en", "de", "fr"]) {
				const archive = success(
					parseArchive(readFileSync(resolve(directory, culture, "FixtureGame.archive")))
				);
				const expected = oracle(version).entries.filter(
					(entry) => entry.culture === culture
				);
				for (const entry of expected) {
					const matches = manifest.entries.filter(
						(item) => item.namespace === entry.namespace && item.key === entry.key
					);
					expect(matches.map((item) => item.path).sort()).toEqual(
						[...entry.manifestKeyPaths].sort()
					);
					if (entry.manifestSource !== null)
						expect(matches.map((item) => item.source.Text)).toEqual(
							entry.manifestKeyPaths.map(() => entry.manifestSource)
						);
					const translated = archive.entries.find(
						(item) => item.namespace === entry.namespace && item.key === entry.key
					);
					expect(translated?.source.Text ?? null).toBe(entry.archiveSource);
					expect(translated?.translation.Text ?? null).toBe(entry.archiveTranslation);
					if (version === "5.7")
						expect(matches.every((item) => item.devNotes === undefined)).toBe(true);
					else {
						// Unreal's getter returns an empty note for an omitted field.
						expect(matches.map((item) => item.devNotes ?? "")).toEqual(
							entry.manifestDevNotes
						);
					}
				}
				expect(
					archive.entries.every((entry) =>
						expected.some(
							(item) => item.namespace === entry.namespace && item.key === entry.key
						)
					)
				).toBe(true);
				expect(archive.diagnostics).toEqual([]);
			}
			expect(manifest.diagnostics).toEqual([]);
			expect(Object.isFrozen(manifest.entries)).toBe(true);
		});
	}

	it("decodes 5.8 DevNotes from an in-memory serializer-shaped sample taken from its oracle", () => {
		// Also exercise explicit empty DevNotes, which Unreal omits from the byte fixture.
		const entries = oracle("5.8").entries.filter(
			(entry) => entry.culture === "en" && entry.manifestSource !== null
		);
		const parsed = success(
			parseManifest(
				utf8({
					FormatVersion: 1,
					Namespace: "",
					Subnamespaces: entries.map((entry) => ({
						Namespace: entry.namespace,
						Children: [
							{
								Source: { Text: entry.manifestSource },
								Keys: entry.manifestKeyPaths.map((Path, index) => {
									const key: Schema.MutableJsonObject = { Key: entry.key, Path };
									const notes = entry.manifestDevNotes?.[index];
									if (notes !== undefined) key.DevNotes = notes;
									return key;
								})
							}
						]
					}))
				})
			)
		);
		for (const entry of entries)
			expect(
				parsed.entries
					.filter((item) => item.namespace === entry.namespace && item.key === entry.key)
					.map((item) => item.devNotes)
			).toEqual(entry.manifestDevNotes);
		expect(parsed.entries.find((entry) => entry.key === "Welcome")?.devNotes).toBe(
			"Greeting on the start screen."
		);
	});

	it("reads 4.27 brace layout and all three archives without hand-authored file output", () => {
		const manifest = success(
			parseManifest(readFileSync(resolve(legacy, "Fixture427.manifest")))
		);
		expect(manifest.entries.map((entry) => [entry.namespace, entry.key, entry.path])).toEqual([
			["Fixture427", "Greeting", "FixtureSource/Text.ini:2"],
			["Fixture427", "Ordered", "FixtureSource/Text.ini:3"],
			["Fixture427", "Plural", "FixtureSource/Text.ini:4"]
		]);
		for (const culture of ["en", "de", "fr"]) {
			const archive = success(
				parseArchive(readFileSync(resolve(legacy, culture, "Fixture427.archive")))
			);
			expect(archive.entries).toHaveLength(3);
			for (const entry of archive.entries) {
				expect(entry.source).toEqual(
					manifest.entries.find((item) => item.key === entry.key)?.source
				);
				expect(entry.translation.Text).toBe(culture === "en" ? entry.source.Text : "");
			}
		}
	});

	it("accepts UTF-8 with and without BOM and preserves source/key metadata and duplicates", () => {
		const tree = {
			FormatVersion: 1,
			Namespace: "",
			Children: [
				{
					Source: { Text: "Source", Extra: { Note: "Opaque", Nested: [1, true] } },
					Keys: [
						{
							Key: "K",
							Path: "a",
							Optional: true,
							MetaData: { Info: { Note: "info" }, Key: { Context: "key" } }
						},
						{ Key: "K", Path: "b" }
					]
				}
			]
		};
		for (const bom of ["", "\uFEFF"]) {
			const manifest = success(
				parseManifest(new TextEncoder().encode(bom + JSON.stringify(tree)))
			);
			expect(manifest.entries).toHaveLength(2);
			expect(manifest.entries[0]?.source.Extra).toEqual(tree.Children[0]?.Source.Extra);
			expect(manifest.entries[0]?.metadata).toEqual(tree.Children[0]?.Keys[0]?.MetaData);
			expect(manifest.diagnostics).toEqual([
				{ code: "duplicate_identity", namespace: "", key: "K", count: 2 }
			]);
			expect(Object.isFrozen(manifest.entries[0]?.source.Extra)).toBe(true);
		}
		const entry = {
			Source: { Text: "source", Note: "source metadata" },
			Translation: { Text: "translated", Note: "translation metadata" },
			Key: "K",
			Optional: true,
			MetaData: { Key: { Context: "one" } }
		};
		const archive = success(
			parseArchive(utf8({ FormatVersion: 2, Namespace: "N", Children: [entry, entry] }))
		);
		expect(archive.entries[0]?.source.Note).toBe("source metadata");
		expect(archive.entries[0]?.translation.Note).toBe("translation metadata");
		expect(archive.entries[0]?.metadata).toEqual(entry.MetaData);
		expect(archive.diagnostics[0]?.count).toBe(2);
	});

	it("returns safe typed failures for versions, JSON, schemas, encoding and bounds", () => {
		const inputs = [
			parseManifest(utf8({ FormatVersion: 2 })),
			parseArchive(utf8({ FormatVersion: 1 })),
			parseManifest(new TextEncoder().encode('{"secret":"private",')),
			parseManifest(
				utf8({ FormatVersion: 1, Namespace: "", Children: [{ Source: { Text: 3 } }] })
			),
			parseManifest(new Uint8Array([0xff])),
			parseManifest(readFileSync(resolve(output, "FixtureGame.manifest")), {
				...defaultLocalizationLimits,
				maxFileBytes: 8
			}),
			parseManifest(readFileSync(resolve(output, "FixtureGame.manifest")), {
				...defaultLocalizationLimits,
				maxEntries: 1
			}),
			parseManifest(
				utf8({ FormatVersion: 1, Namespace: "", Subnamespaces: [{ Namespace: "N" }] }),
				{ ...defaultLocalizationLimits, maxDepth: 1 }
			)
		];
		expect(
			inputs.map((result) => (result._tag === "Failure" ? result.failure.code : "success"))
		).toEqual([
			"unsupported_version",
			"unsupported_version",
			"malformed_json",
			"invalid_schema",
			"invalid_encoding",
			"limit_exceeded",
			"limit_exceeded",
			"limit_exceeded"
		]);
		for (const result of inputs)
			if (result._tag === "Failure") {
				expect(result.failure).toBeInstanceOf(LocalizationError);
				expect(result.failure.message).not.toMatch(/secret|private/u);
				expect(result.failure.recovery.length).toBeGreaterThan(0);
			}
	});
});
