import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import type { CustodianReport } from "@ue-shed/project-custodian/browser";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { CustodianClientShape } from "./custodian-client.js";
import { ProjectCustodianRoute } from "./project-custodian-route.js";

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

const sampleTarget = {
	key: "intermediate" as const,
	path: "C:\\Projects\\Lyra\\Intermediate",
	relativePath: "Intermediate",
	bytes: 2 * 1024 ** 3,
	description: "Build intermediates and compiled shaders",
	rebuildCost: "Full project rebuild and shader recompile",
	risk: "medium" as const
};

const sampleReport: CustodianReport = {
	schemaVersion: 1,
	root: "C:\\Projects",
	measuredAt: "2026-08-16T00:00:00.000Z",
	freeBytes: 30 * 1024 ** 3,
	totalReclaimableBytes: sampleTarget.bytes,
	projects: [
		{
			kind: "project",
			name: "Lyra",
			root: "C:\\Projects\\Lyra",
			descriptor: "C:\\Projects\\Lyra\\Lyra.uproject",
			engineAssociation: "5.7",
			isCpp: true,
			policy: {
				enabled: true,
				minAgeDays: 14,
				minFreeGb: 100,
				keepBinariesForCpp: true,
				targets: ["intermediate"],
				source: "default"
			},
			freshness: {
				authoredAt: "2026-07-01T00:00:00.000Z",
				effectiveAt: "2026-07-01T00:00:00.000Z",
				ageDays: 46,
				mtimesLookRewritten: false
			},
			eligibility: { kind: "candidate" },
			targets: [sampleTarget],
			refusals: [],
			diagnostics: [],
			reclaimableBytes: sampleTarget.bytes
		}
	],
	engines: [],
	diagnostics: [],
	plan: {
		status: "ready",
		freeBytes: 30 * 1024 ** 3,
		thresholdBytes: 100 * 1024 ** 3,
		projectedFreeBytes: 32 * 1024 ** 3,
		reclaimableBytes: sampleTarget.bytes,
		items: [
			{
				kind: "project",
				name: "Lyra",
				root: "C:\\Projects\\Lyra",
				bytes: sampleTarget.bytes,
				targets: [sampleTarget]
			}
		]
	},
	destructiveOperationsAvailable: false
};

describe("ProjectCustodianRoute", () => {
	it("keeps an unconfigured host read-only and requests an explicit root", async () => {
		let choices = 0;
		const client: CustodianClientShape = {
			configuredScan: () => Effect.succeed({ status: "not_configured" }),
			chooseAndScan: () => {
				choices += 1;
				return Effect.succeed({ status: "cancelled" });
			}
		};

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ProjectCustodianRoute client={client} />
			</EffectRuntimeProvider>
		));
		await screen.findByRole("heading", { name: "Name the ground to inspect." });
		expect(screen.getByText("READ ONLY")).toBeDefined();
		expect(screen.queryByRole("button", { name: /delete|clean|apply/iu })).toBeNull();

		fireEvent.click(screen.getAllByRole("button", { name: "Choose scan root…" })[0]!);
		await waitFor(() => expect(choices).toBe(1));
	});

	it("shows measured inventory and a dry-run queue without execution authority", async () => {
		const client: CustodianClientShape = {
			configuredScan: () => Effect.succeed({ status: "completed", report: sampleReport }),
			chooseAndScan: () => Effect.succeed({ status: "cancelled" })
		};

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ProjectCustodianRoute client={client} />
			</EffectRuntimeProvider>
		));

		await screen.findByRole("region", { name: "Storage summary" });
		expect(screen.getAllByText("Lyra")).toHaveLength(2);
		expect(screen.getByText("NOT AVAILABLE")).toBeDefined();
		expect(screen.queryByRole("button", { name: /delete|clean|apply/iu })).toBeNull();
	});
});
