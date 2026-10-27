import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { joinLocalizationTarget, localizationFocusPage } from "@ue-shed/game-text/corpus";
import {
	LocalizationJoin,
	LocalizationSelection,
	type LocalizationCultureState,
	type LocalizationQueryPage,
	type TextCorpusQuerySummary,
	type TextGroup
} from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
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
import {
	cannedFocus,
	cannedSearch,
	linePreview,
	tableRow,
	type CannedAnswer,
	type CannedRow,
	type CannedWhen
} from "./game-text-canned-search.test-support.js";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextRoute } from "./game-text-query-route.js";
import { groupRows, withSearchRows } from "./game-text-route.test-support.js";

export { groupRows };
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
export const second = LocalizationSelection.fields.target.make("Second");
const en = cultureCode("en");
const de = cultureCode("de");
const fr = cultureCode("fr");
/** A join's lines as a page lists them, with the translations each culture ships or stages. */
export function plantedLines(join: LocalizationJoin) {
	const lineOf = (key: string) => {
		const line = join.lines.find((item) => item.identity?.key === key);
		if (!line) throw new Error(`Missing ${key} line.`);
		return line;
	};
	return {
		code: linePreview(lineOf("Code"), {
			translations: { en: "Code greeting" },
			manifestLocations: ["Source/Example.cpp(12)"],
			problems: ["up_to_date"]
		}),
		fresh: linePreview(lineOf("Fresh"), {
			translations: { en: "Fresh line" },
			problems: ["not_gathered"]
		}),
		welcome: linePreview(lineOf("K"), {
			translations: { en: "Welcome", de: "Neue Begrüßung", fr: "Bienvenue" },
			manifestLocations: ["/Game/Text/Table.Table"],
			problems: ["translation"]
		})
	};
}
export const lines = plantedLines(joined);
const welcomeRow = tableRow("K", "Welcome");
const freshRow = tableRow("Fresh", "Fresh line");
const group = (key: string, label: string, count: number, worst: TextGroup["worst"]) => ({
	key,
	label,
	count,
	needWork: worst === "up_to_date" ? 0 : count,
	worst
});
export const targetGroups = [
	group("not_gathered", "Not gathered yet", 1, "not_gathered"),
	group("translation", "Translation work", 1, "translation"),
	group("up_to_date", "Up to date", 1, "up_to_date")
];
const stateCounts = {
	translated: 3,
	not_translated: 0,
	needs_update: 1,
	not_synced: 1,
	not_gathered: 1,
	changed_since_gather: 0,
	not_found: 0,
	gathered_only: 1,
	outside_target: 0,
	unknown: 0
};
/** An answer over a target listing these rows, with the planted target aggregates. */
export function targetAnswer(
	when: CannedWhen,
	rows: readonly CannedRow[],
	extra: Partial<CannedAnswer> = {}
): CannedAnswer {
	return {
		when: { ...when, localization: when.localization ?? {} },
		rows,
		counts: {
			all: rows.length,
			unresolved: 0,
			conflicting: 0,
			editable: 2,
			readOnly: 1,
			withoutNotes: 3,
			origins: { string_table: 2, data_table: 0, asset: 0, cpp: 1, other_source: 0 }
		},
		groups: {
			problem: targetGroups.filter((entry) =>
				rows.some((row) => row.groups?.problem === entry.key)
			)
		},
		problems: {
			key_changed: 0,
			conflicting_source: 0,
			not_gathered: 1,
			changed_since_gather: 0,
			translation: 1,
			finding: 0,
			unchecked: 0,
			up_to_date: 1
		},
		facets: {
			assets: {
				entries: [
					group("content/text/table", "Content/Text/Table", 2, "not_gathered"),
					group("source/example.cpp", "Source/Example.cpp", 1, "up_to_date")
				],
				more: 0
			},
			origins: {
				entries: [
					group("string_table", "String table", 2, "not_gathered"),
					group("cpp", "C++", 1, "up_to_date")
				],
				more: 0
			},
			audiences: {
				entries: [
					group("player", "Player text", 2, "not_gathered"),
					group("unknown", "Unknown", 1, "up_to_date")
				],
				more: 0
			},
			assetTypes: { entries: [], more: 0 },
			cultures: [
				{ culture: fr, lines: 3, shipped: 0, missing: 0, toUpdate: 1, notSynced: 0 },
				{ culture: de, lines: 3, shipped: 0, missing: 0, toUpdate: 0, notSynced: 1 },
				{ culture: en, lines: 3, shipped: 3, missing: 0, toUpdate: 0, notSynced: 0 }
			],
			facts: { unresolved: 0, conflicting: 0, evidence_only: 0, compiled_copy_differs: 0 }
		},
		folders: {
			"": {
				entries: [
					group("content", "Content", 2, "not_gathered"),
					group("source", "Source", 1, "up_to_date")
				],
				more: 0
			}
		},
		localization: { counts: [], stateCounts, notSynced: 1 },
		...extra
	};
}
const translation = (values: readonly ("to_update" | "not_synced" | "missing")[]) => [
	{ field: "translation" as const, op: "is" as const, values }
];
/** Source answers, without a target: both corpus units, up to date. */
export const sourceAnswers: readonly CannedAnswer[] = [
	{
		rows: [
			{ unit: welcomeRow, groups: { problem: "up_to_date" } },
			{ unit: freshRow, groups: { problem: "up_to_date" } }
		],
		counts: {
			all: 2,
			unresolved: 0,
			conflicting: 0,
			editable: 2,
			readOnly: 0,
			withoutNotes: 2,
			origins: { string_table: 2, data_table: 0, asset: 0, cpp: 0, other_source: 0 }
		},
		groups: { problem: [group("up_to_date", "Up to date", 2, "up_to_date")] }
	}
];
/**
 * Target answers over a join of the planted text: the lines each planted culture, state, review
 * or search narrows to, then every line, with the review counts of a join that has a review file.
 */
export function targetAnswersOf(
	join: LocalizationJoin,
	reviewCounts?: LocalizationQueryPage["reviewCounts"]
): CannedAnswer[] {
	const listed = plantedLines(join);
	const codeLine: CannedRow = { line: listed.code, groups: { problem: "up_to_date" } };
	const freshLine: CannedRow = {
		unit: freshRow,
		line: listed.fresh,
		groups: { problem: "not_gathered" }
	};
	const welcomeLine: CannedRow = {
		unit: welcomeRow,
		line: listed.welcome,
		groups: { problem: "translation" }
	};
	const answer = (when: CannedWhen, rows: readonly CannedRow[]) =>
		targetAnswer(
			when,
			rows,
			reviewCounts
				? { localization: { counts: [], stateCounts, notSynced: 1, reviewCounts } }
				: {}
		);
	return [
		answer({ localization: { state: "gathered_only" } }, [codeLine]),
		answer({ localization: { review: "changed_since_review" } }, [welcomeLine]),
		answer({ query: "Neue", localization: { searchTranslations: false } }, []),
		answer({ query: "Neue", localization: { searchTranslations: true } }, [welcomeLine]),
		answer({ query: "Bienvenue", localization: { searchTranslations: true } }, [welcomeLine]),
		answer({ filter: translation(["to_update"]), localization: { culture: fr } }, [
			welcomeLine
		]),
		answer({ filter: translation(["not_synced"]), localization: { culture: de } }, [
			welcomeLine
		]),
		answer(
			{ query: "absent", filter: translation(["not_synced"]), localization: { culture: de } },
			[]
		),
		answer({ filter: translation(["missing"]), localization: { target: second } }, []),
		answer({}, [codeLine, freshLine, welcomeLine])
	];
}
export const targetAnswers = targetAnswersOf(joined);
export const summary: TextCorpusQuerySummary = {
	counts: sourceAnswers[0]!.counts,
	searchable: { textUnits: 2, textOccurrences: 2 },
	schemaVersion: 1,
	status: "complete",
	coverage: text.coverage,
	diagnosticCount: 0,
	review: { all: 2, unresolved: 0, conflicting: 0 },
	sources: { assetProperty: 0, dataTable: 0, mixed: 0, stringTable: 2 },
	notGatherablePackages: 0
};
/** Each unit's focus: alone without a target, and with its line under one. */
export const focuses = [
	{ row: welcomeRow, line: lines.welcome },
	{ row: freshRow, line: lines.fresh }
].flatMap(({ row, line }) => {
	const occurrences = text.units.find((item) => item.id === row.id)?.occurrences ?? [];
	const focus = { diagnostics: [], occurrences, totalOccurrences: occurrences.length };
	return [
		{ ...focus, unit: row },
		{
			...focus,
			unit: { ...row, problems: line.problems ?? [] },
			localization: line,
			line: line.id
		}
	];
});
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
					lines: 3,
					notSynced: 1
				})),
		localizationFocus: (request) => {
			const line = joined.lines.find((item) =>
				request.selection.kind === "line"
					? item.id === request.selection.id
					: item.origin.kind === "corpus" &&
						item.origin.unitIds.includes(request.selection.id)
			);
			return Effect.succeed(
				line
					? { status: "found", focus: localizationFocusPage(joined, line, request) }
					: { status: "not_found" }
			);
		},
		loadConfiguredProject: () => Effect.succeed({ status: "completed", summary }),
		...cannedSearch([...sourceAnswers, ...targetAnswers]),
		focus: cannedFocus(focuses),
		progress: Stream.make({ completed: 0, total: 0, phase: "idle" }),
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
			<GameTextRoute client={withSearchRows(api)} />
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
