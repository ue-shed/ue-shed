import { render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect } from "effect";
import { expect, it } from "vitest";
import { client, summary, joined, runtime } from "./game-text-localization.test-support.js";
import { createGameTextLocalizationState } from "./game-text-localization-state.js";
import { GameTextClientError, type GameTextClientApi } from "./game-text-client.js";
function mountState(api: GameTextClientApi) {
	function State() {
		const state = createGameTextLocalizationState({
			client: api,
			initial: undefined,
			summary: () => summary,
			selectedUnit: () => undefined,
			onPending: () => undefined
		});
		return (
			<>
				<button onClick={state.load}>Load</button>
				<button onClick={() => state.selectTarget(joined.target)}>Select</button>
				<button onClick={() => state.setSelectedId(joined.lines[0]!.id)}>First</button>
				<button onClick={() => state.setSelectedId(joined.lines[1]!.id)}>Second</button>
				<span>{state.ready() ? "Ready" : "Loading"}</span>
				<span>{state.error() ?? "No target error"}</span>
				<span>{state.targets().length} targets</span>
				<span>{state.detail()?.id}</span>
			</>
		);
	}
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<State />
		</EffectRuntimeProvider>
	));
}
it("U5.1 keeps detail failure out of the target error and recovers on another line", async () => {
	const base = client();
	let reads = 0;
	mountState({
		...base,
		localizationFocus: (request) =>
			++reads === 1
				? Effect.fail(
						new GameTextClientError({
							code: "game_text_client_failed",
							operation: "localizationFocus",
							message: "Detail failed",
							cause: new Error("Detail failed"),
							recovery: "Retry",
							retrySafe: true,
							nextStep: "retry"
						})
					)
				: base.localizationFocus!(request)
	});
	const user = userEvent.setup({ delay: null });
	await user.click(screen.getByRole("button", { name: "Load" }));
	await screen.findByText("Ready");
	await user.click(screen.getByRole("button", { name: "First" }));
	await waitFor(() => expect(reads).toBe(1));
	await user.click(screen.getByRole("button", { name: "Second" }));
	await screen.findByText(joined.lines[1]!.id);
	expect(screen.getByText("No target error")).toBeDefined();
});
it("U5.2 keeps a fresh target inventory while selection changes", async () => {
	const pending = await Effect.runPromise(Deferred.make<void>());
	const base = client({ twoTargets: true });
	let lists = 0;
	mountState({
		...base,
		localizationTargets: Effect.suspend(() =>
			++lists === 1
				? client().localizationTargets!
				: Deferred.await(pending).pipe(Effect.andThen(base.localizationTargets!))
		)
	});
	const user = userEvent.setup({ delay: null });
	await user.click(screen.getByRole("button", { name: "Load" }));
	await screen.findByText("1 targets");
	await user.click(screen.getByRole("button", { name: "Load" }));
	await user.click(screen.getByRole("button", { name: "Select" }));
	await Effect.runPromise(Deferred.succeed(pending, undefined));
	await screen.findByText("2 targets");
});
