// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { searchDoneInPage, searchRecorder } from "./benchmark-game-text-desktop-page.js";

/** The route's search box and its count, as the benchmark finds them. */
function searchBox(count: string) {
	document.body.innerHTML = `<div><input aria-label="Search game text" /><span role="status">${count}</span></div>`;
	const input = document.querySelector("input");
	const status = document.querySelector('[role="status"]');
	if (!input || !status) throw new Error("search box");
	return { input, status };
}

const evaluate = (script: string): unknown => (0, eval)(script);
const settle = () => new Promise((done) => setTimeout(done, 0));

afterEach(() => {
	document.body.innerHTML = "";
});

it("finishes a repeated search whose count shows Searching and returns between polls", async () => {
	const { input, status } = searchBox("1 match");
	evaluate(searchRecorder);
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	// Both changes land before the next poll; the count ends where it started.
	status.textContent = "Searching…";
	status.textContent = "1 match";
	await settle();
	expect(evaluate(searchDoneInPage)).toMatchObject({ pressedAt: expect.any(Number) });
});

it("finishes once Searching is seen, even through a replaced text node", async () => {
	const { input, status } = searchBox("1 match");
	evaluate(searchRecorder);
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	status.firstChild?.replaceWith(document.createTextNode("Searching…"));
	await settle();
	expect(evaluate(searchDoneInPage)).toBe(false);
	status.firstChild?.replaceWith(document.createTextNode("1 match"));
	await settle();
	expect(evaluate(searchDoneInPage)).toMatchObject({ pressedAt: expect.any(Number) });
});

it("keeps waiting before Enter and while the count has not changed", async () => {
	const { input, status } = searchBox("2 matches");
	evaluate(searchRecorder);
	status.textContent = "Searching…";
	status.textContent = "2 matches";
	await settle();
	expect(evaluate(searchDoneInPage)).toBe(false);
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
	await settle();
	expect(evaluate(searchDoneInPage)).toBe(false);
	status.textContent = "1 match";
	expect(evaluate(searchDoneInPage)).toMatchObject({ pressedAt: expect.any(Number) });
});
