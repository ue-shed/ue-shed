// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { TextureAuditClientShape } from "./texture-audit-client.js";
import { TextureAuditRoute } from "./texture-audit-query-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

describe("TextureAuditRoute", () => {
	it("uses the globally selected project and exposes no second chooser", async () => {
		let rescans = 0;
		const client: TextureAuditClientShape = {
			chooseProjectAndScan: () =>
				Effect.die("the route must use the Workbench header for project choice"),
			record: () => Effect.die("unused"),
			search: () => Effect.die("unused"),
			launchUnreal: () => Effect.die("unused"),
			loadConfiguredProject: () =>
				Effect.sync(() => {
					rescans += 1;
					return { status: "not_configured" as const };
				}),
			loadPreview: () => Effect.die("unused"),
			progress: () =>
				Effect.succeed({
					completed: 0,
					phase: "idle",
					stage: "texture_audit",
					total: 0
				})
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<TextureAuditRoute client={client} />
			</EffectRuntimeProvider>
		));
		expect(await screen.findByText("No project configured.")).toBeDefined();
		expect(screen.queryByRole("button", { name: "Choose project" })).toBeNull();
		await userEvent.setup().click(screen.getByRole("button", { name: "Rescan" }));
		expect(rescans).toBe(2);
	});
});
