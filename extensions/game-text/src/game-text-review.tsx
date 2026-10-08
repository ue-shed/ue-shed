import * as stylex from "@stylexjs/stylex";
import {
	LocalizationReviewFlag,
	LocalizationReviewLens,
	type LocalizationFocus,
	type LocalizationSelection,
	type LocalizationReviewChange,
	type LocalizationTranslation
} from "@ue-shed/game-text/browser";
import { Chip, createEffectAction } from "@ue-shed/ui";
import { For, Show, createSignal } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import type { GameTextLocalizationState } from "./game-text-localization-state.js";
import { styles } from "./game-text-styles.js";

const lensLabels = {
	not_reviewed: "Not reviewed",
	not_proofread: "Not proofread",
	changed_since_review: "Changed since review",
	machine_translated: "Machine translated",
	reviewed: "Reviewed"
} satisfies Record<LocalizationReviewLens, string>;

const flagLabels = {
	reviewed: "Reviewed",
	proofread: "Proofread",
	approved: "Approved",
	machine_translated: "Machine translated"
} satisfies Record<LocalizationReviewFlag, string>;
const flags = LocalizationReviewFlag.literals;

export function reviewLensLabel(lens: LocalizationReviewLens): string {
	return lensLabels[lens];
}

/** Review lenses beside the state chips; shown only once the target has review state. */
export function ReviewChips(props: {
	readonly model: GameTextLocalizationState;
	readonly counts: Readonly<Record<LocalizationReviewLens, number>> | undefined;
	readonly searching: boolean;
}) {
	return (
		<Show when={props.model.active() && (props.counts || props.model.review())}>
			<For
				each={LocalizationReviewLens.literals.filter(
					(lens) => lens === props.model.review() || (props.counts?.[lens] ?? 0) > 0
				)}
			>
				{(lens) => (
					<Chip
						label={lensLabels[lens]}
						selected={props.model.review() === lens}
						count={props.searching ? undefined : props.counts?.[lens]}
						onClick={() =>
							props.model.setReview(props.model.review() === lens ? undefined : lens)
						}
					/>
				)}
			</For>
		</Show>
	);
}

const reviewable = new Set(["translated", "not_synced", "needs_update"]);

/**
 * Review flags for one culture's translation. Flags describe the exact text shown; when either
 * the source or the translation changes they show as "changed since review".
 */
export function ReviewControls(props: {
	readonly client: GameTextClientApi;
	readonly target: LocalizationSelection["target"] | undefined;
	readonly detail: LocalizationFocus;
	readonly translation: LocalizationTranslation;
	readonly busy: boolean;
	readonly onChanged: () => void;
}) {
	const action = createEffectAction();
	const [working, setWorking] = createSignal(false);
	const [message, setMessage] = createSignal<string | undefined>(undefined);
	const review = () => props.translation.review;
	const current = () => {
		const state = review();
		return state?.status === "current" ? state.flags : [];
	};
	const write = (change: LocalizationReviewChange) => {
		const request = props.client.localizationReview;
		const target = props.target;
		if (!request || !target || working()) return;
		setWorking(true);
		setMessage(undefined);
		action.run(request({ target, changes: [change] }), {
			onSuccess: (result) => {
				setWorking(false);
				if (result.status === "written") props.onChanged();
				else if (result.status === "failed")
					setMessage(`${result.message} ${result.recovery}`);
			},
			onFailure: () => {
				setWorking(false);
				setMessage("Review state could not be saved. Rescan and try again.");
			}
		});
	};
	const toggle = (flag: LocalizationReviewFlag) => {
		const identity = props.detail.identity;
		if (!identity) return;
		const base = {
			culture: props.translation.culture,
			namespace: identity.namespace,
			key: identity.key,
			flags: [flag]
		};
		write(current().includes(flag) ? { kind: "clear", ...base } : { kind: "set", ...base });
	};
	return (
		<Show
			when={
				props.client.localizationReview !== undefined &&
				props.detail.identity !== null &&
				reviewable.has(props.translation.state)
			}
		>
			<div
				role="group"
				aria-label={"Review " + props.translation.culture}
				{...stylex.attrs(styles.bar)}
			>
				<For each={flags}>
					{(flag) => (
						<Chip
							label={flagLabels[flag]}
							selected={current().includes(flag)}
							toggle
							disabled={props.busy || working()}
							onClick={() => toggle(flag)}
						/>
					)}
				</For>
				<Show when={review()}>
					{(state) => {
						const value = state();
						return value.status === "not_reviewed" ? null : value.status ===
						  "changed" ? (
							<span {...stylex.attrs(styles.warning)}>
								Changed since review (
								{value.flags.map((flag) => flagLabels[flag]).join(", ")} by{" "}
								{value.by})
							</span>
						) : (
							<span {...stylex.attrs(styles.muted)}>by {value.by}</span>
						);
					}}
				</Show>
			</div>
			<Show when={message()}>
				<p role="status" {...stylex.attrs(styles.warning)}>
					{message()}
				</p>
			</Show>
		</Show>
	);
}
