import { onSettled } from "solid-js";

export interface DismissibleDetails {
	readonly close: () => void;
	readonly ref: (element: HTMLDetailsElement) => void;
}

/** Adds light-dismiss behavior to a details element used as a floating panel. */
export function createDismissibleDetails(): DismissibleDetails {
	let details: HTMLDetailsElement | undefined;

	const close = () => {
		if (!details?.open) return;
		details.open = false;
	};

	const ref = (element: HTMLDetailsElement) => {
		details = element;
	};

	onSettled(() => {
		const ownerDocument = details?.ownerDocument ?? document;
		const closeFromOutside = (event: Event) => {
			if (!details?.open || event.composedPath().includes(details)) return;
			details.open = false;
		};
		const closeFromEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !details?.open) return;
			close();
			details.querySelector<HTMLElement>("summary")?.focus();
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

	return { close, ref };
}
