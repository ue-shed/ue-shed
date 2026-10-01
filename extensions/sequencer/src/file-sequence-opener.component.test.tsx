import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SequenceViewer, type SequenceOpenerControls } from "./sequence-viewer.js";
import type { SequenceReadResult } from "./contract.js";
import { sequenceReadFixture } from "./sequence-fixture.test-support.js";
import { FileSequenceOpener, MAX_SEQUENCE_FILE_BYTES } from "./file-sequence-opener.js";

const runtime = ManagedRuntime.make(Layer.empty);
const ready: SequenceReadResult = { ...sequenceReadFixture, outcome: "complete" };

afterEach(cleanup);
afterAll(() => runtime.dispose());

function controls(): SequenceOpenerControls {
	return { open: vi.fn(), loading: false, hasSequence: false, observeSourceBusy: vi.fn() };
}

describe("file Sequence opener", () => {
	it("chooses a file and opens the host read", async () => {
		const owner = controls();
		const read = Effect.succeed(ready);
		const readFile = vi.fn(() => read);
		render(() => <FileSequenceOpener controls={owner} readFile={readFile} />);
		const file = new File(["saved bytes"], "LS_Test.uasset");
		await userEvent
			.setup()
			.upload(screen.getByLabelText("Choose a Level Sequence .uasset"), file);
		expect(readFile).toHaveBeenCalledWith(file);
		expect(owner.open).toHaveBeenCalledWith(read);
		expect(screen.getByText(/never uploaded/)).toBeDefined();
	});

	it("opens the labelled picker from the primary button and the drop zone", async () => {
		const owner = controls();
		render(() => (
			<FileSequenceOpener controls={owner} readFile={() => Effect.succeed(ready)} />
		));
		const picker = screen.getByLabelText("Choose a Level Sequence .uasset");
		const click = vi.spyOn(picker, "click");
		const user = userEvent.setup();
		await user.tab();
		expect(document.activeElement).toBe(picker);
		await user.click(screen.getByRole("button", { name: "Choose a .uasset" }));
		expect(click).toHaveBeenCalledOnce();
		await user.click(screen.getByRole("group", { name: "Open sequence file" }));
		expect(click).toHaveBeenCalledTimes(2);
	});

	it("shows drop-to-open copy while a file is dragged over the viewer", async () => {
		const owner = controls();
		render(() => (
			<main>
				<FileSequenceOpener controls={owner} readFile={() => Effect.succeed(ready)} />
			</main>
		));
		const zone = screen.getByRole("group", { name: "Open sequence file" });
		fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], dropEffect: "none" } });
		await waitFor(() => expect(screen.getByText("Drop to open")).toBeDefined());
		fireEvent.dragLeave(zone, { relatedTarget: null });
		await waitFor(() =>
			expect(screen.getByText("Drop a Level Sequence .uasset here")).toBeDefined()
		);
		expect(owner.open).not.toHaveBeenCalled();
	});

	it("rejects oversize files before invoking the reader", async () => {
		const owner = controls();
		const readFile = vi.fn(() => Effect.succeed(ready));
		render(() => <FileSequenceOpener controls={owner} readFile={readFile} />);
		const file = new File(["x"], "Large.uasset");
		Object.defineProperty(file, "size", { value: MAX_SEQUENCE_FILE_BYTES + 1 });
		await userEvent
			.setup()
			.upload(screen.getByLabelText("Choose a Level Sequence .uasset"), file);
		expect(screen.getByRole("alert").textContent).toContain("up to 64 MiB");
		expect(readFile).not.toHaveBeenCalled();
		expect(owner.open).not.toHaveBeenCalled();
	});

	it("opens the optional sample", async () => {
		const owner = controls();
		const read = Effect.succeed(ready);
		const load = vi.fn(() => read);
		render(() => (
			<FileSequenceOpener
				controls={owner}
				readFile={() => read}
				sample={{ label: "Try the sample Sequence", load }}
			/>
		));
		const picker = screen.getByLabelText("Choose a Level Sequence .uasset");
		const click = vi.spyOn(picker, "click");
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Try the sample Sequence" }));
		expect(load).toHaveBeenCalledOnce();
		expect(owner.open).toHaveBeenCalledWith(read);
		expect(click).not.toHaveBeenCalled();
	});

	it("renders ready evidence through the viewer and accepts a drop on the viewer", async () => {
		const readFile = vi.fn(() => Effect.succeed(ready));
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SequenceViewer
					opener={(owner) => <FileSequenceOpener controls={owner} readFile={readFile} />}
				/>
			</EffectRuntimeProvider>
		));
		await userEvent
			.setup()
			.upload(
				screen.getByLabelText("Choose a Level Sequence .uasset"),
				new File(["x"], "LS_Test.uasset")
			);
		await waitFor(() =>
			expect(screen.getByRole("region", { name: "Sequence coverage" }).textContent).toContain(
				"LS"
			)
		);
		expect(screen.getByText("Fully decoded")).toBeDefined();
		const picker = screen.getByLabelText("Choose a Level Sequence .uasset");
		const click = vi.spyOn(picker, "click");
		await userEvent.setup().click(screen.getByRole("button", { name: "Open another .uasset" }));
		expect(click).toHaveBeenCalledOnce();
		fireEvent.drop(screen.getByRole("main"), {
			dataTransfer: { files: [new File(["y"], "LS_Another.uasset")], types: ["Files"] }
		});
		await waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
	});
});
