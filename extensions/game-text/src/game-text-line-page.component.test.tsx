import { textCorpusQuery } from "../../../packages/game-text/src/query.test-support.js";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { corpus, unit } from "../../../packages/game-text/src/localization.test-support.js";
import { LineProblem } from "./game-text-line-page.js";

afterEach(cleanup);

function focusWith(findings: readonly string[]) {
	const query = textCorpusQuery(corpus([unit("K", "Hello", "Content/Text/Table.uasset")]));
	const id = query.search({ query: "", capability: "all", pageSize: 1 }).units[0]!.id;
	const focus = query.focus({ id, pageSize: 1 })!;
	return {
		...focus,
		unit: {
			...focus.unit,
			problems: findings.length > 0 ? ["finding" as const] : [],
			findings
		}
	};
}

it("names the line's findings at the top of its page, by rule label", () => {
	render(() => (
		<LineProblem
			focus={focusWith(["localization.missing_notes", "fixture.prompt"])}
			detail={undefined}
			rules={
				new Map([
					["localization.missing_notes", "No translator notes"],
					["fixture.prompt", "Prompt length"]
				])
			}
		/>
	));
	const note = screen.getByRole("note", { name: "What this line needs" });
	expect(note.textContent).toBe("Findings No translator notes · Prompt length");
});

it("shows no banner for a line with nothing to do", () => {
	render(() => <LineProblem focus={focusWith([])} detail={undefined} rules={new Map()} />);
	expect(screen.queryByRole("note", { name: "What this line needs" })).toBeNull();
});
