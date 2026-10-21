// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import type {
	EditorAssetLocateResult,
	EditorAssetLocateUnavailableReason
} from "@ue-shed/protocol";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { GameTextClientError, type GameTextClientApi } from "./game-text-client.js";
import { ShowInUnrealButton } from "./game-text-locate-button.js";

const runtime = ManagedRuntime.make(Layer.empty);
const objectPath = "/Game/Text/ST_Game.ST_Game";
afterAll(() => runtime.dispose());
afterEach(cleanup);

function located(path: string = objectPath): EditorAssetLocateResult {
	return {
		contract: {
			name: "unreal-editor-asset-navigation",
			version: { major: 1, minor: 0 }
		},
		objectPath: path,
		status: "located"
	};
}

function mount(locateAsset: GameTextClientApi["locateAsset"]) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ShowInUnrealButton client={{ locateAsset }} objectPath={objectPath} />
		</EffectRuntimeProvider>
	));
}

const unavailableCases: readonly { readonly reason: EditorAssetLocateUnavailableReason }[] = [
	{ reason: "not_connected" }
];

describe("Show in Unreal", () => {
	it("waits for confirmation and prevents duplicate requests while locating", async () => {
		const response = await Effect.runPromise(Deferred.make<EditorAssetLocateResult>());
		const requested: string[] = [];
		mount((path) => {
			requested.push(path);
			return Deferred.await(response);
		});
		const user = userEvent.setup();
		const button = screen.getByRole("button", { name: "Show in Unreal" });
		await user.click(button);
		await waitFor(() => expect(button.textContent).toBe("Opening…"));
		expect(button).toHaveProperty("disabled", true);
		expect(screen.getByRole("status").textContent).toContain("Opening the asset");
		await user.click(button);
		expect(requested).toEqual([objectPath]);
		await Effect.runPromise(Deferred.succeed(response, located()));
		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toBe(
				"Shown in Unreal’s Content Browser."
			)
		);
		// The button keeps its name; the status says what happened.
		expect(button.textContent).toBe("Show in Unreal");
		expect(button).toHaveProperty("disabled", false);
	});

	it.each(unavailableCases)(
		"reports $reason without claiming success and allows retry",
		async ({ reason }) => {
			let attempts = 0;
			mount((path) => {
				attempts++;
				return Effect.succeed({
					...located(path),
					status: "unavailable",
					reason,
					message: "The editor could not show this asset.",
					recovery: "Connect a capable editor and retry.",
					retrySafe: true
				});
			});
			const user = userEvent.setup();
			const button = screen.getByRole("button", { name: "Show in Unreal" });
			await user.click(button);
			await waitFor(() =>
				expect(screen.getByRole("status").textContent).toContain(
					"Connect a capable editor and retry."
				)
			);
			expect(button.textContent).toBe("Show in Unreal");
			expect(button).toHaveProperty("disabled", false);
			expect(screen.queryByText(/Shown in Unreal/u)).toBeNull();
			await user.click(button);
			await waitFor(() => expect(attempts).toBe(2));
		}
	);

	it("reports a failed request with recovery guidance", async () => {
		mount(() =>
			Effect.fail(
				new GameTextClientError({
					message: "The GameTextClient operation failed.",
					retrySafe: false,
					nextStep: "reconcile",
					code: "game_text_client_failed",
					cause: new Error("Navigation failed"),
					operation: "locateAsset",
					recovery: "Reconnect."
				})
			)
		);
		await userEvent.setup().click(screen.getByRole("button", { name: "Show in Unreal" }));
		await screen.findByText(/Unreal did not answer/u);
		expect(screen.getByRole("status").textContent).toContain(
			"Check the editor connection and retry"
		);
		expect(screen.queryByText(/Shown in Unreal/u)).toBeNull();
	});

	it("rejects confirmation for a different asset", async () => {
		mount(() => Effect.succeed(located("/Game/Text/ST_Other.ST_Other")));
		await userEvent.setup().click(screen.getByRole("button", { name: "Show in Unreal" }));
		await screen.findByText(/Unreal returned a different asset/u);
		expect(screen.queryByText(/Shown in Unreal/u)).toBeNull();
	});
});
