import * as stylex from "@stylexjs/stylex";
import type {
	TextQualityQuerySummary,
	TextQualityRule,
	TextQualityRuleDocument,
	TextRoleMatcher,
	TextTerminologyEntry
} from "@ue-shed/game-text/browser";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Match, Show, Switch, createEffect, createSignal, on } from "solid-js";
import type { GameTextRuleState, RuleEditorState } from "./game-text-rule-state.js";

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

export function GameTextRuleEditor(props: {
	readonly editor: GameTextRuleState;
	readonly state: RuleEditorState;
	readonly summary: TextQualityQuerySummary;
}) {
	const draft = () => props.state.draft;
	const { dirty, feedback, changeDraft, run } = props.editor;
	const [selectedRuleId, setSelectedRuleId] = createSignal(draft().rules[0]?.id);
	createEffect(
		on(
			() => draft().rules,
			(rules) => {
				setSelectedRuleId((current) =>
					rules.some((rule) => rule.id === current) ? current : rules[0]?.id
				);
			}
		)
	);
	const selectedRule = () =>
		draft().rules.find((rule) => rule.id === selectedRuleId()) ?? draft().rules[0];
	const selectedBudgetRule = () => characterBudgetRule(selectedRule());
	const selectedTerminologyRule = () => terminologyRule(selectedRule());

	const findingCount = (ruleId: TextQualityRule["id"]) =>
		props.summary.rules.find((rule) => rule.ruleId === ruleId)?.findingCount ?? 0;

	return (
		<div {...stylex.props(styles.editor)}>
			<aside aria-label="Quality rule list" {...stylex.props(styles.ruleList)}>
				<header {...stylex.props(styles.panelHeader)}>
					<span>Rules</span>
					<b {...stylex.props(styles.panelCount)}>{draft().rules.length}</b>
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
								<b>{rule.kind === "character_budget" ? "Budget" : "Terms"}</b>
								<em {...stylex.props(styles.panelCount)}>
									{findingCount(rule.id)}
								</em>
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
								<h3 {...stylex.props(styles.formTitle)}>{rule().id}</h3>
								<span {...stylex.props(styles.dirtyState)}>
									{dirty() ? "Unsaved changes" : "Saved"}
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
														? "Forbidden"
														: "Preferred"}
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
										Add forbidden term
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
										Add preferred term
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
									<span role="alert" {...stylex.props(styles.failedFeedback)}>
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
							disabled={!dirty() || props.editor.busy()}
							onClick={() => run("preview")}
							{...stylex.props(styles.actionButton)}
						>
							Preview
						</button>
						<button
							type="button"
							disabled={!dirty() || props.editor.busy()}
							onClick={() => run("save")}
							{...stylex.props(styles.actionButton)}
						>
							Save
						</button>
					</div>
				</footer>
			</section>

			<aside aria-label="Quality role scopes" {...stylex.props(styles.roles)}>
				<header {...stylex.props(styles.panelHeader)}>
					<span>Roles</span>
					<b {...stylex.props(styles.panelCount)}>{draft().roles.length}</b>
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
											Scope {scopeIndex() + 1} · all must match
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
		gap: tokens.space2
	},
	ruleList: {
		height: "calc(100vh - 260px)",
		minHeight: 430,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "auto"
	},
	panelHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		padding: `${tokens.space2} ${tokens.space3}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextStrong,
		fontWeight: 590,
		fontSize: 12
	},
	panelCount: {
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontStyle: "normal",
		fontVariantNumeric: "tabular-nums"
	},
	ruleChoice: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		width: "100%",
		padding: `${tokens.space2} ${tokens.space3}`,
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorTextMuted,
		textAlign: "left",
		cursor: "pointer"
	},
	ruleChoiceActive: {
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		boxShadow: `inset 2px 0 ${tokens.colorAccent}`
	},
	ruleChoiceMeta: {
		display: "flex",
		justifyContent: "space-between",
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	ruleForm: {
		display: "flex",
		flexDirection: "column",
		height: "calc(100vh - 260px)",
		minHeight: 430,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "auto"
	},
	formHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: tokens.space3,
		padding: `${tokens.space3} ${tokens.space4}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	formTitle: {
		margin: 0,
		overflow: "hidden",
		color: tokens.colorTextStrong,
		fontSize: 15,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	dirtyState: {
		flexShrink: 0,
		color: tokens.colorWarning,
		fontSize: 11
	},
	field: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		padding: `${tokens.space3} ${tokens.space4} 0`,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	input: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		padding: `${tokens.space2} ${tokens.space2}`,
		fontSize: 12,
		":focus-visible": { borderColor: tokens.colorAccent }
	},
	textarea: {
		minHeight: 72,
		resize: "vertical",
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		padding: tokens.space2,
		fontFamily: "inherit",
		fontSize: 12,
		lineHeight: 1.45,
		":focus-visible": { borderColor: tokens.colorAccent }
	},
	fieldHint: { color: tokens.colorTextFaint, fontSize: 11 },
	termsHeader: { padding: `${tokens.space3} ${tokens.space4} 0` },
	checkbox: {
		display: "flex",
		alignItems: "center",
		gap: tokens.space2,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	termList: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		padding: `${tokens.space2} ${tokens.space4} 0`
	},
	termRow: {
		display: "grid",
		gridTemplateColumns: "70px minmax(130px, .8fr) minmax(150px, 1fr) 26px",
		alignItems: "center",
		gap: tokens.space1
	},
	termKind: { color: tokens.colorWarning, fontSize: 11 },
	inputCompact: {
		minWidth: 0,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		padding: `${tokens.space1} ${tokens.space2}`,
		fontSize: 12,
		":focus-visible": { borderColor: tokens.colorAccent }
	},
	removeTerm: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		cursor: "pointer",
		":hover": { backgroundColor: "rgba(255, 255, 255, 0.04)" }
	},
	addTerms: {
		display: "flex",
		gap: tokens.space1,
		padding: `${tokens.space2} ${tokens.space4} 0`
	},
	smallButton: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: `${tokens.space1} ${tokens.space2}`,
		fontSize: 11,
		cursor: "pointer",
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, border-color, transform",
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { default: "scale(1)", ":active": "scale(0.97)" }
	},
	failedFeedback: {
		display: "block",
		maxWidth: 480,
		padding: `${tokens.space1} ${tokens.space2}`,
		borderColor: "rgba(235, 87, 87, 0.4)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		color: tokens.colorDanger,
		fontSize: 11,
		lineHeight: 1.45
	},
	actions: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: tokens.space3,
		marginTop: "auto",
		padding: `${tokens.space3} ${tokens.space4}`,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	actionButtons: {
		display: "flex",
		flexShrink: 0,
		gap: tokens.space1
	},
	actionButton: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: tokens.colorSurface,
			":hover": "rgba(255, 255, 255, 0.04)",
			":disabled": tokens.colorSurface
		},
		color: tokens.colorText,
		padding: `${tokens.space1} ${tokens.space3}`,
		fontSize: 12,
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "default" },
		opacity: { default: 1, ":disabled": 0.42 },
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, border-color, opacity, transform",
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { default: "scale(1)", ":active": "scale(0.97)", ":disabled": "scale(1)" }
	},
	roles: {
		height: "calc(100vh - 260px)",
		minHeight: 430,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "auto"
	},
	roleCard: {
		padding: tokens.space3,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	roleHeader: {
		display: "flex",
		justifyContent: "space-between",
		gap: tokens.space2
	},
	roleTitle: {
		overflow: "hidden",
		color: tokens.colorTextStrong,
		fontSize: 12,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	roleCount: {
		flexShrink: 0,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		fontVariantNumeric: "tabular-nums"
	},
	roleDescription: {
		margin: `${tokens.space1} 0`,
		color: tokens.colorTextMuted,
		fontSize: 11,
		lineHeight: 1.4
	},
	scope: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		marginTop: tokens.space2,
		padding: tokens.space2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset
	},
	scopeLabel: { color: tokens.colorTextFaint, fontSize: 11 },
	scopeMatcher: { color: tokens.colorText, fontSize: 11, lineHeight: 1.35 }
});
