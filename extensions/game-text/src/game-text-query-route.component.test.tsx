import { screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { expect, it } from "vitest";
import { makeClient, mount, openQuality, rulesDocument } from "./game-text-route.test-support.js";

it("U1.1 reconciles a chooser that finishes after a rescan preview", async () => {
	const pending = await Effect.runPromise(Deferred.make<void>());
	const chosen = {
		...rulesDocument,
		rules: rulesDocument.rules.map((rule) =>
			rule.kind === "character_budget" ? { ...rule, maximumCharacters: 9 } : rule
		)
	};
	const base = makeClient();
	let choices = 0;
	const client = {
		...base,
		loadConfiguredProject: () =>
			base
				.loadConfiguredProject()
				.pipe(
					Effect.map((result) =>
						result.status === "completed"
							? { ...result, summary: { ...result.summary } }
							: result
					)
				),
		chooseQualityRules: Effect.suspend(() => {
			if (++choices === 1) return base.chooseQualityRules;
			return Deferred.await(pending).pipe(
				Effect.andThen(base.previewQualityRules(chosen)),
				Effect.uninterruptible
			);
		})
	};
	mount(client);
	const user = userEvent.setup({ delay: null });
	await openQuality(user);
	await user.click(screen.getByRole("button", { name: "Edit rules" }));
	await user.click(screen.getByRole("button", { name: "Choose another rules file…" }));
	await user.click(screen.getByRole("button", { name: "Rescan" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty("disabled", false)
	);
	await Effect.runPromise(Deferred.succeed(pending, undefined));
	await waitFor(() =>
		expect(
			screen.getByRole("spinbutton", { name: "Maximum characters for example-limit" })
		).toHaveProperty("value", "9")
	);
});
