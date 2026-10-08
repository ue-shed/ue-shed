import { describe, expect, it } from "vitest";
import { cultureCode } from "./localization.test-support.js";
import {
	parseUnrealFormatPattern,
	unrealPluralForms,
	unrealRichTextCounts,
	unrealRichTextValid,
	unrealWhitespace,
	unrealUnsafeWhitespace
} from "./unreal-text-syntax.js";

const en = cultureCode("en");
const names = (text: string) =>
	[
		...new Set(parseUnrealFormatPattern(text, en).arguments.map((argument) => argument.name))
	].sort();

describe("Unreal format grammar", () => {
	it("uses backticks and case-sensitive names, including ordered and non-identifier names", () => {
		expect(names("`{literal`} {Name} {name} {0} {a b} ``{Again} `{ignored} {")).toEqual([
			"0",
			"Again",
			"Name",
			"a b",
			"name"
		]);
		expect(names("{} `x{Kept} {a{b}")).toEqual(["Kept", "a{b"]);
		expect(parseUnrealFormatPattern("{N}`|plural(one=x,other=y)", en).modifiers).toEqual([]);
	});
	it("uses supported-engine ICU categories independently of newer host ICU", () => {
		expect(unrealPluralForms(cultureCode("fr-FR"), "cardinal")).toEqual(["one", "other"]);
		expect(unrealPluralForms(cultureCode("ru"), "cardinal")).toEqual([
			"few",
			"many",
			"one",
			"other"
		]);
		expect(unrealPluralForms(cultureCode("ar"), "cardinal")).toEqual([
			"few",
			"many",
			"one",
			"other",
			"two",
			"zero"
		]);
		expect(unrealPluralForms(cultureCode("ja"), "ordinal")).toEqual(["other"]);
	});
	it("discards arguments when compilation fails and ignores unrecognized plural category values", () => {
		expect(names("{A}|gender(He,She)|gender(He,She)")).toEqual([]);
		expect(names("{N}|plural(one=x,other=y,studio={Ignored})")).toEqual(["N"]);
	});
	it("concatenates arguments inside quoted plural forms and preserves commas and escaped quotes", () => {
		const pattern = parseUnrealFormatPattern(
			String.raw`{Count}|plural(one="{Owner}, \"quoted\"",other="{Owner} and {Other}")`,
			en
		);
		expect([...new Set(pattern.arguments.map((argument) => argument.name))].sort()).toEqual([
			"Count",
			"Other",
			"Owner"
		]);
		expect(pattern.issues).toEqual([]);
	});
	it("keeps Unreal's third gender form compilation and unrecognized quoted escape behavior", () => {
		const invalidThird = parseUnrealFormatPattern('{G}|gender(He,She,"|gender(He,She)")', en);
		expect(invalidThird.compiled).toBe(true);
		expect(invalidThird.arguments.map((argument) => argument.name)).toEqual(["G"]);
		expect(invalidThird.issues.some((issue) => issue.code === "unexpected_modifier")).toBe(
			true
		);
		const escaped = parseUnrealFormatPattern(String.raw`{N}|plural(one="\q",other="\x")`, en);
		expect(escaped.modifiers[0]?.forms.map((form) => form.value)).toEqual(["\\q", "\\x"]);
	});
	it("supports a nested modifier in a quoted form and C-style quoted value escapes", () => {
		const text = '{N}|plural(one="{G}|gender(He,She)",other="{Owner} has \\x32 items")';
		const pattern = parseUnrealFormatPattern(text, en);
		expect(pattern.modifiers.map((modifier) => modifier.name)).toEqual(["plural", "gender"]);
		expect(pattern.modifiers[0]?.forms[1]?.value).toBe("{Owner} has 2 items");
		expect(pattern.issues).toEqual([]);
	});
	it("leaves unknown modifiers and pipes embedded in literals alone", () => {
		expect(parseUnrealFormatPattern("{N}|studio(value={Other})", en).modifiers).toEqual([]);
		expect(names("{N}|studio(value={Other})")).toEqual(["N", "Other"]);
		expect(parseUnrealFormatPattern("text|plural(one=x,other=y)", en).issues).toEqual([]);
		expect(parseUnrealFormatPattern("{N} |plural(one=x,other=y)", en).modifiers).toEqual([]);
	});
	it("reports required, unused and redundant forms and distinguishes malformed from unexpected modifiers", () => {
		expect(
			parseUnrealFormatPattern("{N}|plural(one=x)", en).issues.map((issue) => issue.code)
		).toContain("missing_form");
		expect(
			parseUnrealFormatPattern("{N}|plural(one=x,few=f,other=y)", en).issues.map(
				(issue) => issue.code
			)
		).toContain("unused_form");
		expect(
			parseUnrealFormatPattern("{N}|ordinal(other=x)", cultureCode("de")).issues.map(
				(issue) => issue.code
			)
		).toContain("redundant_modifier");
		for (const text of [
			"{N}|plural(one=x,other=)",
			"{N}|gender(He)",
			"{N}|hpp(one)",
			"{N}|plural(one=x"
		]) {
			expect(parseUnrealFormatPattern(text, en).issues.map((issue) => issue.code)).toContain(
				"malformed_modifier"
			);
		}
		expect(
			parseUnrealFormatPattern("|plural(one=x,other=y)", en).issues.map((issue) => issue.code)
		).toContain("unexpected_modifier");
	});
	it("accepts two or three gender values, two hpp values, and duplicate plural keys with last-value semantics", () => {
		for (const text of [
			"{G}|gender(He,She)",
			"{G}|gender(He,She,They)",
			"{Name}|hpp(은,는)",
			"{N}|plural(one=a,one=b,other=c)"
		])
			expect(parseUnrealFormatPattern(text, en).issues).toEqual([]);
		expect(
			parseUnrealFormatPattern("{N}|plural(one=a,one=b,other=c)", en).modifiers[0]?.forms[0]
				?.value
		).toBe("b");
	});
	it("reports unsupported cultures and bounded syntax instead of assuming English", () => {
		expect(
			parseUnrealFormatPattern(
				"{N}|plural(one=x,other=y)",
				cultureCode("private-culture")
			).issues.map((issue) => issue.code)
		).toContain("unsupported_culture");
		expect(parseUnrealFormatPattern("x".repeat(1_000_001), en).issues[0]?.code).toBe(
			"syntax_limit"
		);
	});
});

describe("Unreal compile rich-text validation", () => {
	it("counts anonymous closing tags, attributes, self-closing elements and lowercase br", () => {
		expect(unrealRichTextCounts('<Style color="white">Text</><img id="x"/><br>')).toEqual({
			opening: 1,
			closing: 1
		});
		expect(unrealRichTextCounts("&lt;Style&gt;quoted&lt;/&gt;")).toEqual({
			opening: 0,
			closing: 0
		});
		expect(unrealRichTextCounts("<BR>")).toEqual({ opening: 1, closing: 0 });
	});
	it("matches the compile validator's tolerance rather than imposing a nesting policy", () => {
		expect(unrealRichTextValid("<Em>Hello</>", "<Em>Hallo")).toBe(false);
		expect(unrealRichTextValid("<Em>Hello", "<Different>Hallo")).toBe(true);
		expect(unrealRichTextValid("Hello", "</><Em>Hallo")).toBe(true);
		expect(unrealRichTextValid("Hello", '<Em title="a>b">Hallo</>')).toBe(true);
		expect(unrealRichTextCounts("<broken<Tag>Text</>")).toEqual({ opening: 1, closing: 1 });
	});
});

it("matches ICU text whitespace while retaining CR/LF boundary exceptions", () => {
	expect(unrealUnsafeWhitespace("Text\u001c")).toBe(true);
	expect(unrealUnsafeWhitespace("\r\nText\n")).toBe(false);
	expect(unrealUnsafeWhitespace("Text\u00a0")).toBe(false);
	expect(unrealUnsafeWhitespace("Text\u2007")).toBe(false);
	expect(unrealUnsafeWhitespace("Text\u202f")).toBe(false);
	expect(unrealWhitespace(" \tText\r\n\n")).toEqual({
		leading: " \t",
		trailing: "\r\n\n",
		lineBreaks: 2
	});
});
