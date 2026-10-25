import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	LocalizationState,
	LocalizationUnknownReason
} from "../packages/game-text/src/localization-schema.ts";
import { TextReviewSignal } from "../packages/game-text/src/schema.ts";
import { TEXT_PROBLEMS } from "../packages/game-text/src/text-problem-rules.ts";
import { TEXT_PROBLEM_RULES_PATH, renderTextProblemRules } from "./generate-text-problem-rules.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The string array `name` in a Rust source. */
function rustStrings(source: string, name: string): readonly string[] {
	const body = new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\];`, "u").exec(
		source
	)?.[1];
	if (body === undefined) throw new Error(`${name} was not found.`);
	return [...body.matchAll(/"([^"]*)"/gu)].map((match) => match[1]!);
}

describe("the shared text-problem table", () => {
	it("is what the native engine compiles", async () => {
		const written = await readFile(join(root, TEXT_PROBLEM_RULES_PATH), "utf8");
		expect(
			written.replaceAll("\r\n", "\n"),
			"Run node scripts/generate-text-problem-rules.ts"
		).toBe(renderTextProblemRules());
	});

	it("names states, reasons and facts in the engine's bit order", async () => {
		const types = await readFile(
			join(root, "crates/game-text-index/src/engine_types.rs"),
			"utf8"
		);
		expect(rustStrings(types, "STATES")).toEqual(LocalizationState.literals);
		expect(rustStrings(types, "REASONS")).toEqual(LocalizationUnknownReason.literals);
		expect(rustStrings(types, "FACTS")).toEqual(TextReviewSignal.literals);
		expect(rustStrings(renderTextProblemRules(), "PROBLEMS")).toEqual(TEXT_PROBLEMS);
	});
});
