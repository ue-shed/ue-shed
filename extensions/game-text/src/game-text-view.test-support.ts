import { searchTextCorpus } from "../../../packages/game-text/src/search.test-support.js";
import type { TextCorpus, TextUnit } from "@ue-shed/game-text/schema";
import type { CapabilityFilter } from "./game-text-view.js";

export function filterTextUnits(options: {
	readonly corpus: TextCorpus;
	readonly query: string;
	readonly capability: CapabilityFilter;
}): readonly TextUnit[] {
	return searchTextCorpus(options.corpus, options.query).filter(
		(unit) =>
			options.capability === "all" ||
			unit.occurrences.some((occurrence) => occurrence.editCapability === options.capability)
	);
}
