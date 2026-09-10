import {
	Virtualizer,
	elementScroll,
	observeElementOffset,
	observeElementRect,
	type VirtualizerOptions
} from "@tanstack/virtual-core";
import { createEffect, createSignal, onSettled, untrack } from "solid-js";

/** Connect the framework-neutral virtualizer to Solid's batched updates and owner lifetime. */
export function createVirtualizer<ScrollElement extends Element, ItemElement extends Element>(
	options: Omit<
		VirtualizerOptions<ScrollElement, ItemElement>,
		"observeElementRect" | "observeElementOffset" | "scrollToFn" | "onChange"
	>
) {
	const [revision, setRevision] = createSignal(0);
	const resolveOptions = (): VirtualizerOptions<ScrollElement, ItemElement> => ({
		...options,
		observeElementRect,
		observeElementOffset,
		scrollToFn: elementScroll,
		onChange: () => {
			setRevision((value) => value + 1);
		}
	});
	const instance = new Virtualizer<ScrollElement, ItemElement>(untrack(resolveOptions));
	createEffect(resolveOptions, (next) => {
		instance.setOptions(next);
		instance._willUpdate();
		setRevision((value) => value + 1);
	});
	onSettled(() => {
		const cleanup = instance._didMount();
		instance._willUpdate();
		return cleanup;
	});
	return {
		getVirtualItems: () => {
			revision();
			return instance.getVirtualItems();
		},
		getTotalSize: () => {
			revision();
			return instance.getTotalSize();
		},
		measureElement: instance.measureElement,
		scrollToIndex: instance.scrollToIndex
	};
}
