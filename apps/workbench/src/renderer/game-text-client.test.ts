// @vitest-environment jsdom
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import type { GameTextClientError } from "../../../../extensions/game-text/src/game-text-client.js";
import { gameTextClient } from "./game-text-client.js";

afterEach(() => vi.unstubAllGlobals());

it("executes every reusable parameterless operation against the host again", async () => {
	const current = vi.fn(async () => ({ status: "not_configured" }));
	const chooseQualityRules = vi.fn(async () => ({ status: "cancelled" }));
	const reloadQualityRules = vi.fn(async () => ({ status: "cancelled" }));
	const localizationTargets = vi.fn(async () => ({ status: "ready", targets: [] }));
	const investigationOpen = vi.fn(async () => ({ status: "cancelled" }));
	vi.stubGlobal("window", {
		ueShed: {
			project: { current },
			gameText: {
				chooseQualityRules,
				reloadQualityRules,
				localizationTargets,
				investigationOpen
			}
		}
	});
	const operations: Array<Effect.Effect<unknown, GameTextClientError> | undefined> = [
		gameTextClient.projectKey,
		gameTextClient.chooseQualityRules,
		gameTextClient.reloadQualityRules,
		gameTextClient.localizationTargets,
		gameTextClient.investigations?.open
	];
	for (const operation of operations) {
		if (operation === undefined) throw new Error("The Workbench client omitted an operation.");
		await Effect.runPromise(operation);
		await Effect.runPromise(operation);
	}
	for (const invoke of [
		current,
		chooseQualityRules,
		reloadQualityRules,
		localizationTargets,
		investigationOpen
	])
		expect(invoke).toHaveBeenCalledTimes(2);
});
