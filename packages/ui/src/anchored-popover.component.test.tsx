import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Show, createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { AnchoredPopover } from "./anchored-popover.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function PopoverFixture() {
	return (
		<div style={{ overflow: "hidden" }}>
			<AnchoredPopover
				ariaLabel="Actions"
				id="actions-popover"
				trigger={(props) => (
					<button {...props} type="button">
						Open actions
					</button>
				)}
			>
				<button type="button">Run action</button>
			</AnchoredPopover>
			<button type="button">Outside</button>
		</div>
	);
}

it("portals the panel and exposes its state from the trigger", async () => {
	render(() => <PopoverFixture />);
	const trigger = screen.getByRole("button", { name: "Open actions" });

	await userEvent.setup().click(trigger);

	const panel = screen.getByRole("dialog", { name: "Actions" });
	expect(trigger.getAttribute("aria-expanded")).toBe("true");
	expect(panel.parentElement).toBe(document.body);
	expect(panel.className).not.toBe("");
});

it("enters the panel from the keyboard", async () => {
	render(() => <PopoverFixture />);
	const user = userEvent.setup();
	const trigger = screen.getByRole("button", { name: "Open actions" });
	trigger.focus();
	await user.keyboard("{Enter}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run action" }));
});

it("light-dismisses and returns focus after Escape", async () => {
	render(() => <PopoverFixture />);
	const user = userEvent.setup();
	const trigger = screen.getByRole("button", { name: "Open actions" });

	await user.click(trigger);
	await user.click(screen.getByRole("button", { name: "Run action" }));
	await user.keyboard("{Escape}");

	expect(screen.queryByRole("dialog", { name: "Actions" })).toBeNull();
	expect(trigger.getAttribute("aria-expanded")).toBe("false");
	expect(document.activeElement).toBe(trigger);
});

/**
 * Dispatches a key press with the browser's real microtask ordering. A trusted key event runs a
 * microtask checkpoint after every listener callback, so a microtask queued by a document capture
 * listener runs before any target or bubble handler, including Solid's delegated handlers. A
 * synthetic `dispatchEvent` from a test defers every microtask until dispatch returns, which hides
 * that ordering; draining at the root's capture listener restores it.
 */
function pressWithBrowserOrdering(target: Element, key: string) {
	const pending: Array<() => void> = [];
	const drain = () => {
		while (pending.length) pending.shift()?.();
	};
	const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
		pending.push(task);
	});
	document.documentElement.addEventListener("keydown", drain, true);
	try {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	} finally {
		document.documentElement.removeEventListener("keydown", drain, true);
		queue.mockRestore();
		drain();
	}
}

function SubmenuFixture(props: { readonly stop?: boolean }) {
	const [submenu, setSubmenu] = createSignal(true);
	return (
		<AnchoredPopover
			ariaLabel="Filters"
			id="filters-popover"
			trigger={(trigger) => (
				<button {...trigger} type="button">
					Filter
				</button>
			)}
		>
			<button type="button">Field</button>
			<Show when={submenu()}>
				<div
					role="menu"
					aria-label="Values"
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						if (props.stop) event.stopPropagation();
						setSubmenu(false);
					}}
				>
					<button type="button">Value</button>
				</div>
			</Show>
		</AnchoredPopover>
	);
}

for (const stop of [false, true]) {
	it(`lets an inner Escape handler that ${stop ? "stops propagation" : "prevents default"} close only its submenu`, async () => {
		render(() => <SubmenuFixture stop={stop} />);
		await userEvent.setup().click(screen.getByRole("button", { name: "Filter" }));
		const value = screen.getByRole("button", { name: "Value" });
		value.focus();

		pressWithBrowserOrdering(value, "Escape");
		flush();

		expect(screen.queryByRole("menu", { name: "Values" })).toBeNull();
		expect(screen.getByRole("dialog", { name: "Filters" })).toBeDefined();

		pressWithBrowserOrdering(screen.getByRole("button", { name: "Field" }), "Escape");
		flush();
		expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter" }));
	});
}

it("closes on Escape when focus has left the panel but is not elsewhere", async () => {
	render(() => <PopoverFixture />);
	const trigger = screen.getByRole("button", { name: "Open actions" });
	await userEvent.setup().click(trigger);
	const focused = document.activeElement;
	if (focused instanceof HTMLElement) focused.blur();

	pressWithBrowserOrdering(document.body, "Escape");
	flush();

	expect(screen.queryByRole("dialog", { name: "Actions" })).toBeNull();
	expect(document.activeElement).toBe(trigger);
});

function KeyboardFixture() {
	return (
		<>
			<AnchoredPopover
				ariaLabel="Search options"
				id="search-popover"
				trigger={(trigger) => (
					<button {...trigger} type="button">
						Options
					</button>
				)}
			>
				<input type="search" aria-label="Filter options" value="needle" />
				<button type="button">First</button>
				<button type="button">Second</button>
				<button type="button">Last</button>
			</AnchoredPopover>
			<button type="button" hidden>
				Hidden
			</button>
			<button type="button" disabled>
				Disabled
			</button>
			<button type="button" tabindex="-1">
				Programmatic
			</button>
			<span hidden>
				<button type="button">Inside hidden</button>
			</span>
			<button type="button">Reachable</button>
		</>
	);
}

it("keeps caret keys in a search field and enters the list at either end", async () => {
	render(() => <KeyboardFixture />);
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Options" }));
	const search = screen.getByRole("searchbox", { name: "Filter options" });
	expect(document.activeElement).toBe(search);

	for (const key of ["Home", "End", "ArrowLeft", "ArrowRight"]) {
		const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
		search.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(search);
	}

	await user.keyboard("{ArrowUp}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
	search.focus();
	await user.keyboard("{ArrowDown}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
	await user.keyboard("{End}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
	await user.keyboard("{Home}");
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
});

it("tabs out of the panel to the next focusable, visible element", async () => {
	render(() => <KeyboardFixture />);
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Options" }));
	screen.getByRole("button", { name: "Last" }).focus();

	await user.keyboard("{Tab}");

	expect(screen.queryByRole("dialog", { name: "Search options" })).toBeNull();
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reachable" }));
});

it("releases positioning resources on close and document listeners on unmount", () => {
	const documentAdds = vi.spyOn(document, "addEventListener");
	const documentRemoves = vi.spyOn(document, "removeEventListener");
	const windowAdds = vi.spyOn(window, "addEventListener");
	const windowRemoves = vi.spyOn(window, "removeEventListener");
	const frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(41);
	const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
	const view = render(() => <PopoverFixture />);
	const trigger = screen.getByRole("button", { name: "Open actions" });
	const listeners = documentAdds.mock.calls.filter(
		([type, , capture]) =>
			(capture === true && ["pointerdown", "focusin"].includes(type)) ||
			(capture === undefined && type === "keydown")
	);
	expect(listeners).toHaveLength(3);

	fireEvent.click(trigger);
	expect(frames).toHaveBeenCalledTimes(1);
	const positioning = windowAdds.mock.calls.filter(([type]) =>
		["resize", "scroll"].includes(type)
	);
	expect(positioning).toHaveLength(2);
	fireEvent.click(trigger);
	expect(cancelFrame).toHaveBeenCalledWith(41);
	for (const listener of positioning) expect(windowRemoves).toHaveBeenCalledWith(...listener);

	fireEvent.click(trigger);
	view.unmount();
	expect(cancelFrame).toHaveBeenCalledTimes(2);
	for (const listener of listeners) expect(documentRemoves).toHaveBeenCalledWith(...listener);
	for (const listener of positioning) expect(windowRemoves).toHaveBeenCalledWith(...listener);
	expect(screen.queryByRole("dialog", { name: "Actions" })).toBeNull();
});
