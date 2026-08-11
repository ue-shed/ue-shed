import * as stylex from "@stylexjs/stylex";
import type {
	TextQualityQuerySummary,
	TextQualityRule,
	TextQualityRuleDocument,
	TextQualityRuleUpdateResult,
	TextRoleMatcher,
	TextTerminologyEntry
} from "@ue-shed/game-text/browser";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Match, Show, Switch, createEffect, createSignal, on } from "solid-js";
import type { GameTextClientShape } from "./game-text-client.js";

type EditorFeedback =
	| { readonly status: "idle" }
	| { readonly status: "previewed" }
	| { readonly status: "saved" }
	| { readonly message: string; readonly recovery?: string; readonly status: "failed" };

function characterBudgetRule(rule: TextQualityRule | undefined) {
	return rule?.kind === "character_budget" ? rule : undefined;
}

function terminologyRule(rule: TextQualityRule | undefined) {
	return rule?.kind === "terminology" ? rule : undefined;
}

function matcherLabel(matcher: TextRoleMatcher): string {
	if (matcher.kind === "location_kind") {
		if (matcher.value === "string_table_entry") return "String Table entries";
		if (matcher.value === "data_table_cell") return "DataTable text cells";
		return "Saved asset text properties";
	}
	const subject =
		matcher.kind === "object_path"
			? "Object path"
			: matcher.kind === "property_path"
				? "Property path"
				: matcher.kind === "string_table_entry"
					? "String Table key"
					: matcher.kind === "class_path"
						? "Class path"
						: "Row";
	return `${subject} ${matcher.operator === "exact" ? "is" : "starts with"} ${matcher.value}`;
}

function replaceRule(
	document: TextQualityRuleDocument,
	ruleId: TextQualityRule["id"],
	update: (rule: TextQualityRule) => TextQualityRule
): TextQualityRuleDocument {
	return {
		...document,
		rules: document.rules.map((rule) => (rule.id === ruleId ? update(rule) : rule))
	};
}

function updateTerm(
	document: TextQualityRuleDocument,
	ruleId: TextQualityRule["id"],
	index: number,
	update: (term: TextTerminologyEntry) => TextTerminologyEntry
): TextQualityRuleDocument {
	return replaceRule(document, ruleId, (rule) =>
		rule.kind === "terminology"
			? {
					...rule,
					terms: rule.terms.map((term, current) =>
						current === index ? update(term) : term
					)
				}
			: rule
	);
}

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

export function GameTextRuleEditor(props: {
	readonly client: GameTextClientShape;
	readonly document: TextQualityRuleDocument;
	readonly onReviewed: (
		result: Extract<TextQualityRuleUpdateResult, { status: "completed" }>
	) => void;
	readonly summary: TextQualityQuerySummary;
}) {
	const previewAction = createEffectAction();
	const saveAction = createEffectAction();
	const [draft, setDraft] = createSignal(props.document);
	const [selectedRuleId, setSelectedRuleId] = createSignal(props.document.rules[0]?.id);
	const [dirty, setDirty] = createSignal(false);
	const [feedback, setFeedback] = createSignal<EditorFeedback>({ status: "idle" });

	createEffect(
		on(
			() => props.document,
			(document) => {
				setDraft(document);
				setSelectedRuleId((current) =>
					document.rules.some((rule) => rule.id === current)
						? current
						: document.rules[0]?.id
				);
				setDirty(false);
				setFeedback({ status: "idle" });
			},
			{ defer: true }
		)
	);

	const selectedRule = () =>
		draft().rules.find((rule) => rule.id === selectedRuleId()) ?? draft().rules[0];
	const selectedBudgetRule = () => characterBudgetRule(selectedRule());
	const selectedTerminologyRule = () => terminologyRule(selectedRule());

	const changeDraft = (next: TextQualityRuleDocument) => {
		setDraft(next);
		setDirty(true);
		setFeedback({ status: "idle" });
	};

	const handleResult = (result: TextQualityRuleUpdateResult, success: "previewed" | "saved") => {
		if (result.status === "completed") {
			props.onReviewed(result);
			setFeedback({ status: success });
			if (success === "saved") {
				setDraft(result.document);
				setDirty(false);
			}
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
	};

	const run = (operation: "preview" | "save") => {
		const problem = draftProblem(draft());
		if (problem) {
			setFeedback({ message: problem, status: "failed" });
			return;
		}
		setFeedback({ status: "idle" });
		const action = operation === "preview" ? previewAction : saveAction;
		const effect =
			operation === "preview"
				? props.client.previewQualityRules(draft())
				: props.client.saveQualityRules(draft());
		action.run(effect, {
			onFailure: (cause) => setFeedback({ message: String(cause), status: "failed" }),
			onSuccess: (result) =>
				handleResult(result, operation === "preview" ? "previewed" : "saved")
		});
	};

	const findingCount = (ruleId: TextQualityRule["id"]) =>
		props.summary.rules.find((rule) => rule.ruleId === ruleId)?.findingCount ?? 0;

	return (
		<div {...stylex.props(styles.editor)}>
			<aside aria-label="Quality rule list" {...stylex.props(styles.ruleList)}>
				<header {...stylex.props(styles.panelHeader)}>
					<span>RULE SET</span>
					<b>{draft().rules.length}</b>
				</header>
				<For each={draft().rules}>
					{(rule) => (
						<button
							type="button"
							aria-current={selectedRuleId() === rule.id ? "true" : undefined}
							onClick={() => setSelectedRuleId(rule.id)}
							{...stylex.props(
								styles.ruleChoice,
								selectedRuleId() === rule.id && styles.ruleChoiceActive
							)}
						>
							<span {...stylex.props(styles.ruleChoiceMeta)}>
								<b>{rule.kind === "character_budget" ? "BUDGET" : "TERMS"}</b>
								<em>{findingCount(rule.id)}</em>
							</span>
							<strong>{rule.id}</strong>
							<small>Role · {rule.role}</small>
						</button>
					)}
				</For>
			</aside>

			<section aria-label="Selected quality rule" {...stylex.props(styles.ruleForm)}>
				<Show when={selectedRule()}>
					{(rule) => (
						<>
							<header {...stylex.props(styles.formHeader)}>
								<div>
									<small {...stylex.props(styles.formEyebrow)}>EDIT RULE</small>
									<h3 {...stylex.props(styles.formTitle)}>{rule().id}</h3>
								</div>
								<span {...stylex.props(styles.dirtyState)}>
									{dirty() ? "UNSAVED CHANGES" : "SAVED FILE"}
								</span>
							</header>
							<Show when={selectedBudgetRule()}>
								<label {...stylex.props(styles.field)}>
									<span>Maximum characters</span>
									<input
										type="number"
										min="1"
										step="1"
										aria-label={`Maximum characters for ${rule().id}`}
										{...stylex.props(styles.input)}
										value={selectedBudgetRule()?.maximumCharacters ?? ""}
										onInput={(event) => {
											const value = Number(event.currentTarget.value);
											changeDraft(
												replaceRule(draft(), rule().id, (current) =>
													current.kind === "character_budget"
														? { ...current, maximumCharacters: value }
														: current
												)
											);
										}}
									/>
									<small {...stylex.props(styles.fieldHint)}>
										Counts Unicode characters in the saved source text.
									</small>
								</label>
							</Show>
							<Show when={selectedTerminologyRule()}>
								<div {...stylex.props(styles.termsHeader)}>
									<label {...stylex.props(styles.checkbox)}>
										<input
											type="checkbox"
											checked={
												selectedTerminologyRule()?.caseSensitive ?? false
											}
											onChange={(event) =>
												changeDraft(
													replaceRule(draft(), rule().id, (current) =>
														current.kind === "terminology"
															? {
																	...current,
																	caseSensitive:
																		event.currentTarget.checked
																}
															: current
													)
												)
											}
										/>
										Case-sensitive matching
									</label>
								</div>
								<div {...stylex.props(styles.termList)}>
									<For each={selectedTerminologyRule()?.terms ?? []}>
										{(term, index) => (
											<div {...stylex.props(styles.termRow)}>
												<b {...stylex.props(styles.termKind)}>
													{term.kind === "forbidden"
														? "FORBIDDEN"
														: "PREFERRED"}
												</b>
												<input
													aria-label={`${term.kind === "forbidden" ? "Forbidden" : "Preferred"} term ${index() + 1}`}
													{...stylex.props(styles.inputCompact)}
													value={term.term}
													onInput={(event) =>
														changeDraft(
															updateTerm(
																draft(),
																rule().id,
																index(),
																(current) => ({
																	...current,
																	term: event.currentTarget.value
																})
															)
														)
													}
												/>
												<Show
													when={
														term.kind === "preferred" ? term : undefined
													}
												>
													{(preferred) => (
														<input
															aria-label={`Alternatives for preferred term ${index() + 1}`}
															{...stylex.props(styles.inputCompact)}
															value={preferred().alternatives.join(
																", "
															)}
															onInput={(event) =>
																changeDraft(
																	updateTerm(
																		draft(),
																		rule().id,
																		index(),
																		(current) =>
																			current.kind ===
																			"preferred"
																				? {
																						...current,
																						alternatives:
																							event.currentTarget.value
																								.split(
																									","
																								)
																								.map(
																									(
																										value
																									) =>
																										value.trim()
																								)
																					}
																				: current
																	)
																)
															}
														/>
													)}
												</Show>
												<button
													type="button"
													aria-label={`Remove term ${index() + 1}`}
													disabled={
														(selectedTerminologyRule()?.terms.length ??
															0) <= 1
													}
													onClick={() =>
														changeDraft(
															replaceRule(
																draft(),
																rule().id,
																(current) =>
																	current.kind === "terminology"
																		? {
																				...current,
																				terms: current.terms.filter(
																					(
																						_,
																						currentIndex
																					) =>
																						currentIndex !==
																						index()
																				)
																			}
																		: current
															)
														)
													}
													{...stylex.props(styles.removeTerm)}
												>
													×
												</button>
											</div>
										)}
									</For>
								</div>
								<div {...stylex.props(styles.addTerms)}>
									<button
										type="button"
										{...stylex.props(styles.smallButton)}
										onClick={() =>
											changeDraft(
												replaceRule(draft(), rule().id, (current) =>
													current.kind === "terminology"
														? {
																...current,
																terms: [
																	...current.terms,
																	{ kind: "forbidden", term: "" }
																]
															}
														: current
												)
											)
										}
									>
										+ Forbidden term
									</button>
									<button
										type="button"
										{...stylex.props(styles.smallButton)}
										onClick={() =>
											changeDraft(
												replaceRule(draft(), rule().id, (current) =>
													current.kind === "terminology"
														? {
																...current,
																terms: [
																	...current.terms,
																	{
																		kind: "preferred",
																		term: "",
																		alternatives: [""]
																	}
																]
															}
														: current
												)
											)
										}
									>
										+ Preferred term
									</button>
								</div>
							</Show>
							<label {...stylex.props(styles.field)}>
								<span>Recovery guidance</span>
								<textarea
									aria-label={`Recovery guidance for ${rule().id}`}
									{...stylex.props(styles.textarea)}
									value={rule().recovery}
									onInput={(event) =>
										changeDraft(
											replaceRule(draft(), rule().id, (current) => ({
												...current,
												recovery: event.currentTarget.value
											}))
										)
									}
								/>
							</label>
						</>
					)}
				</Show>
				<footer {...stylex.props(styles.actions)}>
					<Switch>
						<Match when={feedback().status === "previewed"}>
							<span role="status">Preview updated. Changes are not saved yet.</span>
						</Match>
						<Match when={feedback().status === "saved"}>
							<span role="status">Rule file saved.</span>
						</Match>
						<Match when={feedback().status === "failed"}>
							{(() => {
								const current = feedback();
								return current.status === "failed" ? (
									<span role="alert">
										{current.message} {current.recovery}
									</span>
								) : null;
							})()}
						</Match>
						<Match when={true}>
							<span>Preview uses the saved text already loaded in Workbench.</span>
						</Match>
					</Switch>
					<div {...stylex.props(styles.actionButtons)}>
						<button
							type="button"
							disabled={!dirty()}
							onClick={() => run("preview")}
							{...stylex.props(styles.actionButton)}
						>
							Preview changes
						</button>
						<button
							type="button"
							disabled={!dirty()}
							onClick={() => run("save")}
							{...stylex.props(styles.actionButton)}
						>
							Save rules
						</button>
					</div>
				</footer>
			</section>

			<aside aria-label="Quality role scopes" {...stylex.props(styles.roles)}>
				<header {...stylex.props(styles.panelHeader)}>
					<span>ROLES &amp; MATCHING</span>
					<b>{draft().roles.length}</b>
				</header>
				<For each={draft().roles}>
					{(role) => (
						<article {...stylex.props(styles.roleCard)}>
							<header {...stylex.props(styles.roleHeader)}>
								<strong {...stylex.props(styles.roleTitle)}>{role.id}</strong>
								<b {...stylex.props(styles.roleCount)}>
									{props.summary.roles.find((item) => item.role === role.id)
										?.matchedTextUnits ?? 0}{" "}
									text entries
								</b>
							</header>
							<Show when={role.description}>
								{(description) => (
									<p {...stylex.props(styles.roleDescription)}>{description()}</p>
								)}
							</Show>
							<For each={role.scopes}>
								{(scope, scopeIndex) => (
									<section {...stylex.props(styles.scope)}>
										<small {...stylex.props(styles.scopeLabel)}>
											SCOPE {scopeIndex() + 1} · ALL MUST MATCH
										</small>
										<For each={scope.matchers}>
											{(matcher) => (
												<span {...stylex.props(styles.scopeMatcher)}>
													{matcherLabel(matcher)}
												</span>
											)}
										</For>
									</section>
								)}
							</For>
						</article>
					)}
				</For>
			</aside>
		</div>
	);
}

const styles = stylex.create({
	editor: {
		display: "grid",
		gridTemplateColumns: "230px minmax(480px, 1fr) 300px",
		gap: 8
	},
	ruleList: {
		height: "calc(100vh - 260px)",
		minHeight: 430,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#121110",
		overflow: "auto"
	},
	panelHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: "8px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 9
	},
	ruleChoice: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		width: "100%",
		padding: "9px 10px",
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#201c19" },
		color: tokens.colorTextMuted,
		textAlign: "left",
		cursor: "pointer"
	},
	ruleChoiceActive: { backgroundColor: "#2b1d18", boxShadow: "inset 3px 0 #e87655" },
	ruleChoiceMeta: {
		display: "flex",
		justifyContent: "space-between",
		color: "#efaa91",
		fontSize: 8
	},
	ruleForm: {
		display: "flex",
		flexDirection: "column",
		height: "calc(100vh - 260px)",
		minHeight: 430,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#151311",
		overflow: "auto"
	},
	formHeader: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		padding: "12px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	formEyebrow: { color: "#e87655", fontSize: 8 },
	formTitle: { margin: "4px 0 0", color: tokens.colorTextStrong, fontSize: 15 },
	dirtyState: { color: "#e7ab6d", fontSize: 8 },
	field: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: "12px 14px 0",
		color: tokens.colorTextMuted,
		fontSize: 9
	},
	input: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: "#0f0e0d",
		color: tokens.colorTextStrong,
		padding: "8px 9px",
		fontSize: 11
	},
	textarea: {
		minHeight: 72,
		resize: "vertical",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: "#0f0e0d",
		color: tokens.colorTextStrong,
		padding: "8px 9px",
		fontFamily: "inherit",
		fontSize: 10
	},
	fieldHint: { color: tokens.colorTextFaint, fontSize: 8 },
	termsHeader: { padding: "12px 14px 0" },
	checkbox: { display: "flex", alignItems: "center", gap: 7, fontSize: 9 },
	termList: { display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px 0" },
	termRow: {
		display: "grid",
		gridTemplateColumns: "70px minmax(130px, .8fr) minmax(150px, 1fr) 26px",
		alignItems: "center",
		gap: 6
	},
	termKind: { color: "#efaa91", fontSize: 8 },
	inputCompact: {
		minWidth: 0,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: "#0f0e0d",
		color: tokens.colorTextStrong,
		padding: "6px 7px",
		fontSize: 9
	},
	removeTerm: {
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		cursor: "pointer"
	},
	addTerms: {
		display: "flex",
		gap: 6,
		padding: "8px 14px 0"
	},
	smallButton: {
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#211d1a" },
		color: tokens.colorTextMuted,
		padding: "5px 7px",
		fontSize: 8,
		cursor: "pointer"
	},
	actions: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		marginTop: "auto",
		padding: "10px 14px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 8
	},
	actionButtons: {
		display: "flex",
		gap: 6
	},
	actionButton: {
		border: "1px solid #884a36",
		backgroundColor: {
			default: "#382019",
			":hover": "#4a291f",
			":disabled": "#1a1816"
		},
		color: "#ffd0bf",
		padding: "6px 9px",
		fontSize: 9,
		cursor: { default: "pointer", ":disabled": "default" }
	},
	roles: {
		height: "calc(100vh - 260px)",
		minHeight: 430,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#121110",
		overflow: "auto"
	},
	roleCard: {
		padding: "10px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	roleHeader: { display: "flex", justifyContent: "space-between", gap: 8 },
	roleTitle: { color: tokens.colorTextStrong, fontSize: 10 },
	roleCount: { color: "#efaa91", fontSize: 8 },
	roleDescription: {
		margin: "6px 0",
		color: tokens.colorTextMuted,
		fontSize: 9,
		lineHeight: 1.4
	},
	scope: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		marginTop: 8,
		padding: "7px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#0f0e0d"
	},
	scopeLabel: { color: tokens.colorTextFaint, fontSize: 7 },
	scopeMatcher: { color: "#d8d0c8", fontSize: 8, lineHeight: 1.35 }
});
