import * as stylex from "@stylexjs/stylex";
import { Portal, type JSX } from "@solidjs/web";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Show, createEffect, createSignal, onSettled } from "solid-js";

export type AnchoredPopoverPlacement = "top-start" | "top-end" | "bottom-start" | "bottom-end";

export interface AnchoredPopoverTriggerProps {
	readonly "aria-controls": string;
	readonly "aria-expanded": "false" | "true";
	readonly "aria-haspopup": "dialog";
	readonly onClick: () => void;
	readonly ref: (element: HTMLButtonElement) => void;
}

export interface AnchoredPopoverProps {
	readonly ariaLabel: string;
	readonly children: JSX.Element;
	readonly id: string;
	readonly open?: boolean;
	readonly onOpenChange?: (open: boolean) => void;
	readonly placement?: AnchoredPopoverPlacement;
	readonly style?: stylex.StyleXStyles;
	readonly trigger: (props: AnchoredPopoverTriggerProps) => JSX.Element;
}

const viewportMargin = 8;
const anchorGap = 7;

/** A portalled, light-dismiss panel positioned against a button trigger. */
export function AnchoredPopover(props: AnchoredPopoverProps) {
	const [internalOpen, setInternalOpen] = createSignal(false);
	const open = () => props.open ?? internalOpen();
	const [position, setPosition] = createSignal({ left: 0, top: 0 });
	let trigger: HTMLButtonElement | undefined;
	let panel: HTMLElement | undefined;

	const setOpenState = (next: boolean) => {
		if (open() === next) return;
		if (props.open === undefined) setInternalOpen(next);
		props.onOpenChange?.(next);
	};
	const close = (restoreFocus = false) => {
		if (!open()) return;
		setOpenState(false);
		if (restoreFocus) queueMicrotask(() => trigger?.focus());
	};
	const updatePosition = () => {
		if (!trigger || !panel) return;
		const anchor = trigger.getBoundingClientRect();
		const overlay = panel.getBoundingClientRect();
		const placement = props.placement ?? "bottom-start";
		const preferredLeft = placement.endsWith("end")
			? anchor.right - overlay.width
			: anchor.left;
		const preferredTop = placement.startsWith("top")
			? anchor.top - overlay.height - anchorGap
			: anchor.bottom + anchorGap;
		const maxLeft = Math.max(
			viewportMargin,
			window.innerWidth - overlay.width - viewportMargin
		);
		const maxTop = Math.max(
			viewportMargin,
			window.innerHeight - overlay.height - viewportMargin
		);
		setPosition({
			left: Math.min(Math.max(viewportMargin, preferredLeft), maxLeft),
			top: Math.min(Math.max(viewportMargin, preferredTop), maxTop)
		});
	};

	createEffect(open, (isOpen) => {
		if (!isOpen) return;
		const frame = requestAnimationFrame(updatePosition);
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	});

	onSettled(() => {
		const ownerDocument = trigger?.ownerDocument ?? document;
		const isWithinPopover = (event: Event) => {
			const path = event.composedPath();
			return (
				(trigger !== undefined && path.includes(trigger)) ||
				(panel !== undefined && path.includes(panel))
			);
		};
		const closeFromOutside = (event: Event) => {
			if (open() && !isWithinPopover(event)) close();
		};
		const closeFromEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && open()) close(true);
		};
		ownerDocument.addEventListener("pointerdown", closeFromOutside, true);
		ownerDocument.addEventListener("focusin", closeFromOutside, true);
		ownerDocument.addEventListener("keydown", closeFromEscape, true);
		return () => {
			ownerDocument.removeEventListener("pointerdown", closeFromOutside, true);
			ownerDocument.removeEventListener("focusin", closeFromOutside, true);
			ownerDocument.removeEventListener("keydown", closeFromEscape, true);
		};
	});

	return (
		<>
			{props.trigger({
				"aria-controls": props.id,
				get "aria-expanded"() {
					return open() ? "true" : "false";
				},
				"aria-haspopup": "dialog",
				onClick: () => setOpenState(!open()),
				ref: (element) => {
					trigger = element;
				}
			})}
			<Show when={open()}>
				<Portal>
					<section
						{...stylex.attrs(styles.panel, props.style)}
						aria-label={props.ariaLabel}
						id={props.id}
						ref={(element) => {
							panel = element;
						}}
						role="dialog"
						style={{
							left: `${position().left}px`,
							position: "fixed",
							top: `${position().top}px`
						}}
					>
						{props.children}
					</section>
				</Portal>
			</Show>
		</>
	);
}

const styles = stylex.create({
	panel: {
		fontFamily: tokens.fontBody,
		fontFeatureSettings: '"cv01", "ss03", "zero"',
		lineHeight: 1.5
	}
});
