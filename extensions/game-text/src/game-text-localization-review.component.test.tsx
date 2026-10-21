import { screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	applyLocalizationKeyChanges,
	applyLocalizationReview,
	joinLocalizationTarget,
	localizationFocusPage,
	localizationKeyChanges,
	localizationLineFingerprint,
	type LocalizationEditRequest,
	type LocalizationReviewRequest
} from "@ue-shed/game-text/corpus";
import { type TextCorpusSearchRequest } from "@ue-shed/game-text/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	target,
	unit
} from "../../../packages/game-text/src/localization.test-support.js";
import { textCorpusQuery } from "../../../packages/game-text/src/query.test-support.js";
import {
	emptyLocalizationReviewFile,
	updateLocalizationReviewFile
} from "../../../packages/localization/src/review-file.js";
import type { GameTextClientApi } from "./game-text-client.js";
import {
	chooseFilter,
	client,
	filterValues,
	joined,
	mount,
	plain,
	text
} from "./game-text-localization.test-support.js";
describe("Game Text review state", () => {
	const lineK = joined.lines.find((line) => line.identity?.key === "K");
	const markOf = (culture: string) => lineK?.cultures.find((mark) => mark.culture === culture);
	const french = markOf("fr");
	const german = markOf("de");
	if (!lineK?.identity || !french || !german) throw new Error("Missing review fixture line.");
	const reviewFile = updateLocalizationReviewFile(
		emptyLocalizationReviewFile(target.name),
		[
			{
				kind: "set",
				culture: french.culture,
				namespace: lineK.identity.namespace,
				key: lineK.identity.key,
				flags: ["reviewed"],
				fingerprint: localizationLineFingerprint(lineK, french)
			},
			{
				kind: "set",
				culture: german.culture,
				namespace: lineK.identity.namespace,
				key: lineK.identity.key,
				flags: ["reviewed", "proofread"],
				// Reviewed against older text, so it now reads as changed since review.
				fingerprint: "0".repeat(64)
			}
		],
		{ by: "reviewer", at: "2026-10-08T00:00:00.000Z" }
	);
	const reviewed = applyLocalizationReview(joined, reviewFile);
	const reviewedQuery = textCorpusQuery(text, undefined, reviewed);

	function reviewClient() {
		const requests: LocalizationReviewRequest[] = [];
		const api: GameTextClientApi = {
			...client(),
			search: (request) =>
				Effect.succeed({
					status: "ready",
					page: (request.localization ? reviewedQuery : plain).search(request)
				}),
			localizationFocus: (request) => {
				const id =
					request.selection.kind === "line"
						? request.selection.id
						: reviewedQuery.focus({ id: request.selection.id, pageSize: 1 })
								?.localization?.id;
				const line = id ? reviewedQuery.localizationFocus(id) : undefined;
				return Effect.succeed(
					line
						? { status: "found", focus: localizationFocusPage(reviewed, line, request) }
						: { status: "not_found" }
				);
			},
			localizationReview: (request) => {
				requests.push(request);
				return Effect.succeed({ status: "written", relativePath: "Config/Review.json" });
			}
		};
		return { api, requests };
	}

	it("shows review lenses, current and changed review, and toggles a flag", async () => {
		const user = userEvent.setup({ delay: null });
		const { api, requests } = reviewClient();
		mount(api);
		await screen.findByText("3 matches");
		const review = await filterValues(user, "Review");
		expect(review).toContain("Changed since review 1");
		expect(review).toContain("Reviewed 1");
		const results = screen.getByRole("region", { name: "Results" });
		await user.click(within(results).getByRole("button", { name: /^Welcome/u }));
		const translations = await screen.findByRole("region", { name: "Translations" });
		const frenchCard = await within(translations).findByRole("article", {
			name: "Translation fr"
		});
		const frenchReview = within(frenchCard).getByLabelText("Review fr");
		expect(
			within(frenchReview)
				.getByRole("button", { name: "Reviewed" })
				.getAttribute("aria-pressed")
		).toBe("true");
		expect(within(frenchReview).getByText("by reviewer")).toBeDefined();
		const germanCard = within(translations).getByRole("article", { name: "Translation de" });
		expect(
			within(germanCard).getByText("Changed since review (Reviewed, Proofread by reviewer)")
		).toBeDefined();
		await user.click(within(frenchReview).getByRole("button", { name: "Proofread" }));
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(requests[0]).toEqual({
			target: target.name,
			changes: [
				{ kind: "set", culture: "fr", namespace: "NS", key: "K", flags: ["proofread"] }
			]
		});
		// Writing reloads the target; wait for the refreshed controls before the next change.
		const reviewedChip = await waitFor(() => {
			const chip = within(screen.getByLabelText("Review fr")).getByRole("button", {
				name: "Reviewed"
			});
			expect(chip).toHaveProperty("disabled", false);
			return chip;
		});
		await user.click(reviewedChip);
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[1]?.changes[0]).toMatchObject({ kind: "clear", flags: ["reviewed"] });
		await chooseFilter(user, "Review", "Changed since review 1");
		await screen.findByText("1 match");
		// Review state shows as its own chip until review becomes a pill.
		expect(screen.getByRole("button", { name: "Changed since review" })).toBeDefined();
		const filteredResults = screen.getByRole("region", { name: "Results" });
		expect(within(filteredResults).getByRole("button", { name: /^Welcome/u })).toBeDefined();
	});

	it("ticks a range of lines, exports them and marks them reviewed", async () => {
		const user = userEvent.setup({ delay: null });
		const { api, requests } = reviewClient();
		const exports: TextCorpusSearchRequest[] = [];
		mount({
			...api,
			investigations: {
				export: () => Effect.succeed({ status: "cancelled" }),
				save: () => Effect.succeed({ status: "cancelled" }),
				open: () => Effect.succeed({ status: "cancelled" })
			},
			localizationLinesFile: (request) => {
				exports.push(request);
				return Effect.succeed({ status: "saved", path: "C:/out/picked.csv", rowCount: 3 });
			}
		});
		await screen.findByText("3 matches");
		const results = screen.getByRole("region", { name: "Results" });
		const boxes = within(results).getAllByRole("checkbox", { name: /^Select /u });
		expect(boxes).toHaveLength(3);
		await user.click(boxes[0]!);
		// Shift-click ticks every line from the last one ticked.
		await user.keyboard("{Shift>}");
		await user.click(boxes[2]!);
		await user.keyboard("{/Shift}");
		const bar = screen.getByRole("toolbar", { name: "Selected lines" });
		expect(within(bar).getByText("3 selected")).toBeDefined();
		await user.click(within(bar).getByRole("button", { name: "Export for translators" }));
		await within(bar).findByText("Exported 3 lines.");
		expect(exports[0]).toMatchObject({ query: "", capability: "all" });
		expect(exports[0]?.lines).toHaveLength(3);
		expect(exports[0]?.filter).toBeUndefined();
		await user.click(screen.getByRole("button", { name: "Export" }));
		await user.click(await screen.findByRole("button", { name: "All languages (CSV)" }));
		await screen.findByText("Exported 3 rows: C:/out/picked.csv");
		expect(exports[1]?.localization?.target).toBe(target.name);
		// Out-of-date translations are excluded from bulk review even when their old flags changed.
		expect(within(bar).queryByRole("button", { name: /^Mark reviewed/u })).toBeNull();
		expect(requests).toHaveLength(0);
		await user.click(within(bar).getByRole("button", { name: "Clear selection" }));
		expect(screen.queryByRole("toolbar", { name: "Selected lines" })).toBeNull();
	});
});
describe("Game Text key changes", () => {
	const renamedText = corpus([unit("Renamed", "Welcome back")]);
	const renamedBase = joinLocalizationTarget(
		renamedText,
		evidence(
			[manifestEntry("Welcome", "Welcome back")],
			[archiveEntry("Welcome", "Welcome back", "Willkommen zurück")]
		)
	);
	const renamed = applyLocalizationKeyChanges(
		renamedBase,
		localizationKeyChanges(renamedBase, renamedText).pairs
	);
	const renamedQuery = textCorpusQuery(renamedText, undefined, renamed);
	const keyClient = (): GameTextClientApi => ({
		...client(),
		focus: (request) => {
			const focus = renamedQuery.focus(request);
			return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
		},
		search: (request) =>
			Effect.succeed({
				status: "ready",
				page: (request.localization ? renamedQuery : textCorpusQuery(renamedText)).search(
					request
				)
			}),
		localizationFocus: (request) => {
			const id =
				request.selection.kind === "line"
					? request.selection.id
					: renamedQuery.focus({ id: request.selection.id, pageSize: 1 })?.localization
							?.id;
			const line = id ? renamedQuery.localizationFocus(id) : undefined;
			return Effect.succeed(
				line
					? { status: "found", focus: localizationFocusPage(renamed, line, request) }
					: { status: "not_found" }
			);
		}
	});

	it("stages the earlier key's translations for the new key and checks them", async () => {
		const user = userEvent.setup({ delay: null });
		const requests: LocalizationEditRequest[] = [];
		mount({
			...keyClient(),
			localizationEdits: (request) => {
				requests.push(request);
				return Effect.succeed({
					status: "reviewed",
					edits: request.edits.map((edit) => ({
						culture: edit.culture,
						namespace: edit.namespace,
						key: edit.key,
						outcome: "not_in_manifest" as const,
						currentTranslation: null,
						translation: edit.translation
					})),
					files: [],
					notSynced: 0
				});
			}
		});
		await screen.findByText("2 matches");
		await chooseFilter(user, "Problem", "Key changed 1");
		await screen.findByText("1 match");
		const results = screen.getByRole("region", { name: "Results" });
		await user.click(within(results).getByRole("button", { name: /^Welcome back/u }));
		const change = await screen.findByRole("region", { name: "Key change" });
		// The page says the worst problem first, in plain words.
		const needs = screen.getByRole("note", { name: "What this line needs" });
		expect(needs.textContent).toContain("Key changed");
		expect(needs.textContent).toContain("carry them below first");
		expect(
			within(screen.getByRole("region", { name: "Properties" })).queryByText("Key changed")
		).toBeNull();
		expect(change.textContent).toContain("Key changed · was NS,Welcome");
		expect(change.textContent).toContain("same text in this asset");
		expect(change.textContent).toContain("Willkommen zurück");
		await user.click(within(change).getByRole("button", { name: "Carry translations" }));
		expect(within(change).getByRole("status").textContent).toContain("Staged 1 translation.");
		const panel = await screen.findByRole("region", { name: "Staged translations" });
		expect(within(panel).getByText("Willkommen zurück")).toBeDefined();
		await user.click(within(panel).getByRole("button", { name: "Check changes" }));
		await within(panel).findByText("Not gathered: gather the target first");
		// Discarding the staged edits brings the carry action back.
		await user.click(within(panel).getByRole("button", { name: "Discard all" }));
		expect(
			await within(change).findByRole("button", { name: "Carry translations" })
		).toBeDefined();
		expect(requests[0]?.edits).toEqual([
			{
				culture: "de",
				namespace: "NS",
				key: "Renamed",
				seenTranslation: null,
				translation: "Willkommen zurück"
			}
		]);
	});
	it("carries the earlier keys' translations for every ticked line", async () => {
		const user = userEvent.setup({ delay: null });
		mount({
			...keyClient(),
			localizationEdits: () =>
				Effect.succeed({ status: "reviewed", edits: [], files: [], notSynced: 0 })
		});
		await screen.findByText("2 matches");
		const results = screen.getByRole("region", { name: "Results" });
		for (const box of within(results).getAllByRole("checkbox", { name: /^Select /u }))
			await user.click(box);
		const bar = screen.getByRole("toolbar", { name: "Selected lines" });
		await user.click(within(bar).getByRole("button", { name: "Carry translations (1)" }));
		expect(within(bar).getByRole("status").textContent).toBe("Staged 1 translation to carry.");
		const panel = await screen.findByRole("region", { name: "Staged translations" });
		expect(within(panel).getByText("Willkommen zurück")).toBeDefined();
	});
});
