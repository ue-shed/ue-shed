import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { TaskProgressModal } from "./task-progress-modal.js";

afterEach(cleanup);

it("opens outside its parent, remains modal until completion, and can reopen", () => {
	const [open, setOpen] = createSignal(true);
	const result = render(() => (
		<TaskProgressModal
			open={open()}
			title="Indexing project"
			detail="Loading packages"
			progress={{ completed: 3, total: 10, phase: "scanning", stage: "project_index" }}
		/>
	));
	const dialog = screen.getByRole("dialog", { name: "Indexing project" });
	expect(dialog.hasAttribute("open")).toBe(true);
	expect(result.container.contains(dialog)).toBe(false);
	expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
	const cancel = new Event("cancel", { cancelable: true });
	dialog.dispatchEvent(cancel);
	expect(cancel.defaultPrevented).toBe(true);
	setOpen(false);
	flush();
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(dialog.hasAttribute("open")).toBe(false);
	setOpen(true);
	flush();
	expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
});
