import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createDismissibleDetails } from "./dismissible-details.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function DismissibleDetailsFixture() {
	const first = createDismissibleDetails();
	const second = createDismissibleDetails();
	return (
		<>
			<details ref={(element) => first.ref(element)}>
				<summary>First menu</summary>
				<button type="button">First action</button>
			</details>
			<details ref={(element) => second.ref(element)}>
				<summary>Second menu</summary>
				<button type="button">Second action</button>
			</details>
			<button type="button">Outside</button>
		</>
	);
}

function detailsFor(summary: HTMLElement): HTMLDetailsElement {
	const details = summary.closest("details");
	if (!(details instanceof HTMLDetailsElement)) throw new Error("Expected details element");
	return details;
}

it("closes an open floating panel when the user clicks outside", async () => {
	render(() => <DismissibleDetailsFixture />);
	const user = userEvent.setup();
	const summary = screen.getByText("First menu");
	const details = detailsFor(summary);

	await user.click(summary);
	expect(details.open).toBe(true);
	await user.click(screen.getByRole("button", { name: "First action" }));
	expect(details.open).toBe(true);
	await user.click(screen.getByRole("button", { name: "Outside" }));
	expect(details.open).toBe(false);
});

it("closes the prior panel when another panel opens", async () => {
	render(() => <DismissibleDetailsFixture />);
	const user = userEvent.setup();
	const firstSummary = screen.getByText("First menu");
	const secondSummary = screen.getByText("Second menu");
	const first = detailsFor(firstSummary);
	const second = detailsFor(secondSummary);

	await user.click(firstSummary);
	await user.click(secondSummary);

	expect(first.open).toBe(false);
	expect(second.open).toBe(true);
});

it("closes on Escape and returns focus to the summary", async () => {
	render(() => <DismissibleDetailsFixture />);
	const user = userEvent.setup();
	const summary = screen.getByText("First menu");
	const details = detailsFor(summary);

	await user.click(summary);
	await user.click(screen.getByRole("button", { name: "First action" }));
	await user.keyboard("{Escape}");

	expect(details.open).toBe(false);
	expect(document.activeElement).toBe(summary);
});

it("closes when keyboard focus leaves the panel", async () => {
	render(() => <DismissibleDetailsFixture />);
	const user = userEvent.setup();
	const summary = screen.getByText("First menu");
	const details = detailsFor(summary);

	await user.click(summary);
	await user.click(screen.getByRole("button", { name: "First action" }));
	await user.tab();

	expect(details.open).toBe(false);
});

it("removes every light-dismiss listener when its owner unmounts", () => {
	const added = vi.spyOn(document, "addEventListener");
	const removed = vi.spyOn(document, "removeEventListener");
	const view = render(() => <DismissibleDetailsFixture />);
	const listeners = added.mock.calls.filter(
		([type, , capture]) =>
			capture === true && ["pointerdown", "focusin", "keydown"].includes(type)
	);
	expect(listeners).toHaveLength(6);
	view.unmount();
	for (const listener of listeners) expect(removed).toHaveBeenCalledWith(...listener);
});
