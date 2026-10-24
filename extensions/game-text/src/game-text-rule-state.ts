import type { TextQualityRuleUpdateResult } from "@ue-shed/game-text/corpus";
import type { GameTextRuleDocument } from "@ue-shed/game-text/rules";
import { createEffectAction } from "@ue-shed/ui";
import { createMemo, createSignal } from "solid-js";
import { failureText } from "./game-text-failure.js";
import type { GameTextClientApi } from "./game-text-client.js";

export interface RuleEditorState {
	readonly draft: GameTextRuleDocument;
	readonly savedDocument?: GameTextRuleDocument | undefined;
}

type EditorFeedback =
	| { readonly status: "idle" }
	| { readonly status: "previewed" }
	| { readonly status: "saved" }
	| { readonly message: string; readonly recovery?: string; readonly status: "failed" };

/** Owned by the route so draft state and in-flight saves survive editor tab changes. */
export function createGameTextRuleState(options: {
	readonly client: GameTextClientApi;
	readonly initialState?: RuleEditorState | undefined;
	readonly onReviewed: (
		result: Extract<TextQualityRuleUpdateResult, { status: "completed" }>
	) => void;
}) {
	const action = createEffectAction();
	let baseline = options.initialState?.draft;
	const [state, setState] = createSignal(options.initialState);
	const [fileAttached, setFileAttached] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const [feedback, setFeedback] = createSignal<EditorFeedback>({ status: "idle" });
	const dirty = createMemo(() => {
		const current = state();
		return (
			current !== undefined &&
			JSON.stringify(current.draft) !== JSON.stringify(current.savedDocument)
		);
	});
	const problems = createMemo(() => (state()?.draft ? draftProblems(state()?.draft) : []));
	const replace = (document: GameTextRuleDocument | undefined, persisted = true) => {
		action.cancel();
		baseline = document;
		setFileAttached(persisted && document !== undefined);
		setState(document ? { draft: document, savedDocument: document } : undefined);
		setBusy(false);
		setFeedback({ status: "idle" });
	};
	const changeDraft = (draft: GameTextRuleDocument) => {
		setState((current) => ({ draft, savedDocument: current?.savedDocument }));
		setFeedback({ status: "idle" });
	};
	const run = (operation: "preview" | "save" | "discard", document?: GameTextRuleDocument) => {
		const submitted = document ?? state()?.draft;
		if (!submitted || busy()) return;
		const issues = draftProblems(submitted);
		if (issues.length) {
			setFeedback({
				message: issues.map((issue) => issue.message).join("\n"),
				status: "failed"
			});
			return;
		}
		setBusy(true);
		setFeedback({ status: "idle" });
		action.run(
			operation !== "save"
				? options.client.previewQualityRules(submitted)
				: options.client.saveQualityRules(submitted),
			{
				onFailure: (cause) => {
					setBusy(false);
					setFeedback({
						message: failureText("The rules couldn’t be checked.", cause),
						status: "failed"
					});
				},
				onSuccess: (result) => {
					setBusy(false);
					if (result.status === "completed") {
						setState((current) => ({
							draft:
								current?.draft === submitted
									? result.document
									: (current?.draft ?? result.document),
							savedDocument:
								operation === "save" || operation === "discard"
									? result.document
									: current?.savedDocument
						}));
						options.onReviewed(result);
						setFeedback({
							status:
								operation === "save"
									? "saved"
									: operation === "discard"
										? "idle"
										: "previewed"
						});
					} else if (result.status === "failed") {
						setFeedback({
							message: result.error.message,
							recovery: result.error.recovery,
							status: "failed"
						});
					} else {
						setFeedback(
							fileAttached()
								? {
										message:
											"The project changed while the rules were checked.",
										recovery: "Wait for the scan to finish, then try again.",
										status: "failed"
									}
								: {
										message: "No rules file is attached.",
										recovery: "Choose a rules file, then save again.",
										status: "failed"
									}
						);
					}
				}
			}
		);
	};
	// Whether a rules file is attached is the host's to say; a restored draft keeps that answer.
	const restore = (saved: RuleEditorState) => {
		action.cancel();
		setState(saved);
		setBusy(false);
		setFeedback({ status: "idle" });
	};
	const discard = () => {
		const document = state()?.savedDocument ?? baseline;
		if (!document || busy()) return;
		setState({ draft: document, savedDocument: document });
		setFeedback({ status: "idle" });
		run("discard", document);
	};
	return {
		state,
		fileAttached,
		attachFile: setFileAttached,
		busy,
		dirty,
		problems,
		feedback,
		replace,
		restore,
		discard,
		changeDraft,
		run
	};
}

export type GameTextRuleState = ReturnType<typeof createGameTextRuleState>;

/**
 * A typed character limit. An empty or unreadable field is 0, which validation reports, so the
 * field can be cleared and retyped and the draft always stores a finite number.
 */
export function typedLimit(text: string): number {
	const value = Number(text);
	return text.trim() === "" || !Number.isFinite(value) ? 0 : value;
}

/** A limit as its field shows it: blank until a usable number is typed. */
export function shownLimit(value: number | undefined): number | "" {
	return value === undefined || value <= 0 ? "" : value;
}

export interface RuleDraftProblem {
	readonly ruleId: string;
	readonly field: string;
	readonly message: string;
}
/** A rule field's `aria-invalid` value: whether validation reported a problem with it. */
export function invalidField(
	problems: readonly RuleDraftProblem[] | undefined,
	ruleId: string,
	field: string
): "true" | "false" {
	return problems?.some((issue) => issue.ruleId === ruleId && issue.field === field)
		? "true"
		: "false";
}
export function draftProblems(
	document: GameTextRuleDocument | undefined
): readonly RuleDraftProblem[] {
	if (!document) return [];
	const problems: RuleDraftProblem[] = [];
	for (const rule of document.rules) {
		if (!("recovery" in rule)) continue;
		const add = (field: string, message: string) =>
			problems.push({ ruleId: rule.id, field, message: `${rule.id}: ${message}` });
		if (!rule.recovery.trim())
			add("recovery", "Add recovery guidance before previewing or saving.");
		const budget = (value: number, field: string) => {
			if (!Number.isSafeInteger(value) || value < 1)
				add(field, "Use a whole-number character limit of at least 1.");
		};
		const terms = (
			entries: readonly {
				readonly kind: string;
				readonly term: string;
				readonly alternatives?: readonly string[];
			}[],
			field: string
		) => {
			if (!entries.length) add(field, "Add at least one terminology entry.");
			entries.forEach((term, index) => {
				if (!term.term.trim()) add(field, `Term ${index + 1} is empty.`);
				if (
					term.kind === "preferred" &&
					(!term.alternatives?.length ||
						term.alternatives.some((alternative) => !alternative.trim()))
				)
					add(field, `Preferred term ${index + 1} needs non-empty alternatives.`);
			});
		};
		if (rule.kind === "character_budget") budget(rule.maximumCharacters, "maximumCharacters");
		if (rule.kind === "terminology") terms(rule.terms, "terms");
		if (rule.kind === "localization_character_budget") {
			if (rule.defaultMaximumCharacters !== undefined)
				budget(rule.defaultMaximumCharacters, "defaultMaximumCharacters");
			for (const [culture, value] of Object.entries(rule.cultures)) budget(value, culture);
		}
		if (rule.kind === "localization_terminology")
			for (const [culture, entries] of Object.entries(rule.cultures)) terms(entries, culture);
	}
	return problems;
}
