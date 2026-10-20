import { parseJsonObject, type JsonObject } from "./json.ts";

function withoutJsonComments(contents: string) {
	let result = "";
	let inString = false;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (let index = 0; index < contents.length; index += 1) {
		const character = contents[index];
		const next = contents[index + 1];
		if (lineComment) {
			if (character === "\n" || character === "\r") {
				lineComment = false;
				result += character;
			} else result += " ";
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				result += "  ";
				index += 1;
				blockComment = false;
			} else result += character === "\n" || character === "\r" ? character : " ";
			continue;
		}
		if (inString) {
			result += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			result += character;
		} else if (character === "/" && next === "/") {
			lineComment = true;
			result += "  ";
			index += 1;
		} else if (character === "/" && next === "*") {
			blockComment = true;
			result += "  ";
			index += 1;
		} else result += character;
	}
	return result;
}

function withoutTrailingCommas(contents: string) {
	let result = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < contents.length; index += 1) {
		const character = contents[index];
		if (inString) {
			result += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		if (character === ",") {
			let nextIndex = index + 1;
			while (/\s/.test(contents[nextIndex] ?? "")) nextIndex += 1;
			if (contents[nextIndex] === "]" || contents[nextIndex] === "}") continue;
		}
		result += character;
	}
	return result;
}

export function parseUnrealDescriptor(contents: string): JsonObject {
	const withoutBom = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
	return parseJsonObject(withoutTrailingCommas(withoutJsonComments(withoutBom)));
}
