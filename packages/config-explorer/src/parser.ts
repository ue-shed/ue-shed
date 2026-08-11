import type { ParsedConfigCommand, ParsedConfigFile } from "./merge.js";
import type { ConfigKey, ConfigOperation, ConfigSection, ConfigSource } from "./schema.js";

const OPERATIONS: Readonly<Record<string, ConfigOperation>> = {
	"": "set",
	"+": "add_unique",
	".": "append",
	"-": "remove",
	"!": "clear",
	"^": "initialize_empty"
};

function equalsConfigName(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function quotedValue(input: string): { readonly value?: string; readonly malformed: boolean } {
	if (!input.startsWith('"')) return { value: input, malformed: false };
	let value = "";
	let escaped = false;
	for (let index = 1; index < input.length; index++) {
		const character = input[index]!;
		if (escaped) {
			value +=
				character === "n"
					? "\n"
					: character === "r"
						? "\r"
						: character === "t"
							? "\t"
							: character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') {
			const trailing = input.slice(index + 1).trim();
			return { value, malformed: trailing !== "" && !trailing.startsWith("//") };
		}
		value += character;
	}
	return { malformed: true };
}

function withoutDoubleSlashComment(input: string): string {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < input.length - 1; index++) {
		const character = input[index]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quoted) {
			escaped = true;
			continue;
		}
		if (character === '"') quoted = !quoted;
		if (!quoted && character === "/" && input[index + 1] === "/") {
			return input.slice(0, index).trimEnd();
		}
	}
	return input;
}

function curlyDepth(input: string): number {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (const character of withoutDoubleSlashComment(input)) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quoted) {
			escaped = true;
			continue;
		}
		if (character === '"') quoted = !quoted;
		if (!quoted && character === "{") depth++;
		if (!quoted && character === "}") depth--;
	}
	return depth;
}

export function parseConfigFile(options: {
	readonly text: string;
	readonly source: ConfigSource;
	readonly section: ConfigSection;
	readonly key: ConfigKey;
}): ParsedConfigFile {
	const commands: ParsedConfigCommand[] = [];
	const diagnostics: ParsedConfigFile["diagnostics"][number][] = [];
	const lines = options.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	let currentSection: string | undefined;
	let skipContinuation = false;
	let bracketDepth = 0;

	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index]!;
		const trimmed = raw.trim();
		if (skipContinuation) {
			skipContinuation = raw.trimEnd().endsWith("\\");
			continue;
		}
		if (bracketDepth > 0) {
			bracketDepth += curlyDepth(raw);
			continue;
		}
		if (trimmed === "" || trimmed.startsWith(";") || trimmed.startsWith("//")) continue;
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			currentSection = trimmed.slice(1, -1);
			continue;
		}
		if (!equalsConfigName(currentSection ?? "", options.section)) continue;
		const column = raw.search(/\S/u) + 1;
		if (raw.trimEnd().endsWith("\\")) {
			diagnostics.push({
				code: "unsupported_multiline",
				message:
					"Escaped or bracketed multiline config values are not supported in this slice.",
				source: options.source,
				location: { line: index + 1, column }
			});
			skipContinuation = true;
			continue;
		}

		const equals = trimmed.indexOf("=");
		const first = trimmed[0] ?? "";
		const prefix = "+.-!^@*~".includes(first) ? first : "";
		const rawKey = (equals === -1 ? trimmed : trimmed.slice(0, equals))
			.slice(prefix === "" ? 0 : 1)
			.trim();
		if (!equalsConfigName(rawKey, options.key)) continue;
		if (prefix === "@" || prefix === "*") {
			diagnostics.push({
				code: "unsupported_operator",
				message: `${prefix} keyed-array metadata requires semantics outside this slice.`,
				source: options.source,
				location: { line: index + 1, column }
			});
			continue;
		}
		if (equals === -1) {
			diagnostics.push({
				code: "malformed_entry",
				message: "The selected config entry has no equals delimiter.",
				source: options.source,
				location: { line: index + 1, column }
			});
			continue;
		}
		const rawValue = trimmed.slice(equals + 1).trim();
		bracketDepth = curlyDepth(rawValue);
		if (bracketDepth > 0) {
			diagnostics.push({
				code: "unsupported_multiline",
				message: "Bracketed multiline config values are not supported in this slice.",
				source: options.source,
				location: { line: index + 1, column }
			});
			continue;
		}
		const parsed = quotedValue(withoutDoubleSlashComment(rawValue));
		if (parsed.malformed || parsed.value === undefined) {
			diagnostics.push({
				code: "malformed_entry",
				message: "The selected config entry has an unterminated or malformed quoted value.",
				source: options.source,
				location: { line: index + 1, column }
			});
			continue;
		}
		commands.push({
			source: options.source,
			location: { line: index + 1, column },
			operation: OPERATIONS[prefix === "~" ? "" : prefix]!,
			...(prefix === "!" || prefix === "^" ? {} : { value: parsed.value })
		});
	}
	return { commands, diagnostics };
}

/** Detects redirect evidence that can rename the selected section or key during UE load. */
export function configRedirectAffects(options: {
	readonly text: string;
	readonly section: ConfigSection;
	readonly key: ConfigKey;
}): boolean {
	let currentSection = "";
	const relatedSections = new Set([options.section.toLowerCase()]);
	const entries: { readonly section: string; readonly from: string; readonly to: string }[] = [];
	for (const raw of options.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
		const line = withoutDoubleSlashComment(raw).trim();
		if (line === "" || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			currentSection = line.slice(1, -1);
			continue;
		}
		const equals = line.indexOf("=");
		if (equals === -1) continue;
		entries.push({
			section: currentSection,
			from: line.slice(0, equals).trim(),
			to: line.slice(equals + 1).trim()
		});
	}
	for (const entry of entries) {
		if (!equalsConfigName(entry.section, "SectionNameRemap")) continue;
		if (
			relatedSections.has(entry.from.toLowerCase()) ||
			relatedSections.has(entry.to.toLowerCase())
		) {
			relatedSections.add(entry.from.toLowerCase());
			relatedSections.add(entry.to.toLowerCase());
		}
	}
	return (
		entries.some(
			(entry) =>
				!equalsConfigName(entry.section, "SectionNameRemap") &&
				relatedSections.has(entry.section.toLowerCase()) &&
				(equalsConfigName(entry.from, options.key) ||
					equalsConfigName(entry.to, options.key))
		) || relatedSections.size > 1
	);
}
