import { screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	joinLocalizationTarget,
	localizationFocusPage,
	type LocalizationEditRequest,
	type LocalizationEditResult
} from "@ue-shed/game-text/corpus";
import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	poDocument,
	splitUnit,
	target
} from "../../../packages/game-text/src/localization.test-support.js";
import {
	cannedFocus,
	cannedPage,
	cannedSearch,
	linePreview,
	tableRow,
	type CannedAnswer
} from "./game-text-canned-search.test-support.js";
import type { GameTextClientApi } from "./game-text-client.js";
import { client, groupRows, mount } from "./game-text-localization.test-support.js";

/** An answer over the target listing these lines, all in one group. */
const linesAnswer = (
	rows: CannedAnswer["rows"],
	group: { key: string; label: string; worst: "not_gathered" | "up_to_date" }
): CannedAnswer => ({
	when: { localization: {} },
	rows,
	counts: {
		all: rows.length,
		unresolved: 0,
		conflicting: 0,
		editable: 0,
		readOnly: 0,
		withoutNotes: rows.length,
		origins: { string_table: 0, data_table: 0, asset: 0, cpp: 0, other_source: 0 }
	},
	groups: {
		problem: [
			{
				...group,
				count: rows.length,
				needWork: group.worst === "up_to_date" ? 0 : rows.length
			}
		]
	},
	localization: {
		counts: [],
		stateCounts: {
			translated: 0,
			not_translated: 0,
			needs_update: 0,
			not_synced: 0,
			not_gathered: 0,
			changed_since_gather: 0,
			not_found: 0,
			gathered_only: 0,
			outside_target: 0,
			unknown: 0
		},
		notSynced: 0
	}
});
describe("Game Text line page", () => {
	it("switches between split lines sharing a unit without mixing their saved details", async () => {
		const mixed = splitUnit();
		const saved = corpus([mixed]);
		const join = joinLocalizationTarget(saved, evidence([], [], poDocument("")));
		// The table entry and the saved FText are two lines of one unit, each with its own place.
		const [table, base] = mixed.occurrences;
		const tableLine = join.lines.find((line) => line.identity?.namespace === "UI [Beta]");
		const baseLine = join.lines.find((line) => line.identity?.namespace === "UI");
		if (!table || !base || !tableLine || !baseLine) throw new Error("Missing split lines.");
		const notGathered = { problems: ["not_gathered" as const] };
		const split = [
			{ place: table, source: "Table label", line: tableLine },
			{ place: base, source: "Base label", line: baseLine }
		].map(({ place, source, line }) => {
			const unit = {
				...tableRow("K", source, "UI [Beta]"),
				contexts: [{ editCapability: place.editCapability, location: place.location }],
				locationKinds: [place.location.kind],
				...notGathered
			};
			return {
				row: {
					unit,
					line: linePreview(line, notGathered),
					groups: { problem: "not_gathered" }
				},
				focus: {
					diagnostics: [],
					occurrences: [place],
					totalOccurrences: 1,
					unit,
					localization: linePreview(line, notGathered),
					line: line.id
				}
			};
		});
		const user = userEvent.setup({ delay: null });
		mount({
			...client(),
			localizationTarget: () =>
				Effect.succeed({
					status: "ready",
					target: {
						name: join.target,
						nativeCulture: join.nativeCulture,
						cultures: join.cultures
					},
					lines: 2,
					notSynced: 0
				}),
			...cannedSearch([
				linesAnswer(
					split.map(({ row }) => row),
					{ key: "not_gathered", label: "Not gathered yet", worst: "not_gathered" }
				)
			]),
			focus: cannedFocus(split.map(({ focus }) => focus)),
			localizationFocus: (request) => {
				const line = join.lines.find(
					(item) => request.selection.kind === "line" && item.id === request.selection.id
				);
				return Effect.succeed(
					line
						? { status: "found", focus: localizationFocusPage(join, line, request) }
						: { status: "not_found" }
				);
			}
		});
		await screen.findByText("2 matches");
		await groupRows();
		const results = screen.getByRole("region", { name: "Results" });
		const rows = within(results)
			.getAllByRole("button")
			.filter((row) => row.hasAttribute("data-row"));
		expect(rows).toHaveLength(2);
		const firstIsTable = rows[0]?.textContent?.includes("Table label");
		await user.click(rows[0]!);
		const page = screen.getByRole("complementary", { name: "Text focus" });
		const check = async (table: boolean) => {
			await waitFor(() => {
				expect(page.textContent).toContain(table ? "Table label" : "Base label");
				expect(page.textContent).not.toContain(table ? "Base label" : "Table label");
				expect(page.textContent).toContain(
					table ? "/Game/Text/Table.Table" : "/Game/Text/Base.Base"
				);
				expect(page.textContent).not.toContain(
					table ? "/Game/Text/Base.Base" : "/Game/Text/Table.Table"
				);
			});
			const properties = within(page).getByRole("region", { name: "Properties" });
			expect(properties.textContent).toContain(table ? "Table note" : "Base note");
			expect(properties.textContent).not.toContain(table ? "Base note" : "Table note");
			expect(properties.textContent).toContain(table ? "Editable" : "Read only");
			expect(properties.textContent).not.toContain("Shared");
			expect(page.textContent).not.toContain("Conflicting");
			expect(page.textContent).toContain("1 location");
		};
		await check(!!firstIsTable);
		await user.click(within(page).getByRole("button", { name: "Next line" }));
		await check(!firstIsTable);
		await user.click(within(page).getByRole("button", { name: "Previous line" }));
		await check(!!firstIsTable);
	});

	it.each([["without grouping", true] as const, ["grouped", false] as const])(
		"does not reopen a line only in the gather when the list is back first, %s",
		async (_name, flat) => {
			const empty = corpus([]);
			const gathered = joinLocalizationTarget(
				empty,
				evidence(
					Array.from({ length: 62 }, (_, index) =>
						manifestEntry(
							"Code" + index.toString().padStart(3, "0"),
							"Code line " + index,
							`Source/Example.cpp(${index + 1})`
						)
					),
					[]
				)
			);
			const listed = [
				linesAnswer(
					gathered.lines.map((line) => ({
						line: linePreview(line, { problems: ["up_to_date"] }),
						groups: { problem: "up_to_date" }
					})),
					{ key: "up_to_date", label: "Up to date", worst: "up_to_date" }
				)
			];
			const later = Effect.runSync(Deferred.make<void>());
			const user = userEvent.setup({ delay: null });
			mount({
				...client(),
				localizationFocus: (request) => {
					const line = gathered.lines.find(
						(item) =>
							request.selection.kind === "line" && item.id === request.selection.id
					);
					return Effect.succeed(
						line
							? {
									status: "found",
									focus: localizationFocusPage(gathered, line, request)
								}
							: { status: "not_found" }
					);
				},
				search: (request) =>
					(request.cursor || request.localizationCursor
						? Deferred.await(later)
						: Effect.void
					).pipe(
						Effect.as({ status: "ready" as const, page: cannedPage(listed, request) })
					)
			});
			await screen.findByText("62 matches");
			await groupRows();
			if (flat) {
				await user.click(screen.getByRole("button", { name: "Display" }));
				await user.click(screen.getByRole("radio", { name: "No grouping" }));
				await user.keyboard("{Escape}");
				await waitFor(() =>
					expect(screen.queryByRole("radiogroup", { name: "Group by" })).toBeNull()
				);
			}
			await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
			const results = screen.getByRole("region", { name: "Results" });
			const rows = () =>
				within(results)
					.queryAllByRole("button")
					.filter((button) => button.hasAttribute("data-row"));
			await waitFor(() => expect(rows()).toHaveLength(50));
			await user.click(rows()[49]!);
			const page = screen.getByRole("complementary", { name: "Text focus" });
			await within(page).findByText("50 of 62");
			await user.click(within(page).getByRole("button", { name: "Next line" }));
			await user.click(within(page).getByRole("button", { name: /Lines$/u }));
			await waitFor(() => expect(screen.queryByText("50 of 62")).toBeNull());
			Effect.runSync(Deferred.succeed(later, undefined));
			await waitFor(() => expect(rows()).toHaveLength(62));
			expect(screen.queryByText("51 of 62")).toBeNull();
			expect(rows().every((row) => row.getAttribute("aria-current") !== "true")).toBe(true);
		}
	);
});
describe("Game Text translation editing", () => {
	function editingClient(respond: (request: LocalizationEditRequest) => LocalizationEditResult) {
		const requests: LocalizationEditRequest[] = [];
		const api: GameTextClientApi = {
			...client(),
			localizationEdits: (request) => {
				requests.push(request);
				return Effect.succeed(respond(request));
			}
		};
		return { api, requests };
	}
	const frenchPO = "Content/Localization/Fixture/fr/Fixture.po";

	async function stageFrench(user: ReturnType<typeof userEvent.setup>) {
		await screen.findByText("3 matches");
		await groupRows();
		const results = screen.getByRole("region", { name: "Results" });
		await user.click(within(results).getByRole("button", { name: /^Welcome/u }));
		const translations = await screen.findByRole("region", { name: "Translations" });
		const english = await within(translations).findByRole("article", {
			name: "Translation en"
		});
		// The native culture's text is its source; it is never edited here.
		expect(within(english).queryByRole("button", { name: "Edit" })).toBeNull();
		const french = within(translations).getByRole("article", { name: "Translation fr" });
		await user.click(within(french).getByRole("button", { name: "Edit" }));
		const field = within(french).getByRole("textbox", { name: "New fr translation" });
		expect(field).toHaveProperty("value", "Bienvenue");
		expect(within(french).getByRole("button", { name: "Stage" })).toHaveProperty(
			"disabled",
			true
		);
		await user.clear(field);
		await user.type(field, "Bon retour");
		await user.click(within(french).getByRole("button", { name: "Stage" }));
		expect(within(french).getByText("Staged: Bon retour")).toBeDefined();
	}

	it("stages an edit against the translation that ships, checks it, and writes it", async () => {
		const user = userEvent.setup({ delay: null });
		const outcome = (request: LocalizationEditRequest) =>
			request.edits.map((edit) => ({
				culture: edit.culture,
				namespace: edit.namespace,
				key: edit.key,
				outcome: "ready" as const,
				currentTranslation: edit.seenTranslation,
				translation: edit.translation
			}));
		const { api, requests } = editingClient((request) =>
			request.mode === "review"
				? {
						status: "reviewed",
						edits: outcome(request),
						files: [
							{
								culture: cultureCode("fr"),
								relativePath: frenchPO,
								changes: 1,
								written: false
							}
						],
						notSynced: 1
					}
				: {
						status: "written",
						edits: outcome(request),
						files: [
							{
								culture: cultureCode("fr"),
								relativePath: frenchPO,
								changes: 1,
								written: true
							}
						],
						notSynced: 2
					}
		);
		mount(api);
		await stageFrench(user);
		await user.click(screen.getByRole("button", { name: "1 staged" }));
		const panel = screen.getByRole("region", { name: "Staged translations" });
		expect(within(panel).getByText("Bienvenue")).toBeDefined();
		expect(within(panel).getByText("Bon retour")).toBeDefined();
		// Writing is only offered after the edits were checked against the project's files.
		expect(within(panel).getByRole("button", { name: "Write to PO" })).toHaveProperty(
			"disabled",
			true
		);
		await user.click(within(panel).getByRole("button", { name: "Check changes" }));
		await within(panel).findByText("Ready to write");
		expect(within(panel).getByText(frenchPO)).toBeDefined();
		expect(requests[0]).toEqual({
			target: target.name,
			mode: "review",
			edits: [
				{
					culture: "fr",
					namespace: "NS",
					key: "K",
					seenTranslation: "Bienvenue",
					translation: "Bon retour"
				}
			]
		});
		await user.click(within(panel).getByRole("button", { name: "Write to PO" }));
		await screen.findByText(
			"Wrote 1 translation to 1 PO file. They are not synced until you sync with Unreal."
		);
		expect(requests[1]?.mode).toBe("write");
		expect(screen.queryByRole("button", { name: "1 staged" })).toBeNull();
	});
});
