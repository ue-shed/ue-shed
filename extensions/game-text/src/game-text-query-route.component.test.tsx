import { screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Deferred, Effect } from "effect";
import { expect, it, vi } from "vitest";
import { GameTextClientError } from "./game-text-client.js";
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
		base.search(request).pipe(
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

it.each([false, true])(
	"4506954256 rules retry clears its own failure (reload=%s)",
	async (reload) => {
		const base = makeClient();
		let attempts = 0;
		const operation = Effect.suspend(() =>
			++attempts === 1
				? Effect.fail(
						new GameTextClientError({
							code: "game_text_client_failed",
							operation: "rules",
							message: "Rules unavailable",
							recovery: "Retry",
							retrySafe: true,
							nextStep: "retry",
							cause: new Error("Rules unavailable")
						})
					)
				: base.chooseQualityRules
		);
		mount({
			...base,
			...(reload ? { reloadQualityRules: operation } : { chooseQualityRules: operation })
		});
		const user = userEvent.setup({ delay: null });
		if (reload) {
			await openQuality(user);
			await user.click(screen.getByRole("button", { name: "Edit rules" }));
			await user.click(screen.getByRole("button", { name: "Reload rules" }));
		} else {
			await user.click(await screen.findByRole("tab", { name: /Quality checks/u }));
			await user.click(screen.getByRole("button", { name: "Choose a rules file…" }));
		}
		await screen.findByText(/Couldn’t (open|reload) the rules file/u);
		await user.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(attempts).toBe(2));
		await waitFor(() =>
			expect(screen.queryByText(/Couldn’t (open|reload) the rules file/u)).toBeNull()
		);
	}
);

it("4506934654 replacement rules own the route after an old Save completes", async () => {
	const base = makeClient();
	const release = await Effect.runPromise(Deferred.make<void>());
	const replacement = {
		...rulesDocument,
		rules: rulesDocument.rules.map((rule) =>
			rule.kind === "character_budget" ? { ...rule, maximumCharacters: 9 } : rule
		)
	};
	let choices = 0;
	const preview = vi.fn(base.previewQualityRules);
	mount(
		{
			...base,
			previewQualityRules: preview,
			saveQualityRules: (doc) =>
				Deferred.await(release).pipe(Effect.andThen(base.saveQualityRules(doc))),
			chooseQualityRules: Effect.suspend(() =>
				++choices === 1 ? base.chooseQualityRules : base.previewQualityRules(replacement)
			)
		},
		undefined,
		"review-rules"
	);
	const user = userEvent.setup({ delay: null });
	await openQuality(user);
	await user.click(screen.getByRole("button", { name: "Edit rules" }));
	const limit = screen.getByRole("spinbutton", { name: "Maximum characters for example-limit" });
	await user.clear(limit);
	await user.type(limit, "12");
	await user.click(screen.getByRole("button", { name: "Save" }));
	await user.click(screen.getByRole("button", { name: "Choose another rules file…" }));
	await user.click(await screen.findByRole("button", { name: "Discard and continue" }));
	await waitFor(() => expect(preview.mock.calls.at(-1)?.[0]).toEqual(replacement));
	await Effect.runPromise(Deferred.succeed(release, undefined));
	await waitFor(() =>
		expect(
			JSON.parse(localStorage.getItem("ue-shed:game-text:review-rules") ?? "{}")
		).toMatchObject({ qualityDocument: replacement })
	);
	expect(
		screen.getByRole("spinbutton", { name: "Maximum characters for example-limit" })
	).toHaveProperty("value", "9");
	expect(preview.mock.calls.at(-1)?.[0]).toEqual(replacement);
});

it("rules recovery preserves a newer rescan failure", async () => {
	const base = makeClient();
	let scans = 0;
	let choices = 0;
	const release = await Effect.runPromise(Deferred.make<void>());
	mount({
		...base,
		loadConfiguredProject: () =>
			++scans === 1
				? base.loadConfiguredProject()
				: Effect.succeed({
						status: "failed",
						error: {
							code: "index_failed",
							message: "New scan failure",
							recovery: "Retry scan",
							retrySafe: true
						}
					}),
		chooseQualityRules: Effect.suspend(() =>
			++choices === 1
				? Effect.fail(
						new GameTextClientError({
							code: "game_text_client_failed",
							operation: "rules",
							message: "Unavailable",
							recovery: "Retry",
							retrySafe: true,
							nextStep: "retry",
							cause: new Error("Unavailable")
						})
					)
				: Deferred.await(release).pipe(Effect.andThen(base.chooseQualityRules))
		)
	});
	const user = userEvent.setup({ delay: null });
	await user.click(await screen.findByRole("tab", { name: /Quality checks/u }));
	await user.click(screen.getByRole("button", { name: "Choose a rules file…" }));
	await screen.findByText(/Couldn’t open the rules file/u);
	await user.click(screen.getByRole("button", { name: "Retry" }));
	await user.click(screen.getByRole("button", { name: "Rescan" }));
	await screen.findByText("New scan failure Retry scan");
	await Effect.runPromise(Deferred.succeed(release, undefined));
	await screen.findByRole("button", { name: "Edit rules" });
	expect(screen.getByText("New scan failure Retry scan")).toBeDefined();
});
