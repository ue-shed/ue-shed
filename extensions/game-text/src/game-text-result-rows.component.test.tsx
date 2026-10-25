import { textCorpusQuery } from "../../../packages/game-text/src/query.test-support.js";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { joinLocalizationTarget } from "@ue-shed/game-text/corpus";
import {
	corpus,
	evidence,
	ftextUnit,
	target,
	unit
} from "../../../packages/game-text/src/localization.test-support.js";
import { GameTextResultRows } from "./game-text-result-rows.js";

afterEach(cleanup);

it("preserves focused row elements while refreshed previews and handlers update", () => {
	const query = textCorpusQuery(corpus([unit("K", "Before", "Content/Text/Table.uasset")]));
	const initial = query.search({ query: "", capability: "all", pageSize: 50 });
	const [page, setPage] = createSignal(initial);
	const onSelect = vi.fn();
	const { container } = render(() => (
		<GameTextResultRows
			page={page()}
			culture={undefined}
			selectedId={undefined}
			selectedLocalizationId={undefined}
			onSelect={onSelect}
		/>
	));
	const original = container.querySelector<HTMLButtonElement>("button[data-row]")!;
	original.focus();
	setPage({
		...initial,
		units: initial.units.map((item) => ({
			...item,
			source: { status: "consistent", value: "After" }
		}))
	});
	flush();
	expect(container.querySelector("button[data-row]")).toBe(original);
	expect(document.activeElement).toBe(original);
	expect(original.textContent).toContain("After");
	expect(original.textContent).not.toContain("Before");
	fireEvent.click(original);
	expect(onSelect).toHaveBeenLastCalledWith(initial.units[0]?.id, undefined);
});

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

it("lists a row's facts and the labels of its rules' findings", () => {
	const query = textCorpusQuery(corpus([unit("K", "Wow!", "Content/Text/Table.uasset")]));
	const initial = query.search({ query: "", capability: "all", pageSize: 50 });
	const page = {
		...initial,
		units: initial.units.map((item) => ({
			...item,
			reviewSignals: ["unresolved" as const],
			findings: ["custom.exclaim", "long"],
			findingsOmitted: 2
		}))
	};
	const { container } = render(() => (
		<GameTextResultRows
			page={page}
			culture={undefined}
			selectedId={undefined}
			selectedLocalizationId={undefined}
			onSelect={() => undefined}
			rules={new Map([["custom.exclaim", "Exclamation mark"]])}
		/>
	));
	expect(container.querySelector("button[data-row]")?.textContent).toContain(
		" · not localizable · Exclamation mark · long · +2 more findings"
	);
});
