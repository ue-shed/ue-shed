import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, Metric, Schema, Tracer } from "effect";
import { expect, vi } from "vitest";
import { MessagePort, Worker } from "node:worker_threads";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import type { LocalizationQuality } from "./localization-workspace.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";
import { TextQualityFindingId } from "./quality-query.js";
import { GameTextRuleDocument } from "./game-text-rules.js";
import {
	QualityWorkerCall,
	QualityWorkerReply,
	qualityWorkerFailure
} from "./quality-worker-protocol.js";

const occurrence = (key: string, source: string) => ({
	source,
	dev_notes: "",
	identity: { status: "resolved" as const, namespace: "UI", key },
	location: {
		kind: "asset_property" as const,
		object_path: "/Game/Text/Table.Table",
		class_path: "/Script/Engine.DataAsset",
		property_path: `Label${key}`
	},
	edit_capability: "read_only" as const
});

/** Everything a workspace can read from a scan, read the same way from either side. */
const readAll = Effect.fn("Test.GameText.readAllQuality")(function* (quality: LocalizationQuality) {
	const { findings, metadata } = quality;
	const positions = Array.from({ length: findings.length }, (_, position) => position);
	const items = yield* findings.items(positions);
	const cultures = [undefined, ...metadata.join.cultures];
	return {
		length: findings.length,
		groups: findings.groups?.map((group) => ({ ...group, positions: [...group.positions] })),
		facts: positions.map((position) => [
			findings.culture(position),
			findings.filter(position),
			findings.severity(position),
			findings.ruleId(position),
			findings.eligible(position),
			findings.reportedBySource(position)
		]),
		items,
		found: items.map((item) => findings.find(item.summary.id, item.summary.culture)),
		missing: findings.find(
			TextQualityFindingId.make("localization-finding:0000000000000000"),
			undefined
		),
		limits: cultures.map((culture) => findings.limits(culture)),
		join: metadata.join,
		rules: metadata.rules,
		customChecks: metadata.customChecks,
		status: metadata.status,
		coverage: metadata.coverage,
		unsupportedRuleCultures: metadata.unsupportedRuleCultures
	};
});

it.live(
	"scans in the quality worker with the same findings, items and lookups as the host",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			fixture.update(
				["K", "A", "B"].map((key) => occurrence(key, ` Source {Name} ${key}  `))
			);
			const rules = Schema.decodeUnknownSync(GameTextRuleDocument)({
				schemaVersion: 3,
				roles: [],
				rules: [],
				checks: { missing_translator_notes: { severity: "low" } },
				customChecks: [
					{
						id: "custom-source",
						label: "Source marker",
						subject: "source",
						kind: "pattern",
						pattern: "Source",
						severity: "blocking",
						recovery: "Review source."
					}
				]
			});
			const scan = (qualityWorker: boolean) =>
				Effect.gen(function* () {
					const refresh = yield* GameTextIndexRefresh;
					const result = yield* refresh.refresh(fixture.request);
					const progress: GameTextIndexProgress[] = [];
					const quality = yield* result
						.localizationQuality(rules, { review: result.review.file })
						.pipe(
							Effect.provideService(GameTextIndexProgressReporter, (event) =>
								progress.push(event)
							)
						);
					const unit = (yield* result.query.search({
						query: "",
						capability: "all",
						pageSize: 1
					})).units[0]!;
					return {
						read: yield* readAll(quality),
						line: quality.metadata.lineOfUnit(unit.id),
						sourceKey: quality.metadata.sourceKeyOfUnit?.(unit.id),
						lastProgress: progress.at(-1),
						firstProgress: progress[0]
					};
				}).pipe(
					Effect.scoped,
					Effect.provide(fixture.layer(false, fixture.source, qualityWorker))
				);
			const completed = Metric.counter("game_text.index.worker_quality_scans_completed");
			const before = (yield* Metric.value(completed)).count;
			const host = yield* scan(false);
			expect((yield* Metric.value(completed)).count).toBe(before);
			const traced: Map<string, unknown>[] = [];
			class Recording extends Tracer.NativeSpan {
				override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
					super.end(endTime, exit);
					if (this.name === "GameTextIndex.qualityWorker.scan")
						traced.push(this.attributes);
				}
			}
			const worker = yield* scan(true).pipe(
				Effect.withTracer(Tracer.make({ span: (options) => new Recording(options) }))
			);
			// The worker really ran the scan, rather than falling back to the host.
			expect((yield* Metric.value(completed)).count).toBe(before + 1);
			// Its own spans and stages reach the host's trace.
			expect(
				traced[0]?.get("game_text.quality.worker.span_ms.GameText.localizationQuality")
			).toBeGreaterThan(0);
			expect(
				[...(traced[0]?.keys() ?? [])].some((key) =>
					key.startsWith("game_text.quality.stage_ms.")
				)
			).toBe(true);
			expect(host.read.length).toBeGreaterThan(0);
			expect(host.read.customChecks).toEqual([
				{ ruleId: "custom-source", label: "Source marker" }
			]);
			expect(
				host.read.items.some(
					({ finding }) => finding.kind === "custom" && finding.severity === "blocking"
				)
			).toBe(true);
			expect(host.line).toBeDefined();
			expect(host.lastProgress?.completed).toBe(host.lastProgress?.total);
			expect(host.lastProgress?.phase).toBe("localization_quality");
			expect(worker).toEqual(host);
		}),
	30_000
);

for (const mode of ["interrupt", "failure"] as const)
	it.live(
		`closes a quality worker candidate after readiness ${mode} before retry`,
		() => {
			let register: (worker: Worker) => void = () => {};
			const registered = new Promise<Worker>((resolve) => {
				register = resolve;
			});
			const workers = new Set<Worker>();
			const on = Worker.prototype.on;
			const messages = vi
				.spyOn(Worker.prototype, "on")
				.mockImplementation(function (this: Worker, event, listener) {
					if (event !== "message") return on.call(this, event, listener);
					return on.call(this, event, (raw: typeof QualityWorkerReply.Encoded) => {
						const decoded = Schema.decodeUnknownExit(QualityWorkerReply)(raw);
						if (Exit.isFailure(decoded) || decoded.value.kind !== "ready")
							return listener(raw);
						workers.add(this);
						if (workers.size !== 1) return listener(raw);
						register(this);
						if (mode === "interrupt") return; // Hold a launched, pinned worker before ready.
						listener(
							Schema.encodeSync(QualityWorkerReply)({
								kind: "failed",
								error: qualityWorkerFailure(
									"quality.worker.open",
									"Injected readiness failure"
								)
							})
						);
					});
				});
			return Effect.gen(function* () {
				const fixture = yield* makeIndexRegressionFixture();
				yield* Effect.gen(function* () {
					const model = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
					const scan = yield* Effect.forkChild(model.localizationQuality());
					const abandoned = yield* Effect.promise(() => registered);
					if (mode === "interrupt") yield* Fiber.interrupt(scan);
					else
						expect(yield* Fiber.join(scan).pipe(Effect.flip)).toMatchObject({
							_tag: "SnapshotStoreError",
							code: "unavailable"
						});
					expect(abandoned.threadId).toBe(-1);
					const retried = yield* model.localizationQuality();
					expect(retried.findings.length).toBeGreaterThan(0);
					expect([...workers].filter((worker) => worker.threadId !== -1)).toHaveLength(1);
				}).pipe(Effect.scoped, Effect.provide(fixture.layer(false, fixture.source, true)));
			}).pipe(Effect.ensuring(Effect.sync(() => messages.mockRestore())));
		},
		30_000
	);

it.live(
	"cancellation forgets a completed scan whose done reply the host has not received",
	() => {
		type Completed = { id: number; deliver: () => void };
		let complete: (done: Completed) => void = () => {};
		const completed = new Promise<Completed>((resolve) => {
			complete = resolve;
		});
		const on = Worker.prototype.on;
		let held = false;
		const messages = vi
			.spyOn(Worker.prototype, "on")
			.mockImplementation(function (this: Worker, event, listener) {
				if (event !== "message") return on.call(this, event, listener);
				return on.call(this, event, (raw: typeof QualityWorkerReply.Encoded) => {
					const decoded = Schema.decodeUnknownExit(QualityWorkerReply)(raw);
					if (Exit.isFailure(decoded)) return listener(raw);
					const reply = decoded.value;
					if (reply.kind === "done" && !held) {
						held = true;
						complete({ id: reply.id, deliver: () => listener(raw) });
					} else listener(raw);
				});
			});
		return Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			yield* Effect.gen(function* () {
				const model = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				const scan = yield* Effect.forkChild(model.localizationQuality());
				const done = yield* Effect.promise(() => completed);
				yield* Fiber.interrupt(scan);
				done.deliver(); // Now ignored by the host; no result objects can release this scan.
				const next = yield* model.localizationQuality(); // Same port: cancellation ran first.
				expect(next.findings.length).toBeGreaterThan(0);
				const post = MessagePort.prototype.postMessage;
				const calls = vi
					.spyOn(MessagePort.prototype, "postMessage")
					.mockImplementation(function (this: MessagePort, message, transfer) {
						const decoded = Schema.decodeUnknownExit(QualityWorkerCall)(message);
						return post.call(
							this,
							Exit.isSuccess(decoded) ? { ...decoded.value, scan: done.id } : message,
							transfer
						);
					});
				try {
					const failed = yield* next.findings.items([0]).pipe(Effect.result);
					expect(failed).toMatchObject({
						_tag: "Failure",
						failure: { message: expect.stringMatching(/quality scan was released/u) }
					});
				} finally {
					calls.mockRestore();
				}
			}).pipe(Effect.scoped, Effect.provide(fixture.layer(false, fixture.source, true)));
		}).pipe(Effect.ensuring(Effect.sync(() => messages.mockRestore())));
	},
	30_000
);
