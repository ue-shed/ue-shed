import { afterEach, beforeEach, vi } from "vitest";

// JSDOM has no layout. Give the real virtualizer a measurable scroll viewport.
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});
afterEach(() => vi.restoreAllMocks());
