import { render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect } from "effect";
import { expect, it, vi } from "vitest";
import { makeClient, rulesDocument, runtime } from "./game-text-route.test-support.js";
import { GameTextClientError } from "./game-text-client.js";
import { createGameTextRuleState } from "./game-text-rule-state.js";
it.each([
	{ replacement: "replace", fail: false },
	{ replacement: "restore", fail: false },
	{ replacement: "replace", fail: true },
	{ replacement: "restore", fail: true }
] as const)(
	"U1.4 defers $replacement until a pending save reconciles (failed=$fail)",
	async ({ replacement, fail }) => {
		const pending = await Effect.runPromise(Deferred.make<void>());
		const onReviewed = vi.fn();
		const base = makeClient();
		const other = { ...rulesDocument, rules: [] };
		function Editor() {
			const editor = createGameTextRuleState({
				client: {
					...base,
					saveQualityRules: (doc) =>
						Deferred.await(pending).pipe(
							Effect.andThen(
								fail
									? Effect.fail(
											new GameTextClientError({
												code: "game_text_client_failed",
												operation: "save",
												message: "Save failed",
												recovery: "Retry",
												retrySafe: true,
												nextStep: "retry",
												cause: new Error("Save failed")
											})
										)
									: base.saveQualityRules(doc)
							)
						)
				},
				initialState: { draft: rulesDocument },
				onReviewed
			});
			return (
				<>
					<button onClick={() => editor.run("save")}>Save</button>
					<button
						onClick={() =>
							replacement === "replace"
								? editor.replace(other)
								: editor.restore({ draft: other })
						}
					>
						Replace
					</button>
					<span>{editor.feedback().status} feedback</span>
					<span>{editor.busy() ? "Saving" : "Idle"}</span>
					<span>{editor.state()?.draft.rules.length} rules</span>
				</>
			);
		}
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<Editor />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup({ delay: null });
		await user.click(screen.getByRole("button", { name: "Save" }));
		await user.click(screen.getByRole("button", { name: "Replace" }));
		expect(screen.getByText("Saving")).toBeDefined();
		await Effect.runPromise(Deferred.succeed(pending, undefined));
		await waitFor(() => expect(screen.getByText("Idle")).toBeDefined());
		expect(onReviewed).not.toHaveBeenCalled();
		expect(screen.getByText("idle feedback")).toBeDefined();
		expect(screen.getByText("0 rules")).toBeDefined();
		expect(screen.getByText("Idle")).toBeDefined();
	}
);
