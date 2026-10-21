import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnchoredPopover } from "./anchored-popover.js";
import { ToolButton } from "./tool-button.js";
import { ToolIcon } from "./tool-icon.js";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("labels an icon tool and shows a dismissible tooltip on keyboard focus", async () => {
	render(() => (
		<>
			<ToolButton label="Filter" tooltip="Narrow lines by state or location.">
				<ToolIcon name="filter" />
			</ToolButton>
			<button type="button">Next</button>
		</>
	));
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	const tool = screen.getByRole("button", { name: "Filter" });
	expect(tool.textContent).toBe("");
	await user.tab();
	expect(document.activeElement).toBe(tool);
	const tooltip = await screen.findByRole("tooltip");
	expect(tooltip.textContent).toContain("Narrow lines by state or location.");
	expect(tool.getAttribute("aria-describedby")).toBe(tooltip.id);
	expect(tooltip.parentElement).toBe(document.body);
	await user.keyboard("{Escape}");
	expect(screen.queryByRole("tooltip")).toBeNull();
	expect(document.activeElement).toBe(tool);
	await user.tab();
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" }));
});

it("lets the pointer through a hovered tooltip and closes it when the pointer leaves", async () => {
	render(() => (
		<>
			<ToolButton label="Display" tooltip="Change list grouping.">
				<ToolIcon name="display" />
			</ToolButton>
			<button type="button">Neighbour</button>
		</>
	));
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	await user.hover(screen.getByRole("button", { name: "Display" }));
	vi.advanceTimersByTime(300);
	await screen.findByRole("tooltip");
	// The tooltip takes no pointer events (Workbench's layout e2e clicks through one), so moving
	// toward a neighbouring control closes it.
	await user.hover(screen.getByRole("button", { name: "Neighbour" }));
	vi.advanceTimersByTime(300);
	await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});

it("shows only the most recently hovered or focused tool's tooltip", async () => {
	render(() => (
		<>
			<ToolButton label="Filter" tooltip="Narrow lines by state.">
				<ToolIcon name="filter" />
			</ToolButton>
			<ToolButton label="Display" tooltip="Change list grouping.">
				<ToolIcon name="display" />
			</ToolButton>
		</>
	));
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	await user.hover(screen.getByRole("button", { name: "Display" }));
	vi.advanceTimersByTime(300);
	await screen.findByRole("tooltip");
	await user.tab();
	await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("Filter"));
	expect(screen.getAllByRole("tooltip")).toHaveLength(1);
	await user.unhover(screen.getByRole("button", { name: "Display" }));
	vi.advanceTimersByTime(300);
	await user.hover(screen.getByRole("button", { name: "Display" }));
	vi.advanceTimersByTime(300);
	await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("Display"));
	expect(screen.getAllByRole("tooltip")).toHaveLength(1);
});

it("exposes toggle state and changes its tooltip after the tool is used", async () => {
	render(() => {
		const [reviewed, setReviewed] = createSignal(false);
		return (
			<ToolButton
				label="Reviewed"
				tooltip={
					reviewed() ? "On. Remove the review flag." : "Off. Mark this text reviewed."
				}
				aria-pressed={reviewed() ? "true" : "false"}
				onClick={() => setReviewed(!reviewed())}
			>
				<ToolIcon name="reviewed" />
			</ToolButton>
		);
	});
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	const tool = screen.getByRole("button", { name: "Reviewed", pressed: false });
	await user.click(tool);
	expect(tool.getAttribute("aria-pressed")).toBe("true");
	// Clicking dismisses the tooltip; leaving and returning reveals the new state.
	expect(screen.queryByRole("tooltip")).toBeNull();
	await user.unhover(tool);
	vi.advanceTimersByTime(300);
	await user.hover(tool);
	vi.advanceTimersByTime(300);
	expect((await screen.findByRole("tooltip")).textContent).toContain("On. Remove");
});

it("forwards a popover's trigger ref and restores keyboard focus when its menu closes", async () => {
	render(() => (
		<AnchoredPopover
			id="tool-menu"
			ariaLabel="Display options"
			trigger={(trigger) => (
				<ToolButton {...trigger} label="Display" tooltip="Change list grouping.">
					<ToolIcon name="display" />
				</ToolButton>
			)}
		>
			<button type="button">Folder</button>
		</AnchoredPopover>
	));
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	await user.click(screen.getByRole("button", { name: "Display" }));
	await screen.findByRole("dialog", { name: "Display options" });
	expect(screen.queryByRole("tooltip")).toBeNull();
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Folder" }))
	);
	await user.keyboard("{Escape}");
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Display" }))
	);
	// Focus returning from the closed menu is not a fresh visit, so no tooltip reappears.
	expect(screen.queryByRole("tooltip")).toBeNull();
});

it("does not open a tooltip when a pointer press focuses the tool", async () => {
	render(() => (
		<ToolButton label="Filter" tooltip="Narrow lines.">
			<ToolIcon name="filter" />
		</ToolButton>
	));
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	const tool = screen.getByRole("button", { name: "Filter" });
	await user.pointer({ keys: "[MouseLeft>]", target: tool });
	expect(document.activeElement).toBe(tool);
	expect(screen.queryByRole("tooltip")).toBeNull();
	await user.pointer({ keys: "[/MouseLeft]", target: tool });
});

it("explains a disabled tool on hover and names its badge", async () => {
	render(() => (
		<>
			<ToolButton
				label="Export"
				tooltip="Wait for the search to finish before exporting."
				disabled
			>
				<ToolIcon name="export" />
			</ToolButton>
			<ToolButton label="Filter" tooltip="Narrow lines." badge={3} badgeLabel="3 active">
				<ToolIcon name="filter" />
			</ToolButton>
			<ToolButton label="Files" tooltip="Scope by file." badge={2}>
				<ToolIcon name="files" />
			</ToolButton>
			<ToolButton label="Checks (4)" tooltip="Findings." badge={4} badgeLabel="">
				<ToolIcon name="checks" />
			</ToolButton>
		</>
	));
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	const exporter = screen.getByRole("button", { name: "Export" });
	expect(exporter).toHaveProperty("disabled", true);
	const anchor = exporter.parentElement;
	if (!anchor) throw new Error("The disabled tool has no hover anchor.");
	await user.hover(anchor);
	vi.advanceTimersByTime(300);
	expect((await screen.findByRole("tooltip")).textContent).toContain("Wait for the search");
	expect(screen.getByRole("button", { name: "Filter, 3 active" })).toBeDefined();
	expect(screen.getByRole("button", { name: "Files, 2" })).toBeDefined();
	expect(screen.getByRole("button", { name: "Checks (4)" })).toBeDefined();
});

it("shows a visible label and keeps the tooltip to extra description", async () => {
	render(() => (
		<>
			<ToolButton label="Display" showLabel>
				<ToolIcon name="display" />
			</ToolButton>
			<ToolButton label="Filter" tooltip="Narrow lines by state." badge={2} showLabel>
				<ToolIcon name="filter" />
			</ToolButton>
		</>
	));
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	const display = screen.getByRole("button", { name: "Display" });
	expect(display.textContent).toBe("Display");
	await user.tab();
	expect(document.activeElement).toBe(display);
	expect(screen.queryByRole("tooltip")).toBeNull();
	await user.hover(screen.getByRole("button", { name: "Filter, 2" }));
	vi.advanceTimersByTime(300);
	const tooltip = await screen.findByRole("tooltip");
	expect(tooltip.textContent).toBe("Narrow lines by state.");
});

it("cancels a pending hover delay when the tool unmounts", () => {
	vi.useFakeTimers();
	const view = render(() => (
		<ToolButton label="Filter" tooltip="Narrow lines by state or location.">
			<ToolIcon name="filter" />
		</ToolButton>
	));
	const anchor = screen.getByRole("button", { name: "Filter" }).parentElement;
	if (!anchor) throw new Error("The icon tool has no hover anchor.");
	fireEvent.pointerEnter(anchor);
	expect(vi.getTimerCount()).toBe(1);
	view.unmount();
	expect(vi.getTimerCount()).toBe(0);
	vi.runAllTimers();
	expect(screen.queryByRole("tooltip")).toBeNull();
});

it("attaches document listeners only while open and releases them on unmount", async () => {
	const addDocument = vi.spyOn(document, "addEventListener");
	const removeDocument = vi.spyOn(document, "removeEventListener");
	const addWindow = vi.spyOn(window, "addEventListener");
	const removeWindow = vi.spyOn(window, "removeEventListener");
	const frames = vi.spyOn(globalThis, "requestAnimationFrame");
	const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame");
	const view = render(() => (
		<ToolButton label="Display" tooltip="Change list grouping.">
			<ToolIcon name="display" />
		</ToolButton>
	));
	expect(addDocument).not.toHaveBeenCalled();
	await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).tab();
	await screen.findByRole("tooltip");
	const escape = addDocument.mock.calls.find(([name]) => name === "keydown")?.[1];
	const claim = addDocument.mock.calls.find(
		([name]) => name === "ue-shed:tool-tooltip-open"
	)?.[1];
	const resize = addWindow.mock.calls.find(([name]) => name === "resize")?.[1];
	const scroll = addWindow.mock.calls.find(([name]) => name === "scroll")?.[1];
	const frame = frames.mock.results.find((result) => result.type === "return")?.value;
	expect(escape).toBeDefined();
	expect(claim).toBeDefined();
	expect(resize).toBeDefined();
	expect(scroll).toBeDefined();
	expect(frame).toBeDefined();
	view.unmount();
	expect(removeDocument).toHaveBeenCalledWith("keydown", escape);
	expect(removeDocument).toHaveBeenCalledWith("ue-shed:tool-tooltip-open", claim);
	expect(removeWindow).toHaveBeenCalledWith("resize", resize);
	expect(removeWindow).toHaveBeenCalledWith("scroll", scroll, true);
	expect(cancelFrame).toHaveBeenCalledWith(frame);
	expect(screen.queryByRole("tooltip")).toBeNull();
});
