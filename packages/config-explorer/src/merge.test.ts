import { describe, expect, it } from "vitest";
import { foldConfigCommands, type ParsedConfigCommand } from "./merge.js";
import { ConfigKey, ConfigSection, type ConfigOperation } from "./schema.js";
import { configRedirectAffects, parseConfigFile } from "./parser.js";

const source = { scope: "project" as const, path: "Config/DefaultGame.ini" };
const location = { line: 1, column: 1 };

function command(operation: ConfigOperation, value?: string): ParsedConfigCommand {
	return { source, location, operation, ...(value === undefined ? {} : { value }) };
}

describe("foldConfigCommands", () => {
	it("preserves UE set and array operation semantics with lineage", () => {
		const result = foldConfigCommands([
			command("set", "base"),
			command("add_unique", "one"),
			command("add_unique", "one"),
			command("append", "one"),
			command("remove", "one"),
			command("set", "override")
		]);

		expect(result.effectiveValue).toEqual({ kind: "array", values: ["override", "one"] });
		expect(
			result.contributions.map(({ effect, remainsEffective }) => ({
				effect,
				remainsEffective
			}))
		).toEqual([
			{ effect: { kind: "added", index: 0 }, remainsEffective: false },
			{ effect: { kind: "added", index: 1 }, remainsEffective: false },
			{ effect: { kind: "duplicate" }, remainsEffective: false },
			{ effect: { kind: "added", index: 2 }, remainsEffective: true },
			{ effect: { kind: "removed", index: 1 }, remainsEffective: true },
			{
				effect: { kind: "replaced", index: 0, previousValue: "base" },
				remainsEffective: true
			}
		]);
	});

	it("distinguishes clear from explicitly initialized empty", () => {
		const cleared = foldConfigCommands([
			command("append", "one"),
			command("clear"),
			command("remove", "missing")
		]);
		expect(cleared.effectiveValue).toEqual({ kind: "missing" });
		expect(cleared.contributions[1]?.remainsEffective).toBe(true);
		expect(cleared.contributions[2]?.effect).toEqual({ kind: "no_match" });

		const initialized = foldConfigCommands([
			command("append", "one"),
			command("initialize_empty")
		]);
		expect(initialized.effectiveValue).toEqual({ kind: "empty_array" });
		expect(initialized.contributions[1]?.remainsEffective).toBe(true);
	});
});

describe("parseConfigFile", () => {
	it("returns selected commands with source locations and case-insensitive identity", () => {
		const parsed = parseConfigFile({
			text: '; fixture\n[Fixture.Settings]\n  Value=base\n+value="with spaces"\n.value=again\n-value=base\n^Value=Empty\n',
			source,
			section: ConfigSection.make("fixture.settings"),
			key: ConfigKey.make("VALUE")
		});

		expect(parsed.diagnostics).toEqual([]);
		expect(
			parsed.commands.map(({ operation, value, location: at }) => ({ operation, value, at }))
		).toEqual([
			{ operation: "set", value: "base", at: { line: 3, column: 3 } },
			{ operation: "add_unique", value: "with spaces", at: { line: 4, column: 1 } },
			{ operation: "append", value: "again", at: { line: 5, column: 1 } },
			{ operation: "remove", value: "base", at: { line: 6, column: 1 } },
			{ operation: "initialize_empty", value: undefined, at: { line: 7, column: 1 } }
		]);
	});

	it("surfaces keyed-array and multiline syntax", () => {
		const parsed = parseConfigFile({
			text: "[Fixture.Settings]\n@Value=Id\n+Value=one\\\ncontinued\nValue={\nNested=1\n}\n",
			source,
			section: ConfigSection.make("Fixture.Settings"),
			key: ConfigKey.make("Value")
		});
		expect(parsed.commands).toEqual([]);
		expect(parsed.diagnostics.map(({ code }) => code)).toEqual([
			"unsupported_operator",
			"unsupported_multiline",
			"unsupported_multiline"
		]);
	});

	it("matches UE comment and quoted escape parsing for selected values", () => {
		const parsed = parseConfigFile({
			text: '[Fixture.Settings]\nValue=plain // comment\n.Value="quoted // value\\tend" // comment\n',
			source,
			section: ConfigSection.make("Fixture.Settings"),
			key: ConfigKey.make("Value")
		});
		expect(parsed.commands.map(({ value }) => value)).toEqual([
			"plain",
			"quoted // value\tend"
		]);
	});

	it("detects only redirects that can rename the selected identity", () => {
		const text =
			"[SectionNameRemap]\nOld.Section=Fixture.Settings\n[Old.Section]\nOldValue=Value\n[Other]\nEntries=Elsewhere\n";
		expect(
			configRedirectAffects({
				text,
				section: ConfigSection.make("Fixture.Settings"),
				key: ConfigKey.make("OldValue")
			})
		).toBe(true);
		expect(
			configRedirectAffects({
				text,
				section: ConfigSection.make("Fixture.Settings"),
				key: ConfigKey.make("Entries")
			})
		).toBe(true);
	});

	it("keeps removal lineage effective when an equal saved value is added later", () => {
		const result = foldConfigCommands([
			command("append", "same"),
			command("remove", "same"),
			command("append", "same")
		]);
		expect(result.effectiveValue).toEqual({ kind: "array", values: ["same"] });
		expect(result.contributions.map(({ remainsEffective }) => remainsEffective)).toEqual([
			false,
			true,
			true
		]);
	});
});
