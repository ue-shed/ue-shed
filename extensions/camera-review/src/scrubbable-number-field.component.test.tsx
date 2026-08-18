// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { ScrubbableNumberField } from "./scrubbable-number-field.js";

afterEach(cleanup);

describe("ScrubbableNumberField", () => {
	it("drags horizontally with coarse and fine modifiers while preserving exact entry", () => {
		const [value, setValue] = createSignal(10);
		const commits: number[] = [];
		render(() => (
			<ScrubbableNumberField
				label="YAW"
				value={value()}
				step={0.1}
				scrubStep={0.5}
				onValueChange={setValue}
				onValueCommit={(next) => commits.push(next)}
			/>
		));
		const handle = screen.getByRole("button", { name: "Drag YAW to adjust" });
		fireEvent.pointerDown(handle, { button: 0, clientX: 20, pointerId: 1 });
		fireEvent.pointerMove(handle, { clientX: 24, pointerId: 1 });
		expect(value()).toBe(12);
		fireEvent.pointerMove(handle, { clientX: 26, pointerId: 1, shiftKey: true });
		expect(value()).toBe(22);
		fireEvent.pointerMove(handle, { altKey: true, clientX: 36, pointerId: 1 });
		expect(value()).toBe(22.5);
		expect(commits).toEqual([]);
		fireEvent.pointerUp(handle, { clientX: 36, pointerId: 1 });
		expect(commits).toEqual([22.5]);

		const input = screen.getByRole("spinbutton", { name: "YAW" });
		fireEvent.input(input, {
			target: { value: "33.25" }
		});
		expect(value()).toBe(33.25);
		fireEvent.change(input, { target: { value: "33.25" } });
		expect(commits).toEqual([22.5, 33.25]);
	});

	it("shows large world-space values without meaningless floating-point noise", () => {
		render(() => (
			<ScrubbableNumberField
				label="X"
				value={529_402.334_558_219_1}
				onValueChange={() => undefined}
			/>
		));

		expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "X" }).value).toBe(
			"529402.335"
		);
	});

	it("starts an inherited blank value at its scrub origin and clamps the result", () => {
		const [value, setValue] = createSignal<number>();
		render(() => (
			<ScrubbableNumberField
				label="MARGIN OVERRIDE"
				value={value()}
				min={0}
				max={0.45}
				scrubOrigin={0.2}
				scrubStep={0.01}
				onValueChange={setValue}
			/>
		));
		const handle = screen.getByRole("button", {
			name: "Drag MARGIN OVERRIDE to adjust"
		});
		fireEvent.pointerDown(handle, { button: 0, clientX: 10, pointerId: 2 });
		fireEvent.pointerMove(handle, { clientX: 50, pointerId: 2 });
		expect(value()).toBe(0.45);
	});
});
