import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { joinLocalizationTarget, textCorpusQuery } from "@ue-shed/game-text/browser";
import {
	corpus,
	evidence,
	ftextUnit,
	target,
	unit
} from "../../../packages/game-text/src/localization.test-support.js";
import { GameTextResultRows } from "./game-text-result-rows.js";

afterEach(cleanup);

it("keeps contexts and selection on the gathered line when two lines share a unit", () => {
	const table = unit("K", "Source", "Content/Text/Table.uasset", "UI [Beta]");
	const saved = ftextUnit("K", "Source", "Content/Text/Table.uasset", "UI [Beta]");
	const mixed = { ...table, occurrences: [...table.occurrences, ...saved.occurrences] };
	const text = corpus([mixed]);
	const joined = joinLocalizationTarget(text, evidence([]));
	const page = textCorpusQuery(text, undefined, joined).search({
		capability: "all",
		query: "",
		pageSize: 50,
		localization: { target: target.name }
	});
	const selected = page.localization?.lines[0];
	if (!selected) throw new Error("Missing gathered line.");
	const onSelect = vi.fn();
	const { container } = render(() => (
		<GameTextResultRows
			page={page}
			culture={undefined}
			selectedId={mixed.id}
			selectedLocalizationId={selected.id}
			onSelect={onSelect}
		/>
	));
	const rows = [...container.querySelectorAll<HTMLButtonElement>("button[data-line]")];
	expect(rows).toHaveLength(2);
	for (const row of rows) {
		const line = joined.lines.find((line) => line.id === row.dataset.line);
		expect(row.getAttribute("aria-current") === "true").toBe(line?.id === selected.id);
		expect(row.textContent).toContain(
			line?.identity?.namespace === "UI" ? "Table · Label" : "Table · K"
		);
		fireEvent.click(row);
		expect(onSelect).toHaveBeenLastCalledWith(mixed.id, line?.id);
	}
});
