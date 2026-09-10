// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createVirtualizer } from "./virtualizer.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

it("measures nonempty rows after their data indexes are committed", async () => {
	const measuredIndexes: string[] = [];
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			if (this instanceof HTMLLIElement) {
				measuredIndexes.push(this.getAttribute("data-index") ?? "missing");
			}
			return 64;
		}
	);

	function MeasuredList() {
		let scrollElement: HTMLDivElement | undefined;
		const virtualizer = createVirtualizer<HTMLDivElement, HTMLLIElement>({
			count: 2,
			estimateSize: () => 20,
			getScrollElement: () => scrollElement ?? null,
			initialRect: { height: 200, width: 100 }
		});
		return (
			<div
				ref={(element) => {
					scrollElement = element;
				}}
			>
				<ul>
					<li data-index={0} ref={(element) => virtualizer.measureElement(element)} />
				</ul>
			</div>
		);
	}

	render(() => <MeasuredList />);
	await waitFor(() => expect(measuredIndexes.length).toBeGreaterThan(0));
	expect(measuredIndexes).not.toContain("missing");
});
