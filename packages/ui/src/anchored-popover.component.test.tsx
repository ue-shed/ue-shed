import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
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
			capture === true && ["pointerdown", "focusin", "keydown"].includes(type)
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
