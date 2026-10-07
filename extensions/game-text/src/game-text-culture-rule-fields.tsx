import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import type { LocalizationProjectRule, TextTerminologyEntry } from "@ue-shed/game-text/browser";
import { Button } from "@ue-shed/ui";
import { For, Show, createSignal } from "solid-js";
import { styles } from "./game-text-styles.js";

const fieldStyles = stylex.create({
	input: {
		height: 26,
		fontSize: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextStrong,
		paddingInline: 6
	}
});

export function CultureRuleFields(props: {
	readonly rule: LocalizationProjectRule;
	readonly onChange: (rule: LocalizationProjectRule) => void;
}) {
	const [newCulture, setNewCulture] = createSignal("");
	const budget = () =>
		props.rule.kind === "localization_character_budget" ? props.rule : undefined;
	const glossary = () =>
		props.rule.kind === "localization_terminology" ? props.rule : undefined;
	const updateBudget = (culture: string, value: number) => {
		const rule = budget();
		if (rule) props.onChange({ ...rule, cultures: { ...rule.cultures, [culture]: value } });
	};
	const updateTerms = (culture: string, terms: readonly TextTerminologyEntry[]) => {
		const rule = glossary();
		if (rule) props.onChange({ ...rule, cultures: { ...rule.cultures, [culture]: terms } });
	};
	const removeCulture = (culture: string) => {
		const rule = props.rule;
		props.onChange(
			rule.kind === "localization_character_budget"
				? {
						...rule,
						cultures: Object.fromEntries(
							Object.entries(rule.cultures).filter(([key]) => key !== culture)
						)
					}
				: {
						...rule,
						cultures: Object.fromEntries(
							Object.entries(rule.cultures).filter(([key]) => key !== culture)
						)
					}
		);
	};
	const addCulture = () => {
		const culture = newCulture().trim();
		if (!culture || Object.keys(props.rule.cultures).includes(culture)) return;
		const rule = props.rule;
		props.onChange(
			rule.kind === "localization_character_budget"
				? { ...rule, cultures: { ...rule.cultures, [culture]: 100 } }
				: {
						...rule,
						cultures: {
							...rule.cultures,
							[culture]: [{ kind: "forbidden", term: "example" }]
						}
					}
		);
		setNewCulture("");
	};
	return (
		<section aria-label="Per-culture rules" {...stylex.attrs(styles.detail)}>
			<Show when={budget()}>
				{(rule) => (
					<label>
						Default maximum characters (optional)
						<input
							{...stylex.attrs(fieldStyles.input)}
							type="number"
							min="1"
							aria-label="Default maximum characters"
							value={rule().defaultMaximumCharacters ?? ""}
							onInput={(event) => {
								const { defaultMaximumCharacters: _default, ...current } = rule();
								props.onChange(
									event.currentTarget.value === ""
										? current
										: {
												...current,
												defaultMaximumCharacters: Number(
													event.currentTarget.value
												)
											}
								);
							}}
						/>
					</label>
				)}
			</Show>
			<Show when={glossary()}>
				{(rule) => (
					<label>
						<input
							{...stylex.attrs(fieldStyles.input)}
							type="checkbox"
							checked={rule().caseSensitive}
							onChange={(event) =>
								props.onChange({
									...rule(),
									caseSensitive: event.currentTarget.checked
								})
							}
						/>
						Case-sensitive matching
					</label>
				)}
			</Show>
			<For each={Object.keys(props.rule.cultures)}>
				{(culture) => (
					<section
						aria-label={`Rules for ${culture}`}
						{...stylex.attrs(styles.detailSection)}
					>
						<div {...stylex.attrs(styles.bar)}>
							<strong>{culture}</strong>
							<Button
								size="compact"
								tone="quiet"
								onClick={() => removeCulture(culture)}
							>
								Remove {culture}
							</Button>
						</div>
						<Show when={budget()}>
							{(rule) => (
								<label>
									Maximum characters
									<input
										{...stylex.attrs(fieldStyles.input)}
										type="number"
										min="1"
										aria-label={`Maximum characters for ${culture}`}
										value={
											Object.entries(rule().cultures).find(
												([key]) => key === culture
											)?.[1] ?? ""
										}
										onInput={(event) =>
											updateBudget(culture, Number(event.currentTarget.value))
										}
									/>
								</label>
							)}
						</Show>
						<Show when={glossary()}>
							{(rule) => {
								const terms = () =>
									Object.entries(rule().cultures).find(
										([key]) => key === culture
									)?.[1] ?? [];
								const replace = (index: number, value: TextTerminologyEntry) =>
									updateTerms(
										culture,
										terms().map((term, current) =>
											current === index ? value : term
										)
									);
								return (
									<>
										<For each={terms()} keyed={false}>
											{(term, index) => (
												<div {...stylex.attrs(styles.bar)}>
													<label>
														{term().kind === "preferred"
															? "Preferred"
															: "Forbidden"}
														<input
															{...stylex.attrs(fieldStyles.input)}
															aria-label={`${culture} term ${index + 1}`}
															value={term().term}
															onInput={(event) =>
																replace(index, {
																	...term(),
																	term: event.currentTarget.value
																})
															}
														/>
													</label>
													<Show
														when={
															term().kind === "preferred"
																? term()
																: undefined
														}
													>
														{(preferred) => (
															<label>
																Alternatives
																<input
																	{...stylex.attrs(
																		fieldStyles.input
																	)}
																	aria-label={`${culture} alternatives ${index + 1}`}
																	value={(() => {
																		const value = preferred();
																		return value.kind ===
																			"preferred"
																			? value.alternatives.join(
																					", "
																				)
																			: "";
																	})()}
																	onInput={(event) => {
																		const current = preferred();
																		if (
																			current.kind ===
																			"preferred"
																		)
																			replace(index, {
																				...current,
																				alternatives:
																					event.currentTarget.value
																						.split(",")
																						.map(
																							(
																								value
																							) =>
																								value.trim()
																						)
																			});
																	}}
																/>
															</label>
														)}
													</Show>
													<Button
														size="compact"
														tone="quiet"
														disabled={terms().length <= 1}
														onClick={() =>
															updateTerms(
																culture,
																terms().filter(
																	(_, current) =>
																		current !== index
																)
															)
														}
													>
														Remove term {index + 1}
													</Button>
												</div>
											)}
										</For>
										<Button
											size="compact"
											tone="quiet"
											onClick={() =>
												updateTerms(culture, [
													...terms(),
													{
														kind: "preferred",
														term: "",
														alternatives: [""]
													}
												])
											}
										>
											Add preferred term
										</Button>
										<Button
											size="compact"
											tone="quiet"
											onClick={() =>
												updateTerms(culture, [
													...terms(),
													{ kind: "forbidden", term: "" }
												])
											}
										>
											Add forbidden term
										</Button>
									</>
								);
							}}
						</Show>
					</section>
				)}
			</For>
			<div {...stylex.attrs(styles.bar)}>
				<input
					{...stylex.attrs(fieldStyles.input)}
					aria-label="New culture code"
					placeholder="Culture code"
					value={newCulture()}
					onInput={(event) => setNewCulture(event.currentTarget.value)}
				/>
				<Button size="compact" tone="quiet" onClick={addCulture}>
					Add culture
				</Button>
			</div>
		</section>
	);
}
