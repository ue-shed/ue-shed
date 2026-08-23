// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	TextQualityFindingId,
	TextQualityRuleId,
	TextQualityRuleDocument,
	TextRoleId,
	type TextCorpus,
	type TextCorpusFocusResult,
	type TextCorpusQueryRunResult,
	type TextCorpusSearchResult
} from "@ue-shed/game-text/browser";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GameTextClientError, type GameTextClientApi } from "./game-text-client.js";
import { GameTextRoute } from "./game-text-query-route.js";

const corpus: TextCorpus = {
	coverage: {
		discoveredPackages: 2,
		failedPackages: 0,
		inspectedPackages: 2,
		partialPackages: 0,
		resolvedOccurrences: 2,
		textOccurrences: 2,
		textUnits: 2,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [],
	schemaVersion: 1,
	status: "complete",
	units: [
		{
			id: makeTextUnitId("unreal:UI:Continue"),
			identity: { key: "Continue", namespace: "UI", status: "resolved" },
			occurrences: [
				{
					editCapability: "source_editable",
					id: makeTextOccurrenceId("occurrence:continue"),
					identity: { key: "Continue", namespace: "UI", status: "resolved" },
					location: {
						entryKey: "PromptContinue",
						kind: "string_table_entry",
						objectPath: "/Game/Text/ST_Game.ST_Game"
					},
					packageFile: "Content/Text/ST_Game.uasset",
					source: "Continue"
				}
			],
			source: { status: "consistent", value: "Continue" }
		},
		{
			id: makeTextUnitId("unreal:UI:Quit"),
			identity: { key: "Quit", namespace: "UI", status: "resolved" },
			occurrences: [
				{
					editCapability: "read_only",
					id: makeTextOccurrenceId("occurrence:quit"),
					identity: { key: "Quit", namespace: "UI", status: "resolved" },
					location: {
						kind: "data_table_cell",
						objectPath: "/Game/Text/DT_Menu.DT_Menu",
						propertyPath: "Prompt",
						row: "Quit"
					},
					packageFile: "Content/Text/DT_Menu.uasset",
					source: "Quit game?"
				}
			],
			source: { status: "consistent", value: "Quit game?" }
		}
	]
};

const summary = {
	coverage: corpus.coverage,
	diagnosticCount: 0,
	review: {
		all: 2,
		conflicting: 0,
		duplicateSource: 0,
		long: 0,
		shared: 0,
		unresolved: 0
	},
	schemaVersion: 1,
	sources: { assetProperty: 0, dataTable: 1, mixed: 0, stringTable: 1 },
	status: "complete"
} as const;

const completed = { status: "completed", summary } satisfies TextCorpusQueryRunResult;

function resultFor(unit: TextCorpus["units"][number]) {
	const contexts = unit.occurrences.slice(0, 3).map((occurrence) => ({
		editCapability: occurrence.editCapability,
		location: occurrence.location
	}));
	return {
		characterCount:
			unit.source.status === "consistent"
				? unit.source.value.length
				: unit.source.values.join(" ").length,
		contexts,
		id: unit.id,
		identity: unit.identity,
		locationKinds: [...new Set(unit.occurrences.map((occurrence) => occurrence.location.kind))],
		occurrenceCount: unit.occurrences.length,
		remainingContextCount: Math.max(0, unit.occurrences.length - contexts.length),
		reviewSignals: unit.occurrences.every(
			(occurrence) => occurrence.editCapability === "read_only"
		)
			? (["evidence_only"] as const)
			: [],
		source: unit.source,
		wordCount: unit.source.status === "consistent" ? unit.source.value.split(/\s+/u).length : 0
	};
}

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

function makeClient(overrides: Partial<GameTextClientApi> = {}): GameTextClientApi {
	return {
		chooseQualityRules: () => Effect.succeed({ status: "not_ready" }),
		chooseProjectAndScan: () => Effect.succeed(completed),
		loadConfiguredProject: () => Effect.succeed(completed),
		progress: () =>
			Effect.succeed({
				completed: 1,
				phase: "ready",
				stage: "game_text",
				total: 1
			}),
		search: (request) => {
			const terms = request.query.toLocaleLowerCase();
			const units = corpus.units.filter(
				(unit) =>
					unit.source.status === "consistent" &&
					unit.source.value.toLocaleLowerCase().includes(terms) &&
					(request.capability === "all" ||
						unit.occurrences.some(
							(occurrence) => occurrence.editCapability === request.capability
						))
			);
			return Effect.succeed({
				page: { total: units.length, units: units.map(resultFor) },
				status: "ready"
			} satisfies TextCorpusSearchResult);
		},
		focus: (request) => {
			const unit = corpus.units.find((candidate) => candidate.id === request.id);
			const result = unit
				? {
						focus: {
							diagnostics: [],
							occurrences: unit.occurrences,
							totalOccurrences: unit.occurrences.length,
							unit: resultFor(unit)
						},
						status: "found"
					}
				: { status: "not_found" };
			// SAFETY: both branches above construct the complete discriminated TextCorpusFocusResult.
			return Effect.succeed(result as TextCorpusFocusResult);
		},
		locateAsset: (objectPath) =>
			Effect.succeed({
				contract: {
					name: "unreal-editor-asset-navigation",
					version: { major: 1, minor: 0 }
				},
				objectPath,
				status: "located"
			}),
		qualityFocus: () => Effect.succeed({ status: "not_ready" }),
		qualitySearch: () => Effect.succeed({ status: "not_ready" }),
		previewQualityRules: () => Effect.succeed({ status: "not_ready" }),
		saveQualityRules: () => Effect.succeed({ status: "not_ready" }),
		...overrides
	};
}

function renderRoute(client = makeClient()) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute client={client} />
		</EffectRuntimeProvider>
	));
}

describe("GameTextRoute interactions", () => {
	it("uses the Workbench project selection rather than exposing a second chooser", async () => {
		renderRoute();
		await screen.findByRole("region", { name: "Results" });
		expect(screen.queryByRole("button", { name: "Choose project" })).toBeNull();
	});

	it("searches results and moves focus through user-visible controls", async () => {
		const user = userEvent.setup();
		renderRoute();
		const results = await screen.findByRole("region", { name: "Results" });
		const focus = screen.getByRole("complementary", { name: "Text focus" });

		expect(screen.getByRole("complementary", { name: "Text focus" }).textContent).toContain(
			"Continue"
		);
		expect(
			within(results).getByRole("button", {
				name: "Open package for Continue"
			})
		).toBeDefined();
		await user.click(
			within(results).getByRole("button", {
				name: "Open package for Quit game?"
			})
		);
		expect(focus.textContent).toContain("Quit game?");
		expect(focus.textContent).toContain("Menu · Quit");
		expect(focus.textContent).toContain("Prompt field");

		await user.type(screen.getByRole("searchbox", { name: "Search game text" }), "Continue");
		await waitFor(() => {
			const currentResults = screen.getByRole("region", { name: "Results" });
			expect(
				within(currentResults).queryByRole("button", {
					name: /Open package for Quit game\?/
				})
			).toBeNull();
			expect(
				within(currentResults).getByRole("button", {
					name: /Open package for Continue/
				})
			).toBeDefined();
		});
		expect(screen.getByRole("complementary", { name: "Text focus" }).textContent).toContain(
			"Continue"
		);
	});

	it("keeps the search input focused while an async page replaces its results", async () => {
		const user = userEvent.setup();
		renderRoute();
		const input = await screen.findByRole<HTMLInputElement>("searchbox", {
			name: "Search game text"
		});

		await user.click(input);
		await user.type(input, "Continue");

		await waitFor(() => {
			expect(input.value).toBe("Continue");
			expect(document.activeElement).toBe(input);
		});
	});

	it("packs identity and useful copy actions into each result", async () => {
		const user = userEvent.setup();
		renderRoute();
		const results = await screen.findByRole("region", { name: "Results" });

		expect(screen.getByText("Unreal identity")).toBeDefined();
		expect(within(results).getByText(/Shared String Table entry/)).toBeDefined();
		expect(within(results).getByText("UI · Continue")).toBeDefined();

		const copyText = within(results).getByRole("button", {
			name: "Copy source text Continue"
		});
		await user.click(copyText);
		await waitFor(() => expect(copyText.textContent).toBe("Copied"));
		expect(await navigator.clipboard.readText()).toBe("Continue");

		const copyIdentity = within(results).getByRole("button", {
			name: "Copy Unreal identity UI · Continue"
		});
		await user.click(copyIdentity);
		await waitFor(() => expect(copyIdentity.textContent).toBe("Copied"));
		expect(await navigator.clipboard.readText()).toBe("UI · Continue");
	});

	it("locates a single-use text asset through the live editor capability", async () => {
		const user = userEvent.setup();
		renderRoute();
		const results = await screen.findByRole("region", { name: "Results" });
		const locate = within(results).getByRole("button", {
			name: "Open package for Continue"
		});

		await user.click(locate);

		await waitFor(() => expect(locate.textContent).toBe("Opened"));
		expect(screen.getByRole("complementary", { name: "Text focus" }).textContent).toContain(
			"Opened"
		);
	});

	it("switches between editable and read-only authority filters", async () => {
		const user = userEvent.setup();
		renderRoute();
		await screen.findByRole("region", { name: "Results" });
		const readOnly = screen.getByRole("button", { name: "Read only" });

		await user.click(readOnly);
		expect(readOnly.getAttribute("aria-pressed")).toBe("true");
		await waitFor(() => {
			const currentResults = screen.getByRole("region", { name: "Results" });
			expect(
				within(currentResults).getByRole("button", {
					name: /Open package for Quit game\?/
				})
			).toBeDefined();
			expect(
				within(currentResults).queryByRole("button", {
					name: /Open package for Continue/
				})
			).toBeNull();
		});

		const editable = screen.getByRole("button", { name: "Source editable" });
		await user.click(editable);
		expect(editable.getAttribute("aria-pressed")).toBe("true");
		await waitFor(() => {
			const currentResults = screen.getByRole("region", { name: "Results" });
			expect(
				within(currentResults).getByRole("button", {
					name: /Open package for Continue/
				})
			).toBeDefined();
			expect(
				within(currentResults).queryByRole("button", {
					name: /Open package for Quit game\?/
				})
			).toBeNull();
		});
	});

	it("loads project-authored rules and reviews typed findings in the Workbench", async () => {
		const user = userEvent.setup();
		const qualitySummary = {
			characterBudgetCount: 1,
			coverage: {
				...corpus.coverage,
				partialPackages: 1,
				unsupportedTextProperties: 2
			},
			diagnosticCount: 1,
			findingCount: 2,
			roles: [
				{ matchedOccurrences: 2, matchedTextUnits: 2, role: TextRoleId.make("menu.prompt") }
			],
			ruleDocumentVersion: 1 as const,
			rules: [
				{ findingCount: 1, ruleId: TextQualityRuleId.make("menu.prompt.characters") },
				{ findingCount: 1, ruleId: TextQualityRuleId.make("menu.prompt.terms") }
			],
			schemaVersion: 1 as const,
			status: "partial" as const,
			terminologyCount: 1
		};
		const roleId = TextRoleId.make("menu.prompt");
		const budgetRuleId = TextQualityRuleId.make("menu.prompt.characters");
		const terminologyRuleId = TextQualityRuleId.make("menu.prompt.terms");
		const qualityDocument = TextQualityRuleDocument.make({
			roles: [
				{
					description: "Player-facing menu prompts",
					id: roleId,
					scopes: [
						{
							matchers: [
								{ kind: "location_kind", value: "string_table_entry" },
								{ kind: "string_table_entry", operator: "prefix", value: "Prompt" }
							]
						}
					]
				}
			],
			rules: [
				{
					id: budgetRuleId,
					kind: "character_budget",
					maximumCharacters: 32,
					recovery: "Shorten the prompt while keeping the action clear.",
					role: roleId
				},
				{
					caseSensitive: false,
					id: terminologyRuleId,
					kind: "terminology",
					recovery: "Use the preferred interaction term.",
					role: roleId,
					terms: [{ kind: "preferred", term: "select", alternatives: ["old"] }]
				}
			],
			schemaVersion: 1
		});
		let previewedMaximum = 0;
		let savedMaximum = 0;
		let qualitySearchAttempts = 0;
		let qualityFocusAttempts = 0;
		const budgetFinding = {
			actual: "58 characters",
			expectation: "Maximum 32 characters",
			id: TextQualityFindingId.make("quality-finding:1"),
			kind: "character_budget" as const,
			occurrenceCount: 1,
			recovery: "Shorten the prompt while keeping the action clear.",
			role: "menu.prompt",
			ruleId: "menu.prompt.characters",
			sourceExcerpt: "Press the old button to continue into the next adventure",
			textUnitId: makeTextUnitId("unreal:UI:Continue")
		};
		const terminologyFinding = {
			actual: "“old” at 10–13",
			expectation: "Prefer “select”",
			id: TextQualityFindingId.make("quality-finding:2"),
			kind: "terminology" as const,
			occurrenceCount: 1,
			recovery: "Use the preferred interaction term.",
			role: "menu.prompt",
			ruleId: "menu.prompt.terms",
			sourceExcerpt: "Press the old button to continue",
			textUnitId: makeTextUnitId("unreal:UI:Continue")
		};
		const qualityClient = makeClient({
			chooseQualityRules: () =>
				Effect.succeed({
					document: qualityDocument,
					status: "completed" as const,
					summary: qualitySummary
				}),
			previewQualityRules: (document) => {
				const rule = document.rules.find(
					(candidate) => candidate.kind === "character_budget"
				);
				previewedMaximum = rule?.kind === "character_budget" ? rule.maximumCharacters : 0;
				return Effect.succeed({
					document,
					status: "completed" as const,
					summary: { ...qualitySummary, characterBudgetCount: 0, findingCount: 1 }
				});
			},
			saveQualityRules: (document) => {
				const rule = document.rules.find(
					(candidate) => candidate.kind === "character_budget"
				);
				savedMaximum = rule?.kind === "character_budget" ? rule.maximumCharacters : 0;
				return Effect.succeed({
					document,
					status: "completed" as const,
					summary: { ...qualitySummary, characterBudgetCount: 0, findingCount: 1 }
				});
			},
			qualitySearch: (request) => {
				qualitySearchAttempts += 1;
				if (qualitySearchAttempts === 1) {
					return Effect.fail(
						new GameTextClientError({
							cause: "quality search unavailable",
							operation: "qualitySearch",
							recovery: "Retry the findings query."
						})
					);
				}
				return Effect.succeed({
					page: {
						findings:
							request.filter === "character_budget"
								? [budgetFinding]
								: request.filter === "terminology"
									? [terminologyFinding]
									: [budgetFinding, terminologyFinding],
						total: request.filter === "all" ? 2 : 1
					},
					status: "ready" as const
				});
			},
			qualityFocus: (request) => {
				qualityFocusAttempts += 1;
				if (qualityFocusAttempts === 1) {
					return Effect.fail(
						new GameTextClientError({
							cause: "finding detail unavailable",
							operation: "qualityFocus",
							recovery: "Retry the selected finding."
						})
					);
				}
				return Effect.succeed({
					focus:
						request.id === budgetFinding.id
							? {
									actual: {
										characterCount: 58,
										kind: "character_count" as const
									},
									affectedOccurrences: [
										{
											id: makeTextOccurrenceId("occurrence:continue"),
											location: corpus.units[0]!.occurrences[0]!.location,
											packageFile: "Content/Text/ST_Game.uasset"
										}
									],
									expectation: {
										kind: "maximum_characters" as const,
										maximumCharacters: 32
									},
									id: budgetFinding.id,
									kind: "character_budget" as const,
									recovery: budgetFinding.recovery,
									role: budgetFinding.role,
									ruleId: budgetFinding.ruleId,
									sourceExcerpt: budgetFinding.sourceExcerpt,
									sourceTruncated: false,
									textUnitId: budgetFinding.textUnitId,
									totalOccurrences: 1
								}
							: {
									actual: {
										end: 13,
										kind: "terminology_match" as const,
										start: 10,
										term: "old"
									},
									affectedOccurrences: [],
									expectation: {
										kind: "preferred_term" as const,
										discouragedTerm: "old",
										preferredTerm: "select"
									},
									id: terminologyFinding.id,
									kind: "terminology" as const,
									recovery: terminologyFinding.recovery,
									role: terminologyFinding.role,
									ruleId: terminologyFinding.ruleId,
									sourceExcerpt: terminologyFinding.sourceExcerpt,
									sourceTruncated: false,
									textUnitId: terminologyFinding.textUnitId,
									totalOccurrences: 1
								},
					status: "found" as const
				});
			}
		});
		renderRoute(qualityClient);
		await screen.findByRole("region", { name: "Results" });

		expect(screen.queryByRole("button", { name: "Load rules" })).toBeNull();
		await user.click(screen.getByRole("tab", { name: "Quality" }));
		expect(screen.getByRole("region", { name: "Quality rules setup" })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Load rules" }));
		expect((await screen.findByRole("alert")).textContent).toContain("Couldn’t load findings.");
		expect(qualitySearchAttempts).toBe(1);
		await user.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(qualitySearchAttempts).toBe(2));
		const findings = await screen.findByRole("region", { name: "Findings" });
		expect(within(findings).getByText("58 characters")).toBeDefined();
		expect(await screen.findByText("Couldn’t load finding details.")).toBeDefined();
		expect(qualityFocusAttempts).toBe(1);
		await user.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(qualityFocusAttempts).toBe(2));
		expect(qualitySearchAttempts).toBe(2);
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(screen.getByText(/part of the saved text was checked/i)).toBeDefined();
		expect(screen.getByText(/2 unsupported properties/)).toBeDefined();
		expect(screen.getByRole("button", { name: "Load rules" })).toBeDefined();
		expect(screen.getByRole("complementary", { name: "Finding detail" }).textContent).toContain(
			"Shorten the prompt while keeping the action clear."
		);

		await user.click(screen.getByRole("button", { name: /Terminology/ }));
		await waitFor(() => expect(within(findings).getByText("“old” at 10–13")).toBeDefined());

		await user.click(screen.getByRole("tab", { name: /^Rules/ }));
		expect(screen.getByText("String Table key starts with Prompt")).toBeDefined();
		const maximum = screen.getByRole("spinbutton", {
			name: "Maximum characters for menu.prompt.characters"
		});
		await user.clear(maximum);
		await user.type(maximum, "64");
		await user.click(screen.getByRole("button", { name: "Preview" }));
		await waitFor(() => expect(previewedMaximum).toBe(64));
		expect(screen.getByText(/Changes are not saved yet/)).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(savedMaximum).toBe(64));
		expect(screen.getByText("Rule file saved.")).toBeDefined();
		await user.click(screen.getByRole("tab", { name: "Text" }));
		expect(screen.queryByRole("button", { name: "Load rules" })).toBeNull();
	});
});
