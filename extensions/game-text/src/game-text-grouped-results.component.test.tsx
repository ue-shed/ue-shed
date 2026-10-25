import {
	referenceSearchRows,
	textCorpusQuery
} from "../../../packages/game-text/src/query.test-support.js";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { EffectRuntimeProvider } from "@ue-shed/ui";

import { type TextCorpusSearchRequest } from "@ue-shed/game-text/schema";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { createSignal, flush } from "solid-js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { corpus, unit } from "../../../packages/game-text/src/localization.test-support.js";
import { GroupedResults } from "./game-text-grouped-results.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
afterEach(cleanup);

it.each([false, true])(
	"keeps all loaded rows during a reload whose second page fails: %s",
	async (fail) => {
		const text = corpus(
			Array.from({ length: 100 }, (_, index) =>
				unit(`K${index}`, `Source ${index}`, "Content/Text/Table.uasset")
			)
		);
		const query = textCorpusQuery(text);
		const request = {
			query: "",
			capability: "all" as const,
			pageSize: 50,
			group: "folder" as const
		};
		const initial = query.search(request);
		const group = initial.groups!.entries[0]!;
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
					return {
						status: "ready" as const,
						page: referenceSearchRows(query.search, input)
					};
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
	const text = corpus(
		["Menus", "Items", "Quests"].flatMap((folder) =>
			Array.from({ length: 3 }, (_, index) =>
				unit(`${folder}${index}`, `${folder} ${index}`, `Content/${folder}/Table.uasset`)
			)
		)
	);
	const query = textCorpusQuery(text);
	const request = {
		query: "",
		capability: "all" as const,
		pageSize: 50,
		group: "asset" as const
	};
	const groups = query.search(request).groups!.entries;
	expect(groups).toHaveLength(3);
	const reads: TextCorpusSearchRequest[] = [];
	const client = {
		searchRows: (input: TextCorpusSearchRequest) =>
			Effect.sync(() => {
				reads.push(input);
				return { status: "ready" as const, page: referenceSearchRows(query.search, input) };
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
