import { indexedTestReports } from "../../../packages/game-text/src/indexed-reports.test-support.js";
import { screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { textQualityQuery } from "@ue-shed/game-text/corpus";
import { STARTER_GAME_TEXT_RULES, type GameTextRuleDocument } from "@ue-shed/game-text/rules";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
	corpus,
	makeClient,
	mount,
	openQuality,
	rulesDocument
} from "./game-text-route.test-support.js";
it("highlights terminology, shows its asset in Unreal and opens the matching line in Text", async () => {
	const user = userEvent.setup({ delay: null });
	const located: string[] = [];
	const client = makeClient();
	mount({
		...client,
		locateAsset: (path) => {
			located.push(path);
			return client.locateAsset(path);
		}
	});
	const findings = await openQuality(user);
	await user.click(screen.getByRole("button", { name: /^Terminology/ }));
	await waitFor(() => expect(within(findings).getAllByRole("button")).toHaveLength(1));
	await user.click(within(findings).getByRole("button"));
	const detail = screen.getByRole("complementary", { name: "Finding detail" });
	await waitFor(() => expect(detail.querySelector("mark")?.textContent).toBe("Quit"));
	expect(detail.textContent).toContain("How to fix");
	expect(within(detail).getByRole("button", { name: "Copy asset path" })).toBeDefined();
	await user.click(within(detail).getByRole("button", { name: "Show in Unreal" }));
	await within(detail).findByText("Shown in Unreal’s Content Browser.");
	expect(located).toEqual(["/Game/Text/DT_Menu.DT_Menu"]);
	await user.click(within(detail).getByRole("button", { name: "Show key and translator notes" }));
	await screen.findByRole("heading", { name: "Quit game?" });
	expect(screen.getByRole("tab", { name: "Text" }).getAttribute("aria-selected")).toBe("true");
});
it("retains every editable rule field, term actions, preview and save", async () => {
	const user = userEvent.setup({ delay: null });
	const client = makeClient();
	const previews: GameTextRuleDocument[] = [];
	const saves: GameTextRuleDocument[] = [];
	mount({
		...client,
		previewQualityRules: (draft) => {
			previews.push(draft);
			return client.previewQualityRules(draft);
		},
		saveQualityRules: (draft) => {
			saves.push(draft);
			return client.saveQualityRules(draft);
		}
	});
	await openQuality(user);
	await user.click(screen.getByRole("button", { name: "Edit rules" }));
	const maximum = await screen.findByRole("spinbutton", {
		name: "Maximum characters for example-limit"
	});
	await user.clear(maximum);
	await user.type(maximum, "12");
	const rules = screen.getByRole("complementary", { name: "Quality rule list" });
	await user.click(within(rules).getByRole("button", { name: /example-terms/u }));
	await user.click(screen.getByRole("checkbox", { name: "Case-sensitive matching" }));
	const preferred = screen.getByRole("textbox", { name: "Preferred term 1" });
	await user.clear(preferred);
	await user.type(preferred, "Leave");
	const alternatives = screen.getByRole("textbox", {
		name: "Alternatives for preferred term 1"
	});
	await user.clear(alternatives);
	await user.type(alternatives, "Quit, Depart");
	await user.click(screen.getByRole("button", { name: "Add forbidden term" }));
	await user.type(screen.getByRole("textbox", { name: "Forbidden term 2" }), "obsolete");
	await user.click(screen.getByRole("button", { name: "Add preferred term" }));
	await user.type(screen.getByRole("textbox", { name: "Preferred term 3" }), "Continue");
	await user.clear(screen.getByRole("textbox", { name: "Alternatives for preferred term 3" }));
	await user.type(
		screen.getByRole("textbox", { name: "Alternatives for preferred term 3" }),
		"proceed"
	);
	const recovery = screen.getByRole("textbox", {
		name: "Recovery guidance for example-terms"
	});
	await user.clear(recovery);
	await user.type(recovery, "Use the example wording.");
	await user.click(screen.getByRole("button", { name: "Preview" }));
	await screen.findByText("Preview updated.", { exact: false });
	expect(previews.at(-1)?.rules).toEqual([
		{ ...rulesDocument.rules[0], maximumCharacters: 12 },
		{
			...rulesDocument.rules[1],
			caseSensitive: true,
			recovery: "Use the example wording.",
			terms: [
				{ kind: "preferred", term: "Leave", alternatives: ["Quit", "Depart"] },
				{ kind: "forbidden", term: "obsolete" },
				{ kind: "preferred", term: "Continue", alternatives: ["proceed"] }
			]
		}
	]);
	expect(
		screen.getByRole("complementary", { name: "Quality role scopes" }).textContent
	).toContain("/Game/");
	await user.click(screen.getByRole("button", { name: "Remove term 2" }));
	expect(screen.queryByRole("textbox", { name: "Forbidden term 2" })).toBeNull();
	await user.click(screen.getByRole("button", { name: "Save" }));
	await screen.findByText("Rule file saved.", { exact: false });
	expect(saves).toHaveLength(1);
	expect(saves[0]?.rules[1]).toMatchObject({
		caseSensitive: true,
		terms: [
			{ kind: "preferred", term: "Leave", alternatives: ["Quit", "Depart"] },
			{ kind: "preferred", term: "Continue", alternatives: ["proceed"] }
		],
		recovery: "Use the example wording."
	});
});
it("offers to load an existing starter rules file and labels invalid rules", async () => {
	const user = userEvent.setup({ delay: null });
	const loaded = textQualityQuery(indexedTestReports(corpus).source(STARTER_GAME_TEXT_RULES));
	const requested: boolean[] = [];
	mount(
		makeClient(corpus, {
			createStarterRules: (loadExisting) => {
				requested.push(loadExisting);
				return Effect.succeed(
					loadExisting
						? {
								status: "completed",
								document: STARTER_GAME_TEXT_RULES,
								summary: loaded.summary()
							}
						: {
								status: "failed",
								error: {
									code: "already_exists",
									message: "The rules file already exists.",
									recovery: "Load it to use its writing checks.",
									retrySafe: true
								}
							}
				);
			},
			qualitySearch: (request) =>
				Effect.succeed({
					status: "ready",
					page: loaded.search(request)
				}),
			qualityFocus: (request) => {
				const focus = loaded.focus(request);
				return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
			},
			chooseQualityRules: () =>
				Effect.succeed({
					status: "failed",
					error: {
						code: "invalid_rules",
						message: "Invalid rules.",
						recovery: "Correct the file.",
						retrySafe: true
					}
				})
		})
	);
	await screen.findByText("2 matches");
	await user.click(screen.getByRole("tab", { name: "Quality checks" }));
	await user.click(screen.getByRole("button", { name: "Create rules file" }));
	await screen.findByRole("button", { name: "Load existing rules" });
	await user.click(screen.getByRole("button", { name: "Choose a rules file…" }));
	await screen.findByRole("tab", { name: "Quality checks, rules invalid" });
	await user.click(screen.getByRole("button", { name: "Create rules file" }));
	await user.click(await screen.findByRole("button", { name: "Load existing rules" }));
	await screen.findByRole("table", { name: "Rules overview" });
	expect(requested).toEqual([false, false, true]);
});
