import { screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { expect, it, vi } from "vitest";
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

it("U2.1 cancels pending-findings retries when the route unmounts", async () => {
	const base = makeClient();
	const search = vi.fn((request: Parameters<typeof base.search>[0]) =>
		base
			.search(request)
			.pipe(
				Effect.map((result) =>
					result.status === "ready"
						? {
								...result,
								page: { ...result.page, findings: { status: "pending" as const } }
							}
						: result
				)
			)
	);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const route = mount({ ...base, search });
		await vi.waitFor(() => expect(screen.getByText("2 matches")).toBeDefined());
		route.unmount();
		const before = search.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2100);
		expect(search).toHaveBeenCalledTimes(before);
	} finally {
		vi.useRealTimers();
	}
});
it("U2.2 retains a failed rescan alert after a successful search", async () => {
	const base = makeClient();
	let scans = 0;
	mount({
		...base,
		loadConfiguredProject: () =>
			++scans === 1
				? base.loadConfiguredProject()
				: Effect.succeed({
						status: "failed",
						error: {
							code: "index_failed",
							message: "Rescan failed",
							recovery: "Retry scan",
							retrySafe: true
						}
					})
	});
	const user = userEvent.setup({ delay: null });
	await screen.findByText("2 matches");
	await user.click(screen.getByRole("button", { name: "Rescan" }));
	await screen.findByText("Rescan failed Retry scan");
	fireEvent.input(screen.getByRole("searchbox", { name: "Search game text" }), {
		target: { value: "Continue" }
	});
	await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
	expect(screen.getByText("Rescan failed Retry scan")).toBeDefined();
});
