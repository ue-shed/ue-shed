import { describe, expect, it } from "vitest";
import { nativeEvaluateRows } from "../native-rule-reports.test-support.js";
import { exampleRules, optInRules } from "./catalogue.js";

type Rows = Parameters<typeof nativeEvaluateRows>[1];
/** One catalogue rule, enabled, evaluated natively over every row given. */
const evaluate = (id: string, rows: Rows, params?: Readonly<Record<string, number>>) => {
	const rule = [...exampleRules, ...optInRules].find((candidate) => candidate.id === id)!;
	const result = nativeEvaluateRows(
		{
			schemaVersion: 4,
			roles: [],
			rules: [{ ...rule, enabled: true, params: { ...rule.params, ...params } }]
		},
		rows
	);
	return result.findings.map(({ row, actual }) => ({ row, actual }));
};
const identity = (key: string) => ({ namespace: "", key });
const line = (
	source: string,
	key: string | null,
	joinPosition: number | null,
	duplicateSites: readonly string[]
) => ({
	source,
	identity: key === null ? null : identity(key),
	joinPosition,
	allOutside: false,
	conflicting: false,
	duplicateSites,
	sourceCulture: "en"
});

describe("group rules", () => {
	it("reports a shared source once, on its first identity, with others elsewhere", () => {
		const rows = [
			line("Start", "B", 0, ["p1"]),
			line("Start", "A", 1, ["p2"]),
			// Without a saved place, a line has one of its own.
			line("Start", "C", 2, []),
			// Outside the join, number-only, alone, or every identity at one place: not counted.
			line("Start", "D", null, ["p3"]),
			line("12", "E", 3, ["p4"]),
			line("Solo", "F", 4, ["p5"]),
			line("Same place", "G", 5, ["p6"]),
			line("Same place", "H", 6, ["p6"])
		];
		expect(
			evaluate("duplicate_source", {
				line: rows.map((fields) => ({ fields, occurrences: [] }))
			})
		).toEqual([
			{
				row: 1,
				actual: {
					source: "Start",
					identityCount: 3,
					identities: [identity("A"), identity("B"), identity("C")]
				}
			}
		]);
	});
	it("gives each line without a saved place a place of its own", () => {
		// Joined with a separator, these two identities would read the same.
		const pair = [
			{ namespace: "a\u0000b", key: "c" },
			{ namespace: "a", key: "b\u0000c" }
		].map((identity, position) => ({
			fields: { ...line("Pair", "unused", position, []), identity },
			occurrences: []
		}));
		expect(evaluate("duplicate_source", { line: pair })).toEqual([
			{
				row: 1,
				actual: {
					source: "Pair",
					identityCount: 2,
					identities: [pair[1]!.fields.identity, pair[0]!.fields.identity]
				}
			}
		]);
	});
	it("reports the lines that leave the culture's most used translation", () => {
		const culture = (
			key: string,
			name: string,
			latest: string,
			isNative = false,
			source = "Milk"
		) => {
			const shared = line(source, key, key.charCodeAt(0), [`p${key}`]);
			return {
				fields: {
					...Object.fromEntries(
						Object.entries(shared).map(([field, value]) => [`line.${field}`, value])
					),
					culture: name,
					isNative,
					latest
				},
				occurrences: []
			};
		};
		const findings = evaluate("inconsistent_translation", {
			line_culture: [
				culture("A", "de", "Milch"),
				culture("A", "en", "Milk", true),
				culture("B", "de", "milch!"),
				culture("C", "de", "Milch"),
				culture("D", "de", "Leche")
			]
		});
		expect(findings).toEqual([
			{
				row: 4,
				actual: {
					translation: "Leche",
					variants: [
						{ translation: "Milch", lines: 3 },
						{ translation: "Leche", lines: 1 }
					],
					variantCount: 2
				}
			}
		]);
		// Five words are a sentence by default, often translated to fit its scene.
		const sentence = "Open the old harbour gate";
		const sentences = ["Öffne das Tor", "Öffne das Tor", "Tor öffnen"].map((latest, index) =>
			culture("ABC"[index]!, "de", latest, false, sentence)
		);
		expect(evaluate("inconsistent_translation", { line_culture: sentences })).toEqual([]);
		expect(
			evaluate("inconsistent_translation", { line_culture: sentences }, { maximumWords: 5 })
		).toMatchObject([{ row: 2, actual: { translation: "Tor öffnen" } }]);
	});
	it("reports keyless invariant text where its property is localizable elsewhere", () => {
		const occurrence = (
			objectPath: string,
			propertyPath: string,
			status: "resolved" | "unresolved"
		) => ({
			id: `occurrence:${objectPath}:${propertyPath}`,
			packageFile: "Content/UI.uasset",
			location: {
				kind: "asset_property",
				objectPath,
				classPath: "/Script/UMG.TextBlock",
				propertyPath
			},
			audience: "player",
			unitStatus: status,
			unresolvedReason: status === "unresolved" ? "culture_invariant" : null
		});
		const keyless = (source: string, place: ReturnType<typeof occurrence>) => ({
			fields: { source, identity: null, sourceCulture: "en" },
			occurrences: [place]
		});
		const findings = evaluate("culture_invariant_text", {
			line: [
				keyless(
					"Shop",
					occurrence("/Game/UI/Menu.Menu:Title", "Items[0].Text", "unresolved")
				),
				// The same property once the container index is removed, and localizable here.
				{
					fields: { source: "Inventory", identity: identity("K"), sourceCulture: "en" },
					occurrences: [occurrence("/Game/UI/Bag.Bag:Title", "Items[3].Text", "resolved")]
				},
				// Debug content, and a property with no localizable text.
				keyless(
					"Spawner",
					occurrence("/Game/Debug/Menu.Menu:Title", "Items[1].Text", "unresolved")
				),
				keyless("Distance", occurrence("/Game/UI/Menu.Menu:Label", "Tooltip", "unresolved"))
			]
		});
		expect(findings).toEqual([{ row: 0, actual: { source: "Shop" } }]);
	});
	it("opts in to shared and long text", () => {
		const saved = (id: string, source: string) => ({
			id,
			packageFile: "Content/UI.uasset",
			source
		});
		const rows = [
			{
				fields: { sourceCulture: "en" },
				occurrences: [saved("a1", "a"), saved("a2", "a")]
			},
			{ fields: { sourceCulture: "en" }, occurrences: [saved("b", "x".repeat(40))] }
		];
		expect(evaluate("shared", { line: rows })).toEqual([
			{ row: 0, actual: { occurrences: 2 } }
		]);
		expect(evaluate("long", { line: rows })).toEqual([{ row: 1, actual: { length: 40 } }]);
	});
});
