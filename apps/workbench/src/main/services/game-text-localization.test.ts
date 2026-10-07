import { it } from "@effect/vitest";
import { Effect, Ref, Deferred, Fiber } from "effect";
import { expect } from "vitest";
import { makeLocalizationEvidenceTestLayer, LocalizationError } from "@ue-shed/localization";
import {
	corpus,
	evidence,
	poDocument,
	target,
	unit,
	cultureCode
} from "./game-text-localization.test-support.js";
import { makeGameTextLocalization } from "./game-text-localization.js";

it.effect("returns a recoverable reader failure without exposing file authority", () =>
	Effect.gen(function* () {
		const saved = corpus();
		const localization = yield* makeGameTextLocalization(
			() => Effect.succeed(saved),
			() => Effect.succeed("C:/Project")
		).pipe(
			Effect.provide(
				makeLocalizationEvidenceTestLayer({
					discover: () =>
						Effect.succeed({ schemaVersion: 1, targets: [target], diagnostics: [] }),
					read: () =>
						Effect.fail(
							new LocalizationError({
								code: "file_unreadable",
								message: "C:/Private/Archive",
								recovery: "C:/Private/PO"
							})
						),
					targets: () => Effect.die("Not used")
				})
			)
		);
		const result = yield* localization.select(target.name);
		expect(result).toMatchObject({ status: "failed", code: "file_unreadable" });
		expect(JSON.stringify(result)).not.toContain("C:/Private");
	})
);

it.effect("discovers no-target projects without reading evidence", () =>
	Effect.gen(function* () {
		const saved = corpus();
		const localization = yield* makeGameTextLocalization(
			() => Effect.succeed(saved),
			() => Effect.succeed("C:/Project")
		);
		expect(yield* localization.targets()).toEqual({ status: "ready", targets: [] });
	}).pipe(
		Effect.provide(
			makeLocalizationEvidenceTestLayer({
				discover: () => Effect.succeed({ schemaVersion: 1, targets: [], diagnostics: [] }),
				read: () => Effect.die("Evidence must not be read"),
				targets: () => Effect.die("Not used")
			})
		)
	)
);

it.effect(
	"retains evidence across remounts, reloads it after rescan and returns bounded joined pages",
	() =>
		Effect.gen(function* () {
			const text = yield* Ref.make(corpus());
			let reads = 0;
			const api = makeLocalizationEvidenceTestLayer({
				discover: () =>
					Effect.succeed({ schemaVersion: 1, targets: [target], diagnostics: [] }),
				read: () =>
					Effect.sync(() => {
						reads++;
						return evidence(poDocument(reads === 1 ? "Pending" : "Translation"));
					}),
				targets: () => Effect.die("Not used")
			});
			const localization = yield* makeGameTextLocalization(
				() => Ref.get(text),
				() => Effect.succeed("C:/Project")
			).pipe(Effect.provide(api));
			expect(yield* localization.targets()).toMatchObject({
				status: "ready",
				targets: [{ name: target.name, cultures: ["en", "de"] }]
			});
			const loaded = yield* localization.select(target.name);
			expect(loaded).toMatchObject({ status: "ready", lines: 1, notSynced: 2 });
			yield* localization.select(target.name);
			expect(reads).toBe(1);
			const page = yield* localization.search({
				query: "Pending",
				capability: "all",
				pageSize: 1,
				localization: {
					target: target.name,
					culture: cultureCode("de"),
					searchTranslations: true
				}
			});
			expect(page).toMatchObject({ status: "ready", page: { total: 1, counts: { all: 1 } } });
			const focused = yield* localization.focus({
				target: target.name,
				selection: { kind: "unit", id: unit().id }
			});
			expect(focused).toMatchObject({
				status: "found",
				focus: {
					translations: [{ poTranslation: "Pending" }, { poTranslation: "Pending" }]
				}
			});
			expect(JSON.stringify(focused)).not.toContain("provenance");
			yield* Ref.set(text, corpus());
			yield* localization.reset();
			expect(yield* localization.select(target.name)).toMatchObject({
				status: "ready",
				notSynced: 0
			});
			expect(reads).toBe(2);
		})
);

it.effect("discards evidence loaded for a corpus that changed during the read", () =>
	Effect.gen(function* () {
		const text = yield* Ref.make(corpus());
		const started = yield* Deferred.make<void>();
		const result = yield* Deferred.make<ReturnType<typeof evidence>>();
		const localization = yield* makeGameTextLocalization(
			() => Ref.get(text),
			() => Effect.succeed("C:/Project")
		).pipe(
			Effect.provide(
				makeLocalizationEvidenceTestLayer({
					discover: () =>
						Effect.succeed({ schemaVersion: 1, targets: [target], diagnostics: [] }),
					read: () =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Deferred.await(result))
						),
					targets: () => Effect.die("Not used")
				})
			)
		);
		const fiber = yield* localization.select(target.name).pipe(Effect.forkChild);
		yield* Deferred.await(started);
		yield* Ref.set(text, corpus([unit("Another")]));
		yield* localization.reset();
		yield* Deferred.succeed(result, evidence());
		expect(yield* Fiber.join(fiber)).toEqual({ status: "not_ready" });
		expect(
			yield* localization.focus({
				target: target.name,
				selection: { kind: "unit", id: unit().id }
			})
		).toEqual({ status: "not_ready" });
	})
);
