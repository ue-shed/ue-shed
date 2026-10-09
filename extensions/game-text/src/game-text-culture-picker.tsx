import * as stylex from "@stylexjs/stylex";
import type { TextCultureFacet } from "@ue-shed/game-text/browser";
import { AnchoredPopover, Button } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createEffect, createSignal, createUniqueId } from "solid-js";

/** "All cultures", "de", "de, fr, ja", or "5 cultures". */
export function culturesLabel(picked: readonly string[]): string {
	if (picked.length === 0) return "All cultures";
	if (picked.length <= 3) return picked.join(", ");
	return `${picked.length.toLocaleString()} cultures`;
}

/** "3 missing · 1 to update · 2 not synced", or "Up to date". */
function workLine(facet: TextCultureFacet | undefined): string | undefined {
	if (facet === undefined) return undefined;
	const parts = [
		facet.missing > 0 ? `${facet.missing.toLocaleString()} missing` : undefined,
		facet.toUpdate > 0 ? `${facet.toUpdate.toLocaleString()} to update` : undefined,
		facet.notSynced > 0 ? `${facet.notSynced.toLocaleString()} not synced` : undefined
	].filter((part) => part !== undefined);
	return parts.length > 0 ? parts.join(" · ") : "Up to date";
}

/**
 * Pick any number of cultures; none means all. One culture shows its translations on each line;
 * several narrow states, counts and the culture strip to them. Each culture shows its work, counted
 * over the current filters for every culture.
 */
export function CulturePicker(props: {
	readonly cultures: readonly string[];
	readonly picked: readonly string[];
	readonly work: readonly TextCultureFacet[] | undefined;
	readonly disabled?: boolean;
	readonly onToggle: (culture: string) => void;
	readonly onAll: () => void;
}) {
	const id = createUniqueId();
	const [open, setOpen] = createSignal(false);
	createEffect(
		() => props.disabled,
		(disabled) => {
			if (disabled) setOpen(false);
		}
	);
	const workOf = (culture: string) => props.work?.find((facet) => facet.culture === culture);
	const isPicked = (culture: string) => props.picked.includes(culture);
	let anchor: HTMLButtonElement | undefined;
	// Arrow keys, Home and End move between the choices, as in the other pickers.
	const move = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const buttons = Array.from(
			event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? []
		);
		const current = buttons.indexOf(event.currentTarget);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? buttons.length - 1
					: (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
						buttons.length;
		buttons[next]?.focus();
	};
	return (
		<AnchoredPopover
			id={id}
			ariaLabel="Culture choices"
			open={open()}
			onOpenChange={setOpen}
			placement="bottom-start"
			style={styles.panel}
			trigger={(trigger) => (
				<Button
					{...trigger}
					type="button"
					size="compact"
					tone="quiet"
					aria-label={"Culture: " + culturesLabel(props.picked)}
					disabled={props.disabled}
					ref={(element) => {
						anchor = element;
						trigger.ref(element);
					}}
					onClick={() => {
						const wasOpen = open();
						trigger.onClick();
						// Opening focuses the first picked choice, or "All cultures".
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
					{culturesLabel(props.picked)} <span aria-hidden="true">▾</span>
				</Button>
			)}
		>
			<button
				type="button"
				aria-pressed={props.picked.length === 0 ? "true" : "false"}
				disabled={props.disabled}
				onClick={() => props.onAll()}
				onKeyDown={move}
				{...stylex.attrs(styles.choice, props.picked.length === 0 && styles.chosen)}
			>
				<span {...stylex.attrs(styles.name)}>All cultures</span>
			</button>
			<For each={props.cultures}>
				{(culture) => (
					<button
						type="button"
						aria-pressed={isPicked(culture) ? "true" : "false"}
						aria-label={culture}
						title={workLine(workOf(culture))}
						disabled={props.disabled}
						onClick={() => props.onToggle(culture)}
						onKeyDown={move}
						{...stylex.attrs(styles.choice, isPicked(culture) && styles.chosen)}
					>
						<span
							aria-hidden="true"
							{...stylex.attrs(styles.box, isPicked(culture) && styles.boxOn)}
						>
							{isPicked(culture) ? "✓" : ""}
						</span>
						<span {...stylex.attrs(styles.code)}>{culture}</span>
						<Show when={workLine(workOf(culture))}>
							{(line) => (
								<span
									{...stylex.attrs(
										styles.work,
										line() === "Up to date" && styles.quiet
									)}
								>
									{line()}
								</span>
							)}
						</Show>
					</button>
				)}
			</For>
		</AnchoredPopover>
	);
}

const styles = stylex.create({
	panel: {
		display: "grid",
		gap: 2,
		minWidth: 260,
		maxHeight: 420,
		overflowY: "auto",
		boxSizing: "border-box",
		padding: 4,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
		zIndex: 20
	},
	choice: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		minHeight: 28,
		paddingInline: 8,
		borderWidth: 0,
		borderRadius: 5,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12.5,
		textAlign: "start",
		cursor: "pointer",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	chosen: { color: tokens.colorTextStrong },
	box: {
		width: 13,
		height: 13,
		flexShrink: 0,
		display: "grid",
		placeItems: "center",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: 3,
		fontSize: 9
	},
	boxOn: {
		backgroundColor: tokens.colorAccent,
		borderColor: tokens.colorAccent,
		color: tokens.colorAccentText
	},
	name: { flex: 1 },
	code: { width: 64, flexShrink: 0, fontFamily: tokens.fontMono, fontSize: 12 },
	work: {
		flex: 1,
		color: tokens.colorWarning,
		fontSize: 12,
		textAlign: "end",
		whiteSpace: "nowrap"
	},
	quiet: { color: tokens.colorTextMuted }
});
