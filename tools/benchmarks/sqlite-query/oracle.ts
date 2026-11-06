/** Independent reads over retained facts; no SQL execution or engine query code. */
import { type Case, type Fact, type SqlRow } from "./sqlite.ts";

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const projection = (fact: Fact): SqlRow => ({
	id: fact.id,
	identity: fact.identity,
	source: fact.source
});

export function expected(entry: Case, facts: readonly Fact[]): SqlRow[] {
	if (entry.name === "boundary:scalar") return [{ n: 1 }];
	const query = entry.name.replace(/^(?:search-page|search|fts):/u, "");
	if (/^(?:search-page|search|fts):/u.test(entry.name)) {
		const selected = facts.filter((fact) =>
			fact.source.toLowerCase().includes(query.toLowerCase())
		);
		return (entry.name.startsWith("search-page:") ? selected.slice(0, 50) : selected).map(
			projection
		);
	}
	if (entry.name === "all-lines") return facts.map(projection);
	if (entry.name.startsWith("page:"))
		return facts.slice(0, Number(entry.parameters[0])).map(projection);
	if (entry.name === "namespace")
		return facts
			.filter((fact) => fact.identity?.namespace === entry.parameters[0])
			.map(projection);
	if (entry.name === "audience")
		return facts
			.filter((fact) => (fact.audience ?? "unknown") === entry.parameters[0])
			.map(projection);
	if (entry.name === "culture-state")
		return facts
			.filter((fact) =>
				fact.marks.some((mark) => mark.culture === "de" && mark.state === "not_translated")
			)
			.map(projection);
	if (entry.name === "rule:source-length")
		return facts.filter((fact) => fact.source.length > 140).map((fact) => ({ id: fact.id }));
	if (entry.name === "rule:empty-translation")
		return facts.flatMap((fact) =>
			fact.marks
				.filter((mark) => mark.state === "not_translated" && mark.translation === "")
				.sort((a, b) => ordinal(a.culture, b.culture))
				.map((mark) => ({ id: fact.id, culture: mark.culture }))
		);
	if (entry.name === "report:length-distribution") {
		const lengths = new Map<number, number>();
		for (const fact of facts)
			lengths.set(fact.source.length, (lengths.get(fact.source.length) ?? 0) + 1);
		return [...lengths]
			.sort(([a], [b]) => a - b)
			.map(([utf16Length, n]) => ({ utf16Length, n }));
	}
	const counts = new Map<string, number>();
	for (const fact of facts) {
		const keys =
			entry.name === "namespace-counts"
				? [fact.identity?.namespace ?? ""]
				: entry.name === "rule:duplicate-source"
					? [fact.source]
					: entry.name === "culture-state-counts"
						? fact.marks.map((mark) => JSON.stringify([mark.culture, mark.state]))
						: undefined;
		if (!keys) throw new Error(`No independent oracle for ${entry.name}`);
		for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const values = [...counts].sort(([a], [b]) => ordinal(a, b));
	if (entry.name === "namespace-counts") return values.map(([key, n]) => ({ key, n }));
	if (entry.name === "rule:duplicate-source")
		return values.filter(([, n]) => n > 1).map(([source, n]) => ({ source, n }));
	return values.map(([key, n]) => {
		const [culture, state]: string[] = JSON.parse(key);
		return { culture: culture!, state: state!, n };
	});
}
