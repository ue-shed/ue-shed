import { UAssetIoProjectIndexDictionaryPage } from "@ue-shed/protocol";
import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIndexCursor,
	ProjectIndexHeader,
	ProjectIndexInventory,
	ProjectIndexMap,
	ProjectIndexPackage,
	ProjectIndexPage
} from "./project-index.js";
import { decodeProjectIndexDictionaryPage } from "./project-index-protocol.js";

// The two-pass decoder the single pass replaced: the domain schema over the whole page, then
// reference expansion. The single pass must accept, reject and expand exactly as it did for
// every page that passed protocol validation.
const References = Schema.Array(Schema.Number).check(Schema.isMaxLength(64));
const ReferencePage = Schema.Struct({
	...ProjectIndexPage.fields,
	items: Schema.Array(
		Schema.Union([
			ProjectIndexMap,
			ProjectIndexInventory,
			Schema.Struct({
				...ProjectIndexHeader.fields,
				classes: Schema.optionalKey(References),
				serializedNames: Schema.optionalKey(References)
			}),
			Schema.Struct({
				...ProjectIndexPackage.fields,
				classes: References,
				dependencies: Schema.Array(
					Schema.Struct({
						package: Schema.Number,
						packagePath: Schema.optionalKey(Schema.Number),
						hard: Schema.Boolean,
						game: Schema.Boolean,
						build: Schema.Boolean
					})
				)
			})
		])
	).check(Schema.isMaxLength(PROJECT_INDEX_MAX_PAGE_SIZE)),
	strings: Schema.Array(ProjectIndexHeader.fields.classes.value).check(
		Schema.isMaxLength(PROJECT_INDEX_MAX_PAGE_SIZE * 128)
	)
});
const decodeReference = Schema.decodeUnknownExit(ReferencePage);
const isWirePage = Schema.is(UAssetIoProjectIndexDictionaryPage);

type Outcome = { readonly kind: "unavailable" | "reference" } | { readonly page: unknown };

function reference(input: UAssetIoProjectIndexDictionaryPage): Outcome {
	const decoded = decodeReference(input);
	if (Exit.isFailure(decoded)) return { kind: "unavailable" };
	const page = decoded.value;
	const resolve = (index: number): string => {
		const value = page.strings[index];
		if (value === undefined) throw new RangeError();
		return value;
	};
	try {
		return {
			page: {
				generation: page.generation,
				items: page.items.map((item) => {
					if (item.kind === "header")
						return {
							...item,
							classes: (item.classes ?? []).map(resolve),
							serializedNames: (item.serializedNames ?? []).map(resolve)
						};
					if (item.kind === "package")
						return {
							...item,
							classes: item.classes.map(resolve),
							dependencies: item.dependencies.map((dependency) => ({
								package: resolve(dependency.package),
								...(dependency.packagePath === undefined
									? undefined
									: { packagePath: resolve(dependency.packagePath) }),
								hard: dependency.hard,
								game: dependency.game,
								build: dependency.build
							}))
						};
					return item;
				}),
				projectId: page.projectId,
				...(page.nextCursor === undefined
					? undefined
					: { nextCursor: ProjectIndexCursor.make(page.nextCursor) })
			}
		};
	} catch {
		return { kind: "reference" };
	}
}

function singlePass(input: UAssetIoProjectIndexDictionaryPage): Outcome {
	try {
		return { page: decodeProjectIndexDictionaryPage(input) };
	} catch (cause) {
		if (cause instanceof Error && cause.message.includes("out of bounds"))
			return { kind: "reference" };
		if (cause instanceof Error && cause.message.includes("unbounded or invalid page"))
			return { kind: "unavailable" };
		throw cause;
	}
}

// A small deterministic generator: the same pages on every run.
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}

const lengths = [1, 2, 255, 256, 257, 1_023, 1_024, 1_025, 4_096, 4_097, 8_192, 8_193];
const lengths32k = [32_767, 32_768];

function makePage(next: () => number): Schema.Json {
	const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
	const text = (length: number) => "x".repeat(length);
	const sometimes = (chance: number) => next() < chance;
	const stringCount = Math.floor(next() * 4);
	const strings = Array.from({ length: stringCount }, () =>
		sometimes(0.15) ? text(pick(lengths)) : `S${Math.floor(next() * 1000)}`
	);
	const reference = () =>
		sometimes(0.1) ? stringCount + Math.floor(next() * 3) : Math.floor(next() * stringCount);
	const references = () =>
		Array.from({ length: sometimes(0.05) ? 65 : Math.floor(next() * 3) }, reference);
	const path = () =>
		sometimes(0.1) ? text(pick([...lengths, ...lengths32k])) : "Content/A.uasset";
	const headerData = {
		gatherableTextDataCount: 1,
		gatherableTextDataOffset: 2,
		hasTextProperty: true,
		packageFlags: 3
	};
	const item = () => {
		switch (pick(["map", "inventory", "header", "package"] as const)) {
			case "map":
				return { kind: "map", mapPath: path(), packageName: path() };
			case "inventory":
				return {
					kind: "inventory",
					packagePath: path(),
					signature: sometimes(0.2) ? text(pick(lengths)) : "sig",
					...(sometimes(0.5) ? { headerData } : undefined)
				};
			case "header":
				return {
					kind: "header",
					packageName: path(),
					packagePath: path(),
					...(sometimes(0.8) ? { classes: references() } : undefined),
					...(sometimes(0.8) ? { serializedNames: references() } : undefined),
					...(sometimes(0.5) ? { headerData } : undefined)
				};
			case "package":
				return {
					kind: "package",
					classes: references(),
					dependencies: Array.from({ length: Math.floor(next() * 3) }, () => ({
						package: reference(),
						...(sometimes(0.5) ? { packagePath: reference() } : undefined),
						hard: sometimes(0.5),
						game: sometimes(0.5),
						build: sometimes(0.5)
					})),
					...(sometimes(0.3) ? { failure: text(pick([1, 255, 256, 257])) } : undefined),
					packageName: path(),
					packagePath: path()
				};
		}
	};
	return {
		generation: pick([1, 2, 1_000]),
		items: Array.from(
			{ length: sometimes(0.02) ? PROJECT_INDEX_MAX_PAGE_SIZE + 1 : Math.floor(next() * 4) },
			item
		),
		projectId: sometimes(0.1) ? text(pick(lengths32k)) : "fixture",
		...(sometimes(0.5)
			? { nextCursor: sometimes(0.2) ? text(pick([4_096, 4_097])) : "next" }
			: undefined),
		strings
	};
}

describe("single-pass dictionary page decoding", () => {
	it("accepts, rejects and expands every protocol-valid page as the two-pass decoder did", () => {
		const next = random(27);
		const seen = { page: 0, reference: 0, unavailable: 0 };
		for (let attempt = 0; attempt < 4_000; attempt += 1) {
			const input = makePage(next);
			if (!isWirePage(input)) continue;
			const expected = reference(input);
			const actual = singlePass(input);
			if ("page" in expected) {
				expect("page" in actual, JSON.stringify(input).slice(0, 400)).toBe(true);
				expect(actual).toEqual(expected);
				seen.page += 1;
			} else {
				expect(actual, JSON.stringify(input).slice(0, 400)).toEqual(expected);
				seen[expected.kind] += 1;
			}
		}
		// Every outcome is exercised.
		expect(seen.page).toBeGreaterThan(100);
		expect(seen.reference).toBeGreaterThan(100);
		expect(seen.unavailable).toBeGreaterThan(100);
	});
});
