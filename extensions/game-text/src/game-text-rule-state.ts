import type {
	TextQualityRuleDocument,
	TextQualityRuleUpdateResult
} from "@ue-shed/game-text/browser";
import { createEffectAction } from "@ue-shed/ui";
import { batch, createMemo, createSignal } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";

export interface RuleEditorState {
	readonly draft: TextQualityRuleDocument;
	readonly savedDocument: TextQualityRuleDocument | undefined;
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
	const [state, setState] = createSignal(options.initialState);
	const [busy, setBusy] = createSignal(false);
	const [feedback, setFeedback] = createSignal<EditorFeedback>({ status: "idle" });
	const dirty = createMemo(() => {
		const current = state();
		return (
			current !== undefined &&
			JSON.stringify(current.draft) !== JSON.stringify(current.savedDocument)
		);
	});
	const replace = (document: TextQualityRuleDocument | undefined, persisted = true) => {
		action.cancel();
		batch(() => {
			setState(
				document
					? { draft: document, savedDocument: persisted ? document : undefined }
					: undefined
			);
			setBusy(false);
			setFeedback({ status: "idle" });
		});
	};
	const changeDraft = (draft: TextQualityRuleDocument) => {
		setState((current) => ({ draft, savedDocument: current?.savedDocument }));
		setFeedback({ status: "idle" });
	};
	const run = (operation: "preview" | "save") => {
		const submitted = state()?.draft;
		if (!submitted || busy()) return;
		const problem = draftProblem(submitted);
		if (problem) {
			setFeedback({ message: problem, status: "failed" });
			return;
		}
		setBusy(true);
		setFeedback({ status: "idle" });
		action.run(
			operation === "preview"
				? options.client.previewQualityRules(submitted)
				: options.client.saveQualityRules(submitted),
			{
				onFailure: (cause) => {
					setBusy(false);
					setFeedback({ message: String(cause), status: "failed" });
				},
				onSuccess: (result) =>
					batch(() => {
						setBusy(false);
						if (result.status === "completed") {
							setState((current) => ({
								draft:
									current?.draft === submitted
										? result.document
										: (current?.draft ?? result.document),
								savedDocument:
									operation === "save" ? result.document : current?.savedDocument
							}));
							options.onReviewed(result);
							setFeedback({ status: operation === "save" ? "saved" : "previewed" });
						} else if (result.status === "failed") {
							setFeedback({
								message: result.error.message,
								recovery: result.error.recovery,
								status: "failed"
							});
						} else {
							setFeedback({
								message: "No loaded rule file is available.",
								recovery: "Load a rule file and retry.",
								status: "failed"
							});
						}
					})
			}
		);
	};
	return { state, busy, dirty, feedback, replace, changeDraft, run };
}

export type GameTextRuleState = ReturnType<typeof createGameTextRuleState>;

function draftProblem(document: TextQualityRuleDocument): string | undefined {
	for (const rule of document.rules) {
		if (rule.recovery.trim().length === 0) {
			return `${rule.id} needs recovery guidance before it can be previewed or saved.`;
		}
		if (
			rule.kind === "character_budget" &&
			(!Number.isSafeInteger(rule.maximumCharacters) || rule.maximumCharacters < 1)
		) {
			return `${rule.id} needs a whole-number character limit of at least 1.`;
		}
		if (rule.kind === "terminology") {
			if (rule.terms.length === 0) return `${rule.id} needs at least one terminology entry.`;
			for (const term of rule.terms) {
				if (term.term.trim().length === 0) return `${rule.id} contains an empty term.`;
				if (
					term.kind === "preferred" &&
					(term.alternatives.length === 0 ||
						term.alternatives.some((alternative) => alternative.trim().length === 0))
				) {
					return `${rule.id} needs at least one non-empty alternative for every preferred term.`;
				}
			}
		}
	}
	return undefined;
}
