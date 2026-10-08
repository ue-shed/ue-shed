import * as stylex from "@stylexjs/stylex";
import { createEffectAction } from "@ue-shed/ui";
import { Effect } from "effect";
import { Show, createEffect, createSignal } from "solid-js";
import { styles } from "./game-text-styles.js";

export function CopyButton(props: { readonly label: string; readonly value: string }) {
	const action = createEffectAction();
	const confirmation = createEffectAction();
	const [feedback, setFeedback] = createSignal<string>();
	createEffect(
		() => props.value,
		() => {
			action.cancel();
			confirmation.cancel();
			setFeedback(undefined);
		}
	);
	return (
		<button
			type="button"
			aria-label={props.label}
			title={feedback() ?? props.label}
			{...stylex.attrs(styles.copyButton)}
			onClick={() => {
				confirmation.cancel();
				action.run(
					Effect.tryPromise({
						try: () => navigator.clipboard.writeText(props.value),
						catch: String
					}),
					{
						onSuccess: () => {
							setFeedback("Copied");
							confirmation.run(Effect.sleep("1500 millis"), {
								onSuccess: () => setFeedback(undefined)
							});
						},
						onFailure: () => setFeedback("Could not copy")
					}
				);
			}}
		>
			<svg aria-hidden="true" viewBox="0 0 16 16" {...stylex.attrs(styles.copyIcon)}>
				<Show
					when={feedback() === "Copied"}
					fallback={
						<>
							<rect x="5" y="5" width="9" height="9" rx="1" />
							<path d="M11 3V2H2v9h1" />
						</>
					}
				>
					<path d="m3 8 3 3 7-7" />
				</Show>
			</svg>
		</button>
	);
}
