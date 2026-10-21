import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { joinLocalizationTarget, localizationFocusPage } from "@ue-shed/game-text/corpus";
import {
	LocalizationJoin,
	LocalizationSelection,
	type LocalizationCultureState
} from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	poDocument,
	target,
	unit
} from "../../../packages/game-text/src/localization.test-support.js";
import { textCorpusQuery } from "../../../packages/game-text/src/query.test-support.js";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextRoute } from "./game-text-query-route.js";
export const runtime = ManagedRuntime.make(Layer.empty);
export const text = corpus([unit("K", "Welcome"), unit("Fresh", "Fresh line")]);
export const base = joinLocalizationTarget(
	text,
	evidence(
		[
			manifestEntry("K", "Welcome"),
			manifestEntry("Code", "Code greeting", "Source/Example.cpp(12)")
		],
		[archiveEntry("K", "Old greeting", "Willkommen")],
		poDocument("Neue Begrüßung")
	)
);
export const joined = LocalizationJoin.make({
	...base,
	cultures: [...base.cultures, cultureCode("fr")],
	lines: base.lines.map((line) => ({
		...line,
		cultures: line.cultures
			.map<LocalizationCultureState>((mark) =>
				mark.culture === "en"
					? {
							...mark,
							state: "translated",
							facts: ["translated"],
							archive: archiveEntry("K", "Welcome", line.source),
							poTranslation: null,
							po: null
						}
					: mark
			)
			.concat([
				{
					culture: cultureCode("fr"),
					state:
						line.identity?.key === "K"
							? "needs_update"
							: (line.cultures[0]?.state ?? "unknown"),
					facts: line.identity?.key === "K" ? ["needs_update"] : [],
					unknownReasons: [],
					reducedSourceChecking: false,
					archive:
						line.identity?.key === "K"
							? archiveEntry("K", "Old greeting", "Bienvenue")
							: null,
					poTranslation: null,
					po: null
				}
			])
	}))
});
export const localized = textCorpusQuery(text, undefined, joined);
export const plain = textCorpusQuery(text);
export const second = LocalizationSelection.fields.target.make("Second");
export function client(
	options: {
		readonly twoTargets?: boolean;
		readonly targets?: GameTextClientApi["localizationTargets"];
		readonly target?: GameTextClientApi["localizationTarget"];
	} = {}
): GameTextClientApi {
	const descriptor = {
		name: target.name,
		nativeCulture: joined.nativeCulture,
		cultures: joined.cultures
	};
	const baseline = localized.search({
		query: "",
		capability: "all",
		pageSize: 50,
		localization: { target: target.name }
	});
	return {
		projectKey: () => Effect.succeed("localization-project"),
		localizationTargets:
			options.targets ??
			(() =>
				Effect.succeed({
					status: "ready",
					targets: options.twoTargets
						? [descriptor, { ...descriptor, name: second }]
						: [descriptor]
				})),
		localizationTarget:
			options.target ??
			((name) =>
				Effect.succeed({
					status: "ready",
					target: { ...descriptor, name },
					lines: baseline.total,
					notSynced: baseline.localization?.notSynced ?? 0
				})),
		localizationFocus: (request) => {
			const id =
				request.selection.kind === "line"
					? request.selection.id
					: localized.focus({ id: request.selection.id, pageSize: 1 })?.localization?.id;
			const line = id ? localized.localizationFocus(id) : undefined;
			return Effect.succeed(
				line
					? { status: "found", focus: localizationFocusPage(joined, line, request) }
					: { status: "not_found" }
			);
		},
		loadConfiguredProject: () =>
			Effect.succeed({ status: "completed", summary: plain.summary() }),
		search: (request) =>
			Effect.succeed({
				status: "ready",
				page: (request.localization
					? textCorpusQuery(text, undefined, {
							...joined,
							target: request.localization.target
						})
					: plain
				).search(request)
			}),
		focus: (request) => {
			const focus = (
				request.localization
					? textCorpusQuery(text, undefined, {
							...joined,
							target: request.localization.target
						})
					: plain
			).focus(request);
			return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
		},
		progress: () =>
			Effect.succeed({ completed: 0, total: 0, phase: "idle", stage: "game_text" }),
		locateAsset: (objectPath) =>
			Effect.succeed({
				status: "located",
				objectPath,
				contract: {
					name: "unreal-editor-asset-navigation",
					version: { major: 1, minor: 0 }
				}
			}),
		chooseQualityRules: () => Effect.succeed({ status: "not_ready" }),
		qualitySearch: () => Effect.succeed({ status: "not_ready" }),
		qualityFocus: () => Effect.succeed({ status: "not_ready" }),
		previewQualityRules: () => Effect.succeed({ status: "not_ready" }),
		saveQualityRules: () => Effect.succeed({ status: "not_ready" })
	};
}
export function mount(api = client()) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute client={api} />
		</EffectRuntimeProvider>
	));
}
export async function chooseFilter(
	user: ReturnType<typeof userEvent.setup>,
	field: string,
	value: string | RegExp
) {
	// Counts and items refresh with each page; open the menu once the search has settled.
	await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
	const filter = screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u });
	await user.click(filter);
	await user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${field}`, "u") }));
	await user.click(
		within(screen.getByRole("menu", { name: field })).getByRole("menuitemcheckbox", {
			name: value
		})
	);
	await user.click(filter);
}
export async function filterValues(user: ReturnType<typeof userEvent.setup>, field: string) {
	// Counts and items refresh with each page; open the menu once the search has settled.
	await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
	const filter = screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u });
	await user.click(filter);
	await user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${field}`, "u") }));
	const values = within(screen.getByRole("menu", { name: field }))
		.getAllByRole("menuitemcheckbox")
		.map((item) => item.getAttribute("aria-label"));
	await user.click(filter);
	return values;
}
export async function choose(
	user: ReturnType<typeof userEvent.setup>,
	label: "Culture" | "Localization target",
	value: string
) {
	await user.click(screen.getByRole("button", { name: new RegExp("^" + label + ":", "u") }));
	await user.click(
		within(screen.getByRole("dialog", { name: label + " choices" })).getByRole("button", {
			name: value
		})
	);
}
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
afterAll(() => runtime.dispose());
beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		clear: () => values.clear()
	});
});
