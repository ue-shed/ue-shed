import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { EffectRuntimeProvider } from "@ue-shed/ui";

import {
	type TextCorpusSearchCounts,
	type TextCorpusSearchRequest,
	type TextGroup,
	type TextUnitSearchResult
} from "@ue-shed/game-text/schema";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { createSignal, flush } from "solid-js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { cannedSearch, tableRow } from "./game-text-canned-search.test-support.js";
import { GroupedResults } from "./game-text-grouped-results.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
afterEach(cleanup);

/** Rows reads over planted rows in fixed groups, paged by cursor. */
function groupedRows(
	by: "folder" | "asset",
	groups: readonly (TextGroup & { units: readonly TextUnitSearchResult[] })[]
) {
	const counts: TextCorpusSearchCounts = {
		all: groups.reduce((total, group) => total + group.units.length, 0),
		unresolved: 0,
		conflicting: 0,
		editable: 0,
		readOnly: 0,
		withoutNotes: 0,
		origins: { string_table: 0, data_table: 0, asset: 0, cpp: 0, other_source: 0 }
	};
	return cannedSearch([
		{
			rows: groups.flatMap(({ key, units }) =>
				units.map((unit) => ({ unit, groups: { [by]: key } }))
			),
			counts,
			groups: { [by]: groups.map(({ units: _units, ...group }) => group) }
		}
	]).searchRows;
}

it.each([false, true])(
	"keeps all loaded rows during a reload whose second page fails: %s",
	async (fail) => {
		const group = {
			key: "content/text",
			label: "Content/Text",
			count: 100,
			needWork: 0,
			worst: "up_to_date" as const
		};
		const rows = groupedRows("folder", [
			{
				...group,
				units: Array.from({ length: 100 }, (_, index) =>
					tableRow(`K${index}`, `Source ${index}`)
				)
			}
		]);
		const request = {
			query: "",
			capability: "all" as const,
			pageSize: 50,
			group: "folder" as const
		};
		const [groups, setGroups] = createSignal([group]);
		const [revision, setRevision] = createSignal(0);
		const second = await Effect.runPromise(Deferred.make<void>());
		const secondRequested = await Effect.runPromise(Deferred.make<void>());
		let reloading = false;
		const onLoaded = vi.fn();
		const client = {
			searchRows: (input: TextCorpusSearchRequest) =>
				Effect.gen(function* () {
					if (reloading && input.cursor) {
						yield* Deferred.succeed(secondRequested, undefined);
						yield* Deferred.await(second);
						if (fail) return { status: "not_ready" as const };
					}
					return yield* rows(input);
				})
		};
		const { container, getByRole } = render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<GroupedResults
					revision={revision()}
					groups={groups()}
					more={0}
					by="folder"
					request={request}
					client={client}
					culture={undefined}
					selectedId={undefined}
					selectedLocalizationId={undefined}
					onSelect={() => {}}
					onLoaded={onLoaded}
				/>
			</EffectRuntimeProvider>
		));
		await waitFor(() =>
			expect(container.querySelectorAll("button[data-row]")).toHaveLength(50)
		);
		fireEvent.click(getByRole("button", { name: "Show more (50 left)" }));
		await waitFor(() =>
			expect(container.querySelectorAll("button[data-row]")).toHaveLength(100)
		);
		const originalGroup = container.querySelector("section[data-group]");
		const last = container.querySelectorAll<HTMLButtonElement>("button[data-row]")[99]!;
		last.focus();
		reloading = true;
		setGroups([{ ...group }]);
		setRevision(1);
		flush();
		await Effect.runPromise(Deferred.await(secondRequested));
		expect(container.querySelector("section[data-group]")).toBe(originalGroup);
		expect(container.querySelectorAll("button[data-row]")).toHaveLength(100);
		expect(document.activeElement).toBe(last);
		await Effect.runPromise(Deferred.succeed(second, undefined));
		if (fail)
			await waitFor(() =>
				expect(getByRole("alert").textContent).toContain("could not be loaded")
			);
		else await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(3));
		expect(container.querySelectorAll("button[data-row]")[99]).toBe(last);
		expect(document.activeElement).toBe(last);
	}
);

it("reads the groups that open together in one rows request", async () => {
	const planted = ["Menus", "Items", "Quests"].map((folder) => ({
		key: `content/${folder.toLowerCase()}/table`,
		label: `Content/${folder}/Table`,
		count: 3,
		needWork: 0,
		worst: "up_to_date" as const,
		units: Array.from({ length: 3 }, (_, index) =>
			tableRow(`${folder}${index}`, `${folder} ${index}`)
		)
	}));
	const rows = groupedRows("asset", planted);
	const request = {
		query: "",
		capability: "all" as const,
		pageSize: 50,
		group: "asset" as const
	};
	const groups = planted.map(({ units: _units, ...group }) => group);
	expect(groups).toHaveLength(3);
	const reads: TextCorpusSearchRequest[] = [];
	const client = {
		searchRows: (input: TextCorpusSearchRequest) =>
			Effect.suspend(() => {
				reads.push(input);
				return rows(input);
			})
	};
	const { container } = render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GroupedResults
				groups={groups}
				more={0}
				by="asset"
				request={request}
				client={client}
				culture={undefined}
				selectedId={undefined}
				selectedLocalizationId={undefined}
				onSelect={() => {}}
			/>
		</EffectRuntimeProvider>
	));
	// Every group fits on one page, so all three open, and share one request.
	await waitFor(() => expect(container.querySelectorAll("button[data-row]")).toHaveLength(9));
	expect(reads).toHaveLength(1);
	expect(reads[0]!.openGroups).toEqual(groups.map((group) => group.key));
	expect(reads[0]!.firstRows).toBe(50);
});
