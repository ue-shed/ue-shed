import * as stylex from "@stylexjs/stylex";
import type { LocalizationFocus, LocalizationKeyChangeMatch } from "@ue-shed/game-text/browser";
import { Button, Chip } from "@ue-shed/ui";
import { For, Show, createSignal } from "solid-js";
import type { GameTextLocalizationState } from "./game-text-localization-state.js";
import { styles } from "./game-text-styles.js";
import { seenTranslation, type GameTextEdits } from "./game-text-translation-edits.js";

const matchLabels = {
	same_place: "same place",
	same_text_in_package: "same text in this asset",
	same_text: "same text"
} satisfies Record<LocalizationKeyChangeMatch, string>;

/** "Key changed" lists lines saved under a new key whose earlier key Unreal still lists. */
export function KeyChangeChip(props: {
	readonly model: GameTextLocalizationState;
	readonly count: number | undefined;
	readonly searching: boolean;
}) {
	return (
		<Show when={props.model.active() && (props.count || props.model.keyChanged())}>
			<Chip
				label="Key changed"
				selected={props.model.keyChanged()}
				count={props.searching ? undefined : props.count}
				onClick={() => props.model.setKeyChanged(!props.model.keyChanged())}
			/>
		</Show>
	);
}

/**
 * One line in the detail pane: the earlier key, how it was paired, and the translations that key
 * shipped. Unreal drops those translations at the next gather unless they are carried over.
 */
export function KeyChangeDetail(props: {
	readonly detail: LocalizationFocus;
	readonly edits?: GameTextEdits | undefined;
}) {
	const [carried, setCarried] = createSignal<number>();
	// Staged like hand edits: each culture starts from what ships now for the new key (nothing,
	// before a gather), and the staged panel checks every edit against the project's files.
	const carry = () => {
		const change = props.detail.keyChange;
		const identity = props.detail.identity;
		const edits = props.edits;
		if (change?.direction !== "to" || identity === null || edits === undefined) return;
		for (const item of change.translations) {
			const shown = props.detail.translations.find(
				(translation) => translation.culture === item.culture
			);
			edits.stage(
				{
					culture: item.culture,
					namespace: identity.namespace,
					key: identity.key,
					seenTranslation: shown === undefined ? null : seenTranslation(shown),
					translation: item.translation
				},
				props.detail.source
			);
		}
		setCarried(change.translations.length);
		edits.setOpen(true);
	};
	return (
		<Show when={props.detail.keyChange}>
			{(change) => (
				<section aria-label="Key change" {...stylex.attrs(styles.keyChange)}>
					<Show
						when={change().direction === "to"}
						fallback={
							<span>
								Key changed to{" "}
								<code>
									{change().other.namespace},{change().other.key}
								</code>
								. Its translations move with the new key.
							</span>
						}
					>
						<span>
							Key changed · was{" "}
							<code>
								{change().other.namespace},{change().other.key}
							</code>{" "}
							<span {...stylex.attrs(styles.muted)}>
								({matchLabels[change().match]})
							</span>
						</span>
						<Show when={change().sourceChanged}>
							<span {...stylex.attrs(styles.muted)}>
								The text changed too; it was “{change().previousSource}”.
							</span>
						</Show>
						<Show
							when={change().translations.length > 0}
							fallback={
								<span {...stylex.attrs(styles.muted)}>
									The earlier key had no translations.
								</span>
							}
						>
							<span {...stylex.attrs(styles.muted)}>
								Translations of the earlier key
							</span>
							<For each={change().translations}>
								{(item) => (
									<span>
										<strong>{item.culture}</strong> {item.translation}
									</span>
								)}
							</For>
							<Show when={props.edits && props.detail.identity !== null}>
								<Show
									when={carried()}
									fallback={
										<div>
											<Button
												type="button"
												size="compact"
												tone={
													change().sourceChanged ? "quiet" : "secondary"
												}
												disabled={props.edits?.busy()}
												onClick={carry}
											>
												{change().sourceChanged
													? "Carry anyway"
													: "Carry translations"}
											</Button>
											<Show when={change().sourceChanged}>
												<span {...stylex.attrs(styles.muted)}>
													{" "}
													They were written for the earlier text.
												</span>
											</Show>
										</div>
									}
								>
									{(count) => (
										<span role="status" {...stylex.attrs(styles.muted)}>
											Staged {count()}{" "}
											{count() === 1 ? "translation" : "translations"}. Gather
											and export, then write them to the PO.
										</span>
									)}
								</Show>
							</Show>
						</Show>
					</Show>
				</section>
			)}
		</Show>
	);
}
