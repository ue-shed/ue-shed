import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { unit } from "../../../packages/game-text/src/localization.test-support.js";
import { tableRow } from "./game-text-canned-search.test-support.js";
import { LineProblem } from "./game-text-line-page.js";

afterEach(cleanup);

function focusWith(findings: readonly string[]) {
	const { occurrences } = unit("K", "Hello");
	return {
		diagnostics: [],
		occurrences,
		totalOccurrences: 1,
		unit: {
			...tableRow("K", "Hello"),
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
