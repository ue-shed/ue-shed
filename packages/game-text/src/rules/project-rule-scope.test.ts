import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { GameTextRuleDocument } from "../game-text-rules.js";
import { LocalizationCheckScope } from "../localization-check-scope.js";
import { nativeEvaluateRows } from "../native-rule-reports.test-support.js";
import { effectiveRuleDocument } from "./effective.js";

type Rows = Parameters<typeof nativeEvaluateRows>[1];
type Scope = typeof LocalizationCheckScope.Encoded;
const place = (objectPath: string) => ({
	id: `occurrence:${objectPath}`,
	packageFile: "Content/Place.uasset",
	location: {
		kind: "asset_property",
		objectPath,
		classPath: "/Script/UMG.TextBlock",
		propertyPath: "Text"
	},
	audience: "player",
	unitStatus: "resolved",
	unresolvedReason: null
});
type Place = ReturnType<typeof place>;
const menu = place("/Game/UI/Menu.Menu"),
	shop = place("/Game/UI/Shop/Item.Item"),
	map = place("/Game/World/Map.Map");
/** Each finding's affected occurrences, for a file whose one rule is for the `ui` role. */
const affected =
	<Rule extends object>(rule: Rule, rows: (places: readonly Place[]) => Rows) =>
	(places: readonly Place[]) =>
		nativeEvaluateRows(
			effectiveRuleDocument(
				Schema.decodeUnknownSync(GameTextRuleDocument)({
					schemaVersion: 1,
					roles: [
						{
							id: "ui",
							scopes: [
								{
									matchers: [
										{
											kind: "object_path",
											operator: "prefix",
											value: "/Game/UI/"
										}
									]
								}
							]
						}
					],
					rules: [rule]
				})
			),
			rows(places)
		).findings.map((finding) => finding.affected.map(({ id }) => id));

describe("a project rule's scope", () => {
	const source = (scope?: Scope) =>
		affected(
			{
				kind: "character_budget",
				id: "budget",
				role: "ui",
				maximumCharacters: 1,
				recovery: "Shorten it.",
				...(scope ? { scope } : undefined)
			},
			(places) => ({
				unit_source: [{ fields: { source: "Long text" }, occurrences: places }]
			})
		);
	const translation = (scope?: Scope) =>
		affected(
			{
				kind: "localization_character_budget",
				id: "translation.budget",
				role: "ui",
				cultures: { de: 1 },
				recovery: "Shorten it.",
				...(scope ? { scope } : undefined)
			},
			(places) => ({
				line_culture: [
					{
						fields: {
							"line.identity": { namespace: "", key: "K" },
							"line.source": "Long text",
							"line.originKind": "corpus",
							culture: "de",
							latest: "Langer Text"
						},
						occurrences: places
					}
				]
			})
		);
	it.each([
		["source", source],
		["localization", translation]
	])("narrows a %s rule's role to the occurrences it admits", (_family, family) => {
		expect(family()([menu, map])).toEqual([[menu.id]]);
		// The role's place and the scope's are different occurrences, so nothing is in both.
		expect(family({ pathPrefixes: ["/Game/World/"] })([menu, map])).toEqual([]);
		expect(family({ pathPrefixes: ["/Game/UI/Shop/"] })([menu, shop, map])).toEqual([
			[shop.id]
		]);
		expect(family({ roles: ["ui"], pathPrefixes: ["/Game/World/"] })([menu, map])).toEqual([]);
	});
	it("keeps a localization rule's cultures a gate on the whole row", () => {
		expect(translation({ cultures: ["fr"] })([menu])).toEqual([]);
		expect(translation({ cultures: ["de"] })([menu])).toEqual([[menu.id]]);
	});
});
