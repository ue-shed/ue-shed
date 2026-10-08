import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import {
	CultureCode,
	TextKey,
	TextNamespace,
	LocalizationTargetName
} from "@ue-shed/localization/browser";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { scanTextCorpus } from "./corpus.js";
import { joinLocalizationTarget } from "./localization.js";
import { LocalizationState } from "./localization-schema.js";

const ExpectedStates = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	target: LocalizationTargetName,
	entries: Schema.Array(
		Schema.Struct({
			culture: CultureCode,
			namespace: TextNamespace,
			key: TextKey,
			state: LocalizationState
		})
	)
});
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();

describe.skipIf(!executable)("real saved-reader localization states", () => {
	it("matches every committed intent entry exactly with no extra scoped identities", async () => {
		if (executable === undefined) throw new Error("The saved reader is not configured.");
		const corpus = await Effect.runPromise(
			scanTextCorpus({ projectRoot: fixture.root }).pipe(
				Effect.provide(assetReaderLayer({ executable }))
			)
		);
		const files = await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* LocalizationEvidence;
				const discovery = yield* service.discover({ projectRoot: fixture.root });
				const target = discovery.targets.find((item) => item.name === "FixtureGame");
				if (!target) throw new Error("FixtureGame was not discovered.");
				return yield* service.read({ projectRoot: fixture.root, target });
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		);
		const expected = Schema.decodeUnknownSync(Schema.fromJsonString(ExpectedStates))(
			await readFile(
				resolve(fixture.root, "FixtureSource/Localization/expected-states.json"),
				"utf8"
			)
		);
		expect(
			corpus.units.find(
				(unit) =>
					unit.identity.status === "resolved" &&
					unit.identity.namespace === "Fixture.Localization.Table" &&
					unit.identity.key === "Welcome"
			)?.occurrences[0]?.devNotes
		).toContain("Greeting on the start screen.");
		// The intent covers the localization assets plus the explicitly excluded generic String Table.
		// Other fixture domains are outside this scenario; scope by physical inputs, never oracle keys.
		const scoped = {
			...corpus,
			units: corpus.units.filter((unit) =>
				unit.occurrences.some(
					(occurrence) =>
						occurrence.packageFile
							.replace(/\\/gu, "/")
							.startsWith("Content/Fixture/Localization/") ||
						(occurrence.location.kind === "string_table_entry" &&
							occurrence.location.objectPath === "/Game/Fixture/Text/ST_Game.ST_Game")
				)
			)
		};
		const joined = joinLocalizationTarget(scoped, files, files.target);
		const actual = joined.lines.flatMap((line) => {
			if (!line.identity)
				throw new Error("The scoped fixture has an unresolved localization identity.");
			const identity = line.identity;
			return line.cultures.map((culture) => ({
				culture: culture.culture,
				namespace: identity.namespace,
				key: identity.key,
				state: culture.state
			}));
		});
		const ordered = (entries: typeof expected.entries) =>
			[...entries].sort((a, b) =>
				JSON.stringify([a.culture, a.namespace, a.key]).localeCompare(
					JSON.stringify([b.culture, b.namespace, b.key])
				)
			);
		expect(actual).toHaveLength(expected.entries.length);
		expect(ordered(actual)).toEqual(ordered(expected.entries));
	});
});
