// @vitest-environment jsdom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { TextOccurrenceId, type TextOccurrence } from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { OccurrenceCard } from "./game-text-query-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
afterEach(cleanup);

const place = (copies: TextOccurrence["copies"]): TextOccurrence => ({
	id: TextOccurrenceId.make("occurrence:title"),
	packageFile: "Content/UI/WBP_Menu.uasset",
	source: "Play now",
	devNotes: "",
	identity: { status: "resolved", namespace: "UI", key: "Title" },
	location: {
		kind: "asset_property",
		objectPath: "/Game/UI/WBP_Menu.WBP_Menu.WidgetTree.Title",
		classPath: "/Script/UMG.TextBlock",
		propertyPath: "Text"
	},
	editCapability: "read_only",
	...(copies === undefined ? undefined : { copies })
});

function mount(occurrence: TextOccurrence) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<OccurrenceCard
				client={{ locateAsset: () => Effect.never }}
				occurrence={occurrence}
				conflicting={false}
			/>
		</EffectRuntimeProvider>
	));
}

const compiled = "/Game/UI/WBP_Menu.WBP_Menu_C.WidgetTree.Title";

describe("occurrence card", () => {
	it("says what the game shows while the Blueprint is not compiled", () => {
		mount(place([{ objectPath: compiled, kind: "generated_class", source: "Play" }]));
		expect(
			screen.getByText(/Blueprint not compiled since this text was edited/u).textContent
		).toContain('The game shows "Play".');
		expect(screen.getByText(`${compiled} (compiled class copy, holds "Play")`)).toBeTruthy();
	});

	it("lists an up-to-date copy without a warning", () => {
		mount(place([{ objectPath: compiled, kind: "generated_class", source: "Play now" }]));
		expect(screen.queryByText(/Blueprint not compiled/u)).toBeNull();
		expect(screen.getByText(`${compiled} (compiled class copy)`)).toBeTruthy();
	});

	const skeleton = "/Game/UI/WBP_Menu.SKEL_WBP_Menu_C.WidgetTree.Title";

	it("lists a skeleton-only difference without claiming what the game shows", () => {
		mount(
			place([
				{ objectPath: compiled, kind: "generated_class", source: "Play now" },
				{ objectPath: skeleton, kind: "skeleton", source: "Play" }
			])
		);
		expect(screen.queryByText(/The game shows/u)).toBeNull();
		expect(screen.getByText(`${skeleton} (skeleton class copy, holds "Play")`)).toBeTruthy();
	});
});
