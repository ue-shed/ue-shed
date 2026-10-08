import { Schema } from "effect";
import type { CultureCode } from "@ue-shed/localization/browser";
import { unrealPluralForms } from "./unreal-plural-forms.js";
export { unrealPluralForms } from "./unreal-plural-forms.js";

export const UnrealModifierName = Schema.Literals(["plural", "ordinal", "gender", "hpp"]);
export type UnrealModifierName = typeof UnrealModifierName.Type;
export const UnrealFormatIssue = Schema.Struct({
	code: Schema.Literals([
		"malformed_modifier",
		"unexpected_modifier",
		"missing_form",
		"unused_form",
		"redundant_modifier",
		"unsupported_culture",
		"syntax_limit"
	]),
	modifier: Schema.NullOr(UnrealModifierName),
	argument: Schema.NullOr(Schema.String),
	forms: Schema.Array(Schema.String),
	position: Schema.Int
});
export type UnrealFormatIssue = typeof UnrealFormatIssue.Type;
export const UnrealArgument = Schema.Struct({
	name: Schema.String,
	start: Schema.Int,
	end: Schema.Int
});
export type UnrealArgument = typeof UnrealArgument.Type;
const ModifierForm = Schema.Struct({ name: Schema.String, value: Schema.String });
type ModifierForm = typeof ModifierForm.Type;
export const UnrealModifier = Schema.Struct({
	name: UnrealModifierName,
	argument: Schema.NullOr(Schema.String),
	forms: Schema.Array(ModifierForm),
	start: Schema.Int,
	end: Schema.Int,
	depth: Schema.Int
});
export type UnrealModifier = typeof UnrealModifier.Type;
export const UnrealModifierIdentity = UnrealModifier.mapFields((fields) => ({
	argument: fields.argument,
	name: fields.name
}));
export type UnrealModifierIdentity = typeof UnrealModifierIdentity.Type;
export const UnrealFormatPattern = Schema.Struct({
	compiled: Schema.NullOr(Schema.Boolean),
	arguments: Schema.Array(UnrealArgument),
	modifiers: Schema.Array(UnrealModifier),
	issues: Schema.Array(UnrealFormatIssue)
});
export type UnrealFormatPattern = typeof UnrealFormatPattern.Type;

const quotedValue = Schema.Struct({ value: Schema.String, end: Schema.Int });
type QuotedValue = typeof quotedValue.Type;

// FParse quoted values use C-style escapes; format-pattern escaping itself uses backticks.
function parseQuoted(text: string, start: number): QuotedValue | undefined {
	let value = "";
	for (let i = start + 1; i < text.length; i++) {
		const char = text[i];
		if (char === '"') return { value, end: i + 1 };
		if (char === "\r" || char === "\n") return undefined;
		if (char !== "\\") {
			value += char;
			continue;
		}
		const escaped = text[++i];
		if (escaped === undefined) return undefined;
		switch (escaped) {
			case "n":
				value += "\n";
				break;
			case "r":
				value += "\r";
				break;
			case "t":
				value += "\t";
				break;
			case "x":
			case "u":
			case "U": {
				const maximum = escaped === "u" ? 4 : escaped === "U" ? 8 : text.length;
				const digits = text
					.slice(i + 1)
					.match(/^[0-9a-f]+/iu)?.[0]
					?.slice(0, maximum);
				if (!digits) {
					value += `\\${escaped}`;
					break;
				}
				const code = Number.parseInt(digits, 16);
				value +=
					escaped === "U" && code <= 0x10ffff
						? String.fromCodePoint(code)
						: String.fromCharCode(code);
				i += digits.length;
				break;
			}
			default: {
				const digits = text.slice(i).match(/^[0-7]{1,3}/u)?.[0];
				if (digits) {
					value += String.fromCharCode(Number.parseInt(digits, 8));
					i += digits.length - 1;
				} else value += "\\\"'".includes(escaped) ? escaped : `\\${escaped}`;
			}
		}
	}
	return undefined;
}

function modifierEnd(text: string, start: number): number {
	let quoted = false;
	let slashes = 0;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (char === ")" && !quoted) return i;
		if (char === '"' && (!quoted || slashes % 2 === 0)) quoted = !quoted;
		slashes = char === "\\" ? slashes + 1 : 0;
	}
	return -1;
}

function modifierForms(text: string, keyed: boolean): readonly ModifierForm[] | undefined {
	const forms: ModifierForm[] = [];
	let i = 0;
	const skip = () => {
		while (/\s/u.test(text[i] ?? "") && i < text.length) i++;
	};
	skip();
	while (i < text.length) {
		let name = String(forms.length);
		if (keyed) {
			name = text.slice(i).match(/^[\p{L}\p{N}_]+/u)?.[0] ?? "";
			if (!name) return undefined;
			i += name.length;
			skip();
			if (text[i++] !== "=") return undefined;
			skip();
		}
		let value = "";
		const quoted = text[i] === '"' ? parseQuoted(text, i) : undefined;
		if (quoted) {
			value = quoted.value;
			i = quoted.end;
		} else {
			const end = text.indexOf(",", i);
			const stop = end < 0 ? text.length : end;
			value = text.slice(i, stop);
			i = stop;
		}
		if (!value) return undefined;
		skip();
		if (i < text.length && text[i++] !== ",") return undefined;
		const previous = forms.findIndex((form) => form.name === name);
		if (previous >= 0) forms.splice(previous, 1);
		forms.push({ name, value });
		skip();
	}
	return forms;
}

/** Lexer semantics verified in both supported engines. Unrecognized modifiers remain literals. */
export function parseUnrealFormatPattern(text: string, culture: CultureCode): UnrealFormatPattern {
	return parsePattern(text, culture, 0);
}

function parsePattern(text: string, culture: CultureCode, depth: number): UnrealFormatPattern {
	const args: UnrealArgument[] = [];
	const modifiers: UnrealModifier[] = [];
	const issues: UnrealFormatIssue[] = [];
	if (depth > 16 || text.length > 1_000_000)
		return {
			compiled: null,
			arguments: args,
			modifiers,
			issues: [
				{ code: "syntax_limit", modifier: null, argument: null, forms: [], position: 0 }
			]
		};
	let previousArgument: string | null = null;
	let compilationFailed = false;
	for (let i = 0; i < text.length; ) {
		if (text[i] === "`" && "`{}|".includes(text[i + 1] ?? "\u0000")) {
			i += 2;
			previousArgument = null;
			continue;
		}
		if (text[i] === "{") {
			const end = text.indexOf("}", i + 1);
			if (end > i + 1) {
				previousArgument = text.slice(i + 1, end);
				args.push({ name: previousArgument, start: i, end: end + 1 });
				i = end + 1;
				continue;
			}
		}
		const prefix =
			text[i] === "|" ? /^\|(plural|ordinal|gender|hpp)\(/u.exec(text.slice(i)) : null;
		const nameResult = Schema.decodeUnknownOption(UnrealModifierName)(prefix?.[1]);
		if (prefix && nameResult._tag === "Some") {
			const name = nameResult.value;
			const start = i + prefix[0].length;
			const end = modifierEnd(text, start);
			const forms =
				end >= 0
					? modifierForms(text.slice(start, end), name === "plural" || name === "ordinal")
					: undefined;
			const arityValid =
				forms !== undefined &&
				(name === "plural" ||
					name === "ordinal" ||
					(name === "gender"
						? forms.length === 2 || forms.length === 3
						: forms.length === 2));
			if (forms && arityValid) {
				const children =
					name === "hpp"
						? []
						: forms.map((form) => parsePattern(form.value, culture, depth + 1));
				// Failed required children make a modifier literal. Gender's optional third form
				// is retained by Unreal even when it fails; validation reports that failure later.
				const requiredChildren = name === "gender" ? children.slice(0, 2) : children;
				if (!requiredChildren.some((child) => child.compiled === false)) {
					modifiers.push({
						name,
						argument: previousArgument,
						forms,
						start: i,
						end: end + 1,
						depth
					});
					if (previousArgument === null) {
						compilationFailed = true;
						issues.push({
							code: "unexpected_modifier",
							modifier: name,
							argument: null,
							forms: [],
							position: i
						});
					}
					for (const [childIndex, child] of children.entries()) {
						if (
							(name === "plural" || name === "ordinal") &&
							!["zero", "one", "two", "few", "many", "other"].includes(
								forms[childIndex]?.name ?? ""
							)
						)
							continue;
						// Nested offsets belong to decoded form values, and are never used for automatic renames.
						args.push(
							...child.arguments.map((arg) => ({ ...arg, start: -1, end: -1 }))
						);
						modifiers.push(...child.modifiers);
						issues.push(...child.issues);
					}
					if (name === "plural" || name === "ordinal") {
						const required = unrealPluralForms(
							culture,
							name === "plural" ? "cardinal" : "ordinal"
						);
						const given = forms
							.filter((form) => form.value.length > 0)
							.map((form) => form.name);
						const report = (
							code: UnrealFormatIssue["code"],
							names: readonly string[]
						) =>
							issues.push({
								code,
								modifier: name,
								argument: previousArgument,
								forms: names,
								position: i
							});
						if (!required) report("unsupported_culture", []);
						else {
							if (required.length === 1) report("redundant_modifier", []);
							const missing = required.filter((form) => !given.includes(form));
							const unused = given.filter(
								(form) =>
									["zero", "one", "two", "few", "many", "other"].includes(form) &&
									!required.some((valid) => valid === form)
							);
							if (missing.length) report("missing_form", missing);
							if (required.length > 1 && unused.length) report("unused_form", unused);
						}
					}
					i = end + 1;
					previousArgument = null;
					continue;
				}
			}
			issues.push({
				code: "malformed_modifier",
				modifier: name,
				argument: previousArgument,
				forms: [],
				position: i
			});
		}
		// A literal consumes pipes until the next potential argument or escape token.
		previousArgument = null;
		i++;
		while (i < text.length && text[i] !== "{" && text[i] !== "`") i++;
	}
	// Unreal discards the compiled expression when a recognized modifier has no argument.
	return {
		compiled: compilationFailed
			? false
			: issues.some((issue) => issue.code === "syntax_limit")
				? null
				: true,
		arguments: compilationFailed ? [] : args,
		modifiers,
		issues
	};
}

export const UnrealRichTextCounts = Schema.Struct({ opening: Schema.Int, closing: Schema.Int });
export type UnrealRichTextCounts = typeof UnrealRichTextCounts.Type;

/** Compile validation counts raw delimiters, before Slate entity unescaping or rendering. */
export function unrealRichTextCounts(text: string): UnrealRichTextCounts {
	let opening = 0;
	let closing = 0;
	let start = -1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "<") start = i;
		else if (start >= 0 && text[i] === ">") {
			const body = text.slice(start + 1, i);
			if (body === "/") closing++;
			else if (!body.endsWith("/") && body !== "br") opening++;
			start = -1;
		}
	}
	return { opening, closing };
}

export function unrealRichTextValid(source: string, translation: string): boolean {
	const actual = unrealRichTextCounts(translation);
	const expected = unrealRichTextCounts(source);
	return (
		actual.opening === actual.closing ||
		(actual.opening === expected.opening && actual.closing === expected.closing)
	);
}

export const UnrealWhitespace = Schema.Struct({
	leading: Schema.String,
	trailing: Schema.String,
	lineBreaks: Schema.Int
});
export type UnrealWhitespace = typeof UnrealWhitespace.Type;

// FTextChar uses ICU's Java-style whitespace, which excludes the three non-breaking spaces.
export function unrealWhitespace(text: string): UnrealWhitespace {
	return {
		leading:
			text.match(
				/^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*/u
			)?.[0] ?? "",
		trailing:
			text.match(
				/[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/u
			)?.[0] ?? "",
		lineBreaks: [...text.matchAll(/\r\n|\r|\n/gu)].length
	};
}

export function unrealUnsafeWhitespace(text: string): boolean {
	const boundary = (char: string) =>
		char !== "\r" &&
		char !== "\n" &&
		/^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]$/u.test(
			char
		);
	return boundary(text[0] ?? "") || boundary(text.at(-1) ?? "");
}
