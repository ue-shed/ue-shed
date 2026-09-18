import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AnchoredPopover } from "./anchored-popover.js";

afterEach(cleanup);

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
