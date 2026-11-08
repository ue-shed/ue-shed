import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	type LocalizationReviewRequest,
	type LocalizationReviewResult
} from "@ue-shed/game-text/corpus";
import { LocalizationLinePreview, LocalizationSelection } from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { BulkBar, createLineSelection } from "./game-text-bulk-bar.js";
import { createGameTextEdits } from "./game-text-translation-edits.js";
const decodeLocalizationLinePreview = Schema.decodeSync(LocalizationLinePreview);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
afterEach(cleanup);

it("U4.2 resets written reviews on a target change while retaining partial failure context", async () => {
	const pending = await Effect.runPromise(Deferred.make<LocalizationReviewResult>());
	const requests: LocalizationReviewRequest[] = [];
	const changed = vi.fn();
	const localization = LocalizationSelection.make({
		target: LocalizationSelection.fields.target.make("Game")
	});
	const lines = Array.from({ length: 501 }, (_, index) =>
		decodeLocalizationLinePreview({
			id: `line:${index}`,
			identity: { namespace: "UI", key: `K${index}` },
			source: `Line ${index}`,
			origin: { kind: "corpus", unitIds: [] },
			manifestLocations: [],
			remainingLocationCount: 0,
			cultures: [
				{
					culture: "fr",
					state: "translated",
					facts: ["translated"],
					unknownReasons: [],
					reducedSourceChecking: false,
					translation: `Translation ${index}`
				}
			]
		})
	);
	function Review() {
		const [context, setContext] = createSignal(localization);
		const selection = createLineSelection({ order: () => lines });
		const edits = createGameTextEdits({
			client: {},
			target: () => context().target,
			nativeCulture: () => "en",
			busy: () => false,
			onWritten: () => undefined
		});
		return (
			<>
				<button
					onClick={() =>
						setContext({
							...localization,
							target: LocalizationSelection.fields.target.make("Other")
						})
					}
				>
					Switch target
				</button>
				<button
					onClick={() => {
						const line = lines[0];
						if (line) selection.toggle(line, false);
					}}
				>
					Select first
				</button>
				<button
					onClick={() => {
						const line = lines.at(-1);
						if (line) selection.toggle(line, true);
					}}
				>
					Select range
				</button>
				<BulkBar
					selection={selection}
					client={{
						localizationReview: (request) => {
							requests.push(request);
							return requests.length === 1
								? Effect.succeed({
										status: "written",
										relativePath: "Config/Review.json"
									})
								: Deferred.await(pending);
						}
					}}
					localization={context()}
					cultures={[]}
					nativeCulture="en"
					edits={edits}
					busy={false}
					onChanged={changed}
				/>
			</>
		);
	}
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<Review />
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "Select first" }));
	await user.click(screen.getByRole("button", { name: "Select range" }));
	await user.click(screen.getByRole("button", { name: "Mark reviewed (501)" }));
	expect(requests).toHaveLength(0);
	await user.click(screen.getByRole("button", { name: "Confirm review" }));
	await screen.findByText("Marking reviewed: 500 of 501");
	expect(requests.map((request) => request.changes.length)).toEqual([500, 1]);
	await Effect.runPromise(
		Deferred.succeed(pending, {
			status: "failed",
			code: "unwritable",
			message: "The remaining review file could not be written.",
			recovery: "Make the file writable and retry the remaining translation."
		})
	);
	// A partial failure is announced as an alert and keeps what was done.
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain(
			"Marked 500 translations reviewed. The remaining review file could not be written."
		)
	);
	expect(screen.getByRole("alert").getAttribute("title")).toContain(
		"retry the remaining translation"
	);
	expect(changed).toHaveBeenCalledOnce();
	expect(screen.getByRole("button", { name: "Mark reviewed (1)" })).toBeDefined();
	await user.click(screen.getByRole("button", { name: "Switch target" }));
	await screen.findByRole("button", { name: "Mark reviewed (501)" });
});
