// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { SavedMapPicker } from "./saved-map-picker.js";

afterEach(cleanup);

const maps = [
	{ label: "Camera Load", mapPath: "Content/Fixture/Cameras/L_CameraLoad.umap" },
	{ label: "Lighting Lab", mapPath: "Content/Maps/L_Lighting.umap" },
	{ label: "Map History", mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap" }
] as const;

function renderPicker(allowCustomPath = false) {
	const [mapPath, setMapPath] = createSignal(maps[0].mapPath);
	render(() => (
		<SavedMapPicker
			allowCustomPath={allowCustomPath}
			maps={maps}
			mapPath={mapPath()}
			onMapPathChange={setMapPath}
		/>
	));
	return { mapPath };
}

describe("SavedMapPicker", () => {
	it("searches labels and paths before selecting a map", async () => {
		const user = userEvent.setup();
		const { mapPath } = renderPicker();

		await user.click(screen.getByRole("combobox", { name: "Saved map" }));
		const search = screen.getByRole("searchbox", { name: "Search saved maps" });
		await user.type(search, "historyworld");

		expect(screen.queryByRole("option", { name: /Camera Load/ })).toBeNull();
		await user.click(screen.getByRole("option", { name: /Map History/ }));

		expect(mapPath()).toBe("Content/Fixture/History/L_MapHistoryWorld.umap");
		expect(screen.getByRole("combobox", { name: "Saved map" }).textContent).toContain(
			"Map History"
		);
	});

	it("supports keyboard selection and an explicit custom path", async () => {
		const user = userEvent.setup();
		const { mapPath } = renderPicker(true);

		await user.click(screen.getByRole("combobox", { name: "Saved map" }));
		const search = screen.getByRole("searchbox", { name: "Search saved maps" });
		await user.type(search, "lighting");
		await user.keyboard("{Enter}");
		expect(mapPath()).toBe("Content/Maps/L_Lighting.umap");

		await user.click(screen.getByRole("combobox", { name: "Saved map" }));
		await user.click(screen.getByRole("option", { name: /CUSTOM MAP PATH/ }));
		const customPath = screen.getByRole("textbox", { name: "Custom map path" });
		await user.clear(customPath);
		await user.type(customPath, "Content/Maps/L_Custom.umap");
		expect(mapPath()).toBe("Content/Maps/L_Custom.umap");
	});
});
