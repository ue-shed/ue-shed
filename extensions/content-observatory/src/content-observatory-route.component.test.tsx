// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type {
	ContentObservatoryClientShape,
	ContentObservatoryHistoryRequest
} from "./content-observatory-client.js";
import { ContentObservatoryState } from "./content-observatory-client.js";
import { ContentObservatoryRoute } from "./content-observatory-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

describe("ContentObservatoryRoute", () => {
	it("explains the project prerequisite without exposing filesystem authority", async () => {
		const client: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed({ status: "not_configured" as const }),
			start: () => Effect.succeed({ status: "not_configured" as const }),
			status: () => Effect.succeed({ status: "not_configured" as const })
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={client} />
			</EffectRuntimeProvider>
		));
		expect(await screen.findByText("Content Observatory has no project root.")).toBeDefined();
		expect(screen.getByText("UE_SHED_PROJECT_ROOT")).toBeDefined();
	});

	it("starts a bounded map query from the selected configured map", async () => {
		let received: ContentObservatoryHistoryRequest | undefined;
		const maps = [
			{
				label: "Map History World",
				mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap"
			}
		];
		const ready = Schema.decodeUnknownSync(ContentObservatoryState)({
			maps,
			projectRoot: "C:/Project",
			status: "ready" as const
		});
		const running = Schema.decodeUnknownSync(ContentObservatoryState)({
			jobId: "map-history-1",
			maps,
			progress: {
				phase: "listing_changes" as const,
				processedChangelists: 0,
				totalChangelists: 0
			},
			projectRoot: "C:/Project",
			request: {
				limits: {
					maxChangelists: 250,
					maxConcurrency: 4,
					maxDurationMs: 120000,
					maxMaterializedFiles: 4000,
					maxPackages: 4000
				},
				mapPath: "Content/Fixture/History/L_MapHistoryWorld.umap",
				range: { since: "2026-07-20T00:00:00.000Z", until: "2026-07-27T00:00:00.000Z" }
			},
			status: "running" as const
		});
		const client: ContentObservatoryClientShape = {
			cancel: () => Effect.succeed(running),
			start: (request) =>
				Effect.sync(() => {
					received = request;
					return running;
				}),
			status: () => Effect.succeed(ready)
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ContentObservatoryRoute client={client} />
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await screen.findByDisplayValue("Content/Fixture/History/L_MapHistoryWorld.umap");
		await user.click(screen.getByRole("button", { name: /read history/i }));
		expect(received?.mapPath).toBe("Content/Fixture/History/L_MapHistoryWorld.umap");
		expect(received?.limits.maxChangelists).toBe(250);
		expect(await screen.findByText("listing changes")).toBeDefined();
	});
});
