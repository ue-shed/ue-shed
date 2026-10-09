import { relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { Schema } from "effect";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/** Harness inputs and outputs stay inside this checkout, including user-selected paths. */
export function repositoryPath(path: string): string {
	const absolute = resolve(path);
	const child = relative(repositoryRoot, absolute);
	if (child === "" || child.startsWith("..") || isAbsolute(child)) {
		throw new Error("Choose a directory inside the repository.");
	}
	return absolute;
}

export function positiveNumber(value: string, name: string): number {
	const number = Number(value.replace(/x$/u, ""));
	if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid ${name}: ${value}`);
	return number;
}

const Recipe = Schema.Struct({
	scale: Schema.Number.check(Schema.isGreaterThan(0)),
	keys: Schema.Int.check(Schema.isGreaterThan(0)),
	packages: Schema.Int.check(Schema.isGreaterThan(0)),
	partialPackages: Schema.Int.check(Schema.isGreaterThan(0)),
	occurrences: Schema.Int.check(Schema.isGreaterThan(0)),
	gaps: Schema.Int.check(Schema.isGreaterThan(0)),
	cultures: Schema.Array(Schema.String)
});

/** The pre-crash 1× descriptor called its recipe "shape". Never load an unbounded descriptor. */
export async function readScaleRecipe(root: string) {
	const path = resolve(root, "scale.json");
	if ((await stat(path)).size > 64 * 1024) throw new Error("Scale descriptor exceeds 64 KiB.");
	const descriptor = Schema.decodeUnknownSync(
		Schema.fromJsonString(
			Schema.Struct({
				schemaVersion: Schema.Literal(1),
				recipe: Schema.optionalKey(Recipe),
				["shape"]: Schema.optionalKey(Recipe)
			})
		)
	)(await readFile(path, "utf8"));
	const recipe = descriptor.recipe ?? descriptor["shape"];
	if (recipe === undefined) throw new Error("Missing scale recipe.");
	if (
		recipe.cultures.length === 0 ||
		recipe.cultures.length > 20 ||
		new Set(recipe.cultures).size !== recipe.cultures.length ||
		recipe.cultures.some((culture) => !/^[a-z]{2}$/u.test(culture))
	)
		throw new Error("Invalid scale cultures.");
	return recipe;
}
