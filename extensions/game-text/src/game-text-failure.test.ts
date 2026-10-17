import { Cause } from "effect";
import { expect, it } from "vitest";
import { GameTextClientError } from "./game-text-client.js";
import { failureText } from "./game-text-failure.js";

it("preserves domain recovery from the Cause supplied by Effect actions", () => {
	const error = new GameTextClientError({
		message: "The GameTextClient operation failed.",
		retrySafe: false,
		nextStep: "reconcile",
		code: "game_text_client_failed",
		operation: "search",
		cause: "The saved text index is unavailable.",
		recovery: "Rescan the project to rebuild its saved text index."
	});
	const expected = "Search failed. Rescan the project to rebuild its saved text index.";
	expect(failureText("Search failed.", Cause.fail(error))).toBe(expected);
	expect(failureText("Search failed.", error)).toBe(expected);
});

it("keeps generic recovery for defects and unexpected failures", () => {
	for (const cause of [Cause.die(new Error("Unexpected")), Cause.fail("Unknown"), undefined])
		expect(failureText("Search failed.", cause)).toBe(
			"Search failed. Try again. If it keeps failing, restart Workbench."
		);
});
