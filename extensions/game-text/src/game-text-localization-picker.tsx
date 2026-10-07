import { AnchoredPopover, Button } from "@ue-shed/ui";
import { For, Show, createEffect, createSignal, createUniqueId } from "solid-js";
import { styles } from "./game-text-styles.js";

/** Uses the same light-dismiss popover as Export, with keyboard focus on the choices. */
export function LocalizationPicker(props: {
	readonly label: string;
	readonly value: string;
	readonly values: readonly string[];
	readonly disabled?: boolean;
	readonly onSelect: (value: string) => void;
}) {
	const id = createUniqueId();
	const [open, setOpen] = createSignal(false);
	createEffect(
		() => props.disabled,
		(disabled) => {
			if (disabled) setOpen(false);
		}
	);
	let anchor: HTMLButtonElement | undefined;
	return (
		<AnchoredPopover
			id={id}
			ariaLabel={props.label + " choices"}
			open={open()}
			onOpenChange={setOpen}
			placement="bottom-start"
			style={styles.pickerMenu}
			trigger={(trigger) => (
				<Button
					{...trigger}
					type="button"
					size="compact"
					tone="quiet"
					aria-label={props.label + ": " + props.value}
					disabled={props.disabled}
					ref={(element) => {
						anchor = element;
						trigger.ref(element);
					}}
					onClick={() => {
						const wasOpen = open();
						trigger.onClick();
						if (!wasOpen)
							queueMicrotask(() => {
								const panel = anchor?.ownerDocument.getElementById(id);
								(
									panel?.querySelector<HTMLButtonElement>(
										'button[aria-pressed="true"]'
									) ?? panel?.querySelector<HTMLButtonElement>("button")
								)?.focus();
							});
					}}
				>
					{props.value} <span aria-hidden="true">▾</span>
				</Button>
			)}
		>
			<For each={props.values}>
				{(value) => (
					<Button
						type="button"
						size="compact"
						tone="quiet"
						disabled={props.disabled}
						aria-pressed={props.value === value ? "true" : "false"}
						onClick={() => {
							if (props.disabled) return;
							setOpen(false);
							props.onSelect(value);
							queueMicrotask(() => anchor?.focus());
						}}
						onKeyDown={(event) => {
							if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
								return;
							event.preventDefault();
							const buttons = Array.from(
								event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
									"button"
								) ?? []
							);
							const current = buttons.indexOf(event.currentTarget);
							const next =
								event.key === "Home"
									? 0
									: event.key === "End"
										? buttons.length - 1
										: (current +
												(event.key === "ArrowDown" ? 1 : -1) +
												buttons.length) %
											buttons.length;
							buttons[next]?.focus();
						}}
					>
						<Show when={props.value === value}>
							<span aria-hidden="true">✓</span>
						</Show>
						{value}
					</Button>
				)}
			</For>
		</AnchoredPopover>
	);
}
