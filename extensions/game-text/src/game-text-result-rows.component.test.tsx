import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { joinLocalizationTarget } from "@ue-shed/game-text/corpus";
import {
	corpus,
	cultureCode,
	evidence,
	ftextUnit,
	target,
	unit
} from "../../../packages/game-text/src/localization.test-support.js";
import { pageOf, tableRow } from "./game-text-canned-search.test-support.js";
import { GameTextResultRows } from "./game-text-result-rows.js";

afterEach(cleanup);

it("preserves focused row elements while refreshed previews and handlers update", () => {
	const initial = pageOf([tableRow("K", "Before")]);
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
	// Neither line is gathered; the table entry lists under its package namespace, the saved
	// FText under its own.
	const marks = ["en", "de"].map((culture) => ({
		culture: cultureCode(culture),
		state: "not_gathered" as const,
		facts: ["not_gathered" as const, "not_translated" as const],
		unknownReasons: [],
		reducedSourceChecking: false,
		translation: null
	}));
	const tableContext = tableRow("K", "Source", "UI [Beta]").contexts[0]!;
	const savedContext = {
		editCapability: "source_editable" as const,
		location: saved.occurrences[0]!.location
	};
	const lines = joined.lines.map((line) => ({
		id: line.id,
		origin: line.origin,
		identity: line.identity,
		source: line.source,
		manifestLocations: [],
		remainingLocationCount: 0,
		cultures: marks,
		problems: ["not_gathered" as const]
	}));
	const base = pageOf([]);
	const page = {
		...base,
		units: lines.map((line) => ({
			...tableRow("K", "Source", "UI [Beta]"),
			...(line.identity?.namespace === "UI"
				? { contexts: [savedContext], locationKinds: ["asset_property" as const] }
				: { contexts: [tableContext] }),
			localization: marks,
			problems: ["not_gathered" as const]
		})),
		localization: {
			target: target.name,
			counts: [],
			stateCounts: {
				translated: 0,
				not_translated: 0,
				needs_update: 0,
				not_synced: 0,
				not_gathered: 2,
				changed_since_gather: 0,
				not_found: 0,
				gathered_only: 0,
				outside_target: 0,
				unknown: 0
			},
			notSynced: 0,
			lines
		}
	};
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
	const initial = pageOf([tableRow("K", "Wow!")]);
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
