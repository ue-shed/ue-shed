/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- This test mutates decoded JSON at every path to compare the frame walk with its schema; it works on representations by design. */
import { UAssetIoEvent } from "@ue-shed/protocol";
import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { isValidProjectIndexDictionaryPageEvent } from "./project-index-wire-validation.js";

// The schema the hand walk stands in for: the exact type side the protocol stream validates.
const validateTypeSide = Schema.decodeUnknownExit(Schema.toType(UAssetIoEvent), {
	onExcessProperty: "error"
});

function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}

const validEvent = () => ({
	contract: { name: "uasset-io", version: { major: 1, minor: 27 } },
	kind: "result",
	requestId: "request-1",
	sequence: 1,
	result: {
		kind: "project_index_dictionary_page",
		page: {
			generation: 3,
			items: [
				{ kind: "map", mapPath: "Content/L.umap", packageName: "/Game/L" },
				{
					kind: "header",
					packageName: "/Game/A",
					packagePath: "Content/A.uasset",
					classes: [0],
					serializedNames: [1, 0],
					headerData: {
						packageFlags: 4,
						gatherableTextDataCount: 1,
						gatherableTextDataOffset: 9,
						hasTextProperty: true
					}
				},
				{ kind: "header", packageName: "/Game/B", packagePath: "Content/B.uasset" },
				{ kind: "inventory", packagePath: "Content/C.uasset", signature: "s" },
				{
					kind: "package",
					classes: [0],
					dependencies: [
						{ package: 1, packagePath: 0, hard: true, game: false, build: false },
						{ package: 0, hard: false, game: true, build: true }
					],
					failure: "header_unreadable",
					packageName: "/Game/D",
					packagePath: "Content/D.uasset"
				}
			],
			nextCursor: "Content/D.uasset",
			projectId: "fixture",
			strings: ["/Script/Engine.DataTable", "TextProperty"]
		}
	}
});

type Path = readonly (string | number)[];

/** Every path to a value in `value`, so each can be replaced or removed. */
function paths(value: unknown, prefix: Path = []): Path[] {
	const found: Path[] = [prefix];
	if (Array.isArray(value))
		value.forEach((entry, index) => found.push(...paths(entry, [...prefix, index])));
	else if (typeof value === "object" && value !== null)
		for (const [key, entry] of Object.entries(value))
			found.push(...paths(entry, [...prefix, key]));
	return found;
}

const replacements: readonly unknown[] = [
	undefined,
	null,
	"",
	" padded",
	"padded ",
	" nbsp",
	"text",
	"Content/X.uasset",
	"uasset-io",
	"result",
	"map",
	"header",
	"inventory",
	"package",
	"project_index_dictionary_page",
	"project_index_page",
	0,
	1,
	-1,
	0.5,
	2 ** 53,
	27,
	1_000,
	true,
	false,
	[],
	[0],
	[-1],
	["text"],
	Array.from({ length: 65 }, () => 0),
	Array.from({ length: 64 }, () => 0),
	{},
	{ extra: 1 }
];

function mutate(event: unknown, path: Path, replacement: unknown, mode: number): unknown {
	const copy = structuredClone(event);
	if (path.length === 0) return replacement;
	let parent: unknown = copy;
	for (const key of path.slice(0, -1)) {
		// The first mutation may have removed or replaced the path to the second.
		if (typeof parent !== "object" || parent === null) return copy;
		parent = (parent as Record<string | number, unknown>)[key];
	}
	if (typeof parent !== "object" || parent === null) return copy;
	const last = path.at(-1)!;
	const target = parent as Record<string | number, unknown>;
	if (mode === 0) delete target[last];
	else if (mode === 1) target[last] = replacement;
	else if (typeof parent === "object" && parent !== null && !Array.isArray(parent))
		target[`extra${String(last)}`] = replacement;
	else target[last] = replacement;
	return copy;
}

describe("dictionary page frame validation", () => {
	it("accepts only frames the exact schema accepts, and every valid frame", () => {
		const base = validEvent();
		expect(Exit.isSuccess(validateTypeSide(base))).toBe(true);
		expect(isValidProjectIndexDictionaryPageEvent(base)).toBe(true);
		const next = random(127);
		let accepted = 0;
		let rejected = 0;
		const all = paths(base);
		for (const path of all)
			for (const replacement of replacements)
				for (const mode of [0, 1, 2]) {
					const input = mutate(base, path, replacement, mode);
					// Mutate a second place now and then, so combinations are covered too.
					const twice =
						next() < 0.3
							? mutate(
									input,
									all[Math.floor(next() * all.length)]!,
									replacements[Math.floor(next() * replacements.length)],
									Math.floor(next() * 3)
								)
							: input;
					for (const candidate of [input, twice]) {
						let expected: boolean;
						try {
							expected = Exit.isSuccess(validateTypeSide(candidate));
						} catch {
							expected = false;
						}
						const actual = isValidProjectIndexDictionaryPageEvent(candidate);
						if (actual !== expected)
							throw new Error(
								`walk ${actual}, schema ${expected}: ${JSON.stringify(candidate)}`
							);
						if (expected) accepted += 1;
						else rejected += 1;
					}
				}
		expect(accepted).toBeGreaterThan(100);
		expect(rejected).toBeGreaterThan(1_000);
	});

	it("bounds pages, strings and references as the schema does", () => {
		const event = validEvent();
		const page = event.result.page as { items: unknown[]; strings: string[] };
		const check = (value: unknown) => {
			const expected = Exit.isSuccess(validateTypeSide(value));
			expect(isValidProjectIndexDictionaryPageEvent(value)).toBe(expected);
			return expected;
		};
		expect(check(event)).toBe(true);
		page.items = Array.from({ length: 1_024 }, () => page.items[2]);
		expect(check(event)).toBe(true);
		page.items.push(page.items[2]);
		expect(check(event)).toBe(false);
		page.items.length = 1;
		page.strings = Array.from({ length: 131_072 }, () => "s");
		expect(check(event)).toBe(true);
		page.strings.push("s");
		expect(check(event)).toBe(false);
	});

	it("leaves other frames to the schema", () => {
		const event = validEvent();
		expect(
			isValidProjectIndexDictionaryPageEvent({
				...event,
				result: { kind: "project_index_page", page: event.result.page }
			})
		).toBe(false);
		expect(
			isValidProjectIndexDictionaryPageEvent({
				contract: event.contract,
				kind: "completed",
				outcome: "complete",
				requestId: "request-1",
				sequence: 2
			})
		).toBe(false);
	});
});
