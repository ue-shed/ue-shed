import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent construction census; no join rules, object oracle or decoded corpus used. */
export async function expectJoinRecipe(
	project: string,
	census: {
		count: number;
		keyless: number;
		keyChanges: number;
		ambiguous: number;
		states: Record<string, Record<string, number>>;
		coveredLines: number;
		facetMemberships: number;
		fileCoveredLines: number;
		fileMemberships: number;
	}
) {
	const descriptor = JSON.parse(await readFile(join(project, "scale.json"), "utf8"));
	const recipe = descriptor.recipe ?? descriptor["shape"];
	let translated = 0,
		missing = 0,
		pending = 0;
	for (let index = 0; index < recipe.savedKeys; index++) {
		if (index % 89 === 2) pending++;
		else if (index % 97 === 1) missing++;
		else translated++;
	}
	const expected = {
		translated,
		not_translated: missing,
		needs_update: 0,
		not_synced: pending,
		not_gathered: recipe.editor + recipe.keyedUnknown + recipe.changedKeys,
		changed_since_gather: 0,
		not_found: 0,
		gathered_only: recipe.gatheredOnly,
		outside_target: recipe.outside,
		unknown: recipe.keyless + recipe.notFound
	};
	// All apparent old-key packages are excluded by Phase 4's selected header flags:
	// not_gatherable does not establish absence, so no recipe pair is provable here.
	const count = Object.values(expected).reduce((sum, value) => sum + value, 0);
	for (const [culture, actual] of Object.entries(census.states))
		if (JSON.stringify(actual) !== JSON.stringify(expected))
			throw new Error(
				`Recipe census differs for ${culture}: ${JSON.stringify({ actual, expected })}`
			);
	if (
		census.count !== count ||
		census.keyless !== recipe.keyless ||
		census.keyChanges !== 0 ||
		census.ambiguous !== 0 ||
		census.coveredLines !== count ||
		census.facetMemberships !== count ||
		census.fileCoveredLines !== count ||
		census.fileMemberships !== count ||
		Object.keys(census.states).length !== recipe.cultures.length
	)
		throw new Error(`Recipe totals differ: ${JSON.stringify(census)}`);
	return {
		seededRecipeChecked: true,
		expected,
		expectedLines: count,
		expectedKeyless: recipe.keyless,
		expectedKeyChanges: 0,
		...census
	};
}
