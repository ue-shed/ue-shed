import { afterEach, beforeEach, vi } from "vitest";

// JSDOM has no layout. Actor explorer consumers share a measurable scroll viewport
// while exercising the real virtualizer and its bounded rows.
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});
afterEach(() => vi.restoreAllMocks());
