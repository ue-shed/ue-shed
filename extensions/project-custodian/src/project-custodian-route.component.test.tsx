import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import {
	CustodianProposalId,
	CustodianTargetId,
	type CustodianReport
} from "@ue-shed/project-custodian/browser";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { CustodianClientShape } from "./custodian-client.js";
import { ProjectCustodianRoute } from "./project-custodian-route.js";

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

const sampleTarget = {
	id: CustodianTargetId.make("target-intermediate"),
	key: "intermediate" as const,
	path: "C:\\Projects\\Lyra\\Intermediate",
	relativePath: "Intermediate",
	bytes: 2 * 1024 ** 3,
	description: "Build intermediates and compiled shaders",
	rebuildCost: "Full project rebuild and shader recompile",
	risk: "medium" as const
};

const sampleReport: CustodianReport = {
	schemaVersion: 2,
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
	destructiveOperationsAvailable: true
};

function inactiveCleanupClient(): Pick<CustodianClientShape, "prepare" | "execute" | "cancel"> {
	return {
		prepare: () =>
			Effect.succeed({
				status: "failed",
				error: {
					code: "prepare_failed",
					message: "not used",
					recovery: "not used",
					retrySafe: false
				}
			}),
		execute: () =>
			Effect.succeed({
				status: "failed",
				error: {
					code: "execution_failed",
					message: "not used",
					recovery: "not used",
					retrySafe: false
				}
			}),
		cancel: (proposalId) =>
			Effect.succeed({
				status: "completed",
				result: { proposalId, status: "not_running" }
			})
	};
}

describe("ProjectCustodianRoute", () => {
	it("keeps an unconfigured host read-only and requests an explicit root", async () => {
		let choices = 0;
		const client: CustodianClientShape = {
			...inactiveCleanupClient(),
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
		expect(screen.getByText("GUARDED CLEANUP")).toBeDefined();
		expect(screen.queryByRole("button", { name: /delete|clean|apply/iu })).toBeNull();

		fireEvent.click(screen.getAllByRole("button", { name: "Choose scan root…" })[0]!);
		await waitFor(() => expect(choices).toBe(1));
	});

	it("shows measured inventory and exposes guarded cleanup review", async () => {
		const client: CustodianClientShape = {
			...inactiveCleanupClient(),
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
		expect(screen.getByText("AVAILABLE")).toBeDefined();
		expect(screen.getByRole("button", { name: "Review cleanup…" })).toBeDefined();
	});

	it("requires a durable proposal and exact approval before cleanup", async () => {
		const proposalId = CustodianProposalId.make("proposal-fixture");
		const proposal = {
			schemaVersion: 1 as const,
			id: proposalId,
			createdAt: "2026-08-17T00:00:00.000Z",
			root: sampleReport.root,
			ignorePressure: false,
			mode: "trash" as const,
			proposalPath: "C:\\Records\\proposal-fixture.proposal.json",
			receiptPath: "C:\\Records\\proposal-fixture.receipt.json",
			logPath: "C:\\Records\\proposal-fixture.events.jsonl",
			approvalPhrase: "RECLAIM proposal-fixture",
			bytes: sampleTarget.bytes,
			targets: [
				{
					kind: "project" as const,
					name: "Lyra",
					root: "C:\\Projects\\Lyra",
					target: sampleTarget
				}
			]
		};
		let prepared = 0;
		let executed = 0;
		const client: CustodianClientShape = {
			configuredScan: () => Effect.succeed({ status: "completed", report: sampleReport }),
			chooseAndScan: () => Effect.succeed({ status: "cancelled" }),
			prepare: () => {
				prepared += 1;
				return Effect.succeed({ status: "completed", proposal });
			},
			execute: () => {
				executed += 1;
				return Effect.succeed({
					status: "completed",
					receipt: {
						schemaVersion: 1,
						proposalId,
						proposalPath: proposal.proposalPath,
						receiptPath: proposal.receiptPath,
						logPath: proposal.logPath,
						root: proposal.root,
						mode: proposal.mode,
						startedAt: "2026-08-17T00:01:00.000Z",
						finishedAt: "2026-08-17T00:01:01.000Z",
						status: "completed",
						plannedBytes: proposal.bytes,
						processedBytes: proposal.bytes,
						entries: [
							{
								targetId: sampleTarget.id,
								path: sampleTarget.path,
								relativePath: sampleTarget.relativePath,
								bytes: sampleTarget.bytes,
								status: "trashed"
							}
						]
					}
				});
			},
			cancel: (id) =>
				Effect.succeed({
					status: "completed",
					result: { proposalId: id, status: "not_running" }
				})
		};

		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ProjectCustodianRoute client={client} />
			</EffectRuntimeProvider>
		));
		await screen.findByRole("button", { name: "Review cleanup…" });
		fireEvent.click(screen.getByRole("button", { name: "Review cleanup…" }));
		await screen.findByRole("dialog", { name: "Review cleanup" });
		fireEvent.click(screen.getByRole("button", { name: "CREATE PROPOSAL →" }));
		await waitFor(() => expect(prepared).toBe(1));
		await screen.findByRole("region", { name: "Approve cleanup proposal" });
		const executeButton = screen.getByRole("button", { name: "MOVE TO TRASH" });
		expect(executeButton).toHaveProperty("disabled", true);
		fireEvent.input(screen.getByRole("textbox"), {
			target: { value: proposal.approvalPhrase }
		});
		expect(executeButton).toHaveProperty("disabled", false);
		fireEvent.click(executeButton);
		await waitFor(() => expect(executed).toBe(1));
		await screen.findByRole("region", { name: "Cleanup result" });
		expect(screen.getByText("Cleanup finished with durable evidence.")).toBeDefined();
	});
});
