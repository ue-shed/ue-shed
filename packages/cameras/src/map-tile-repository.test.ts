import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { makeDefaultMapCapturePlan } from "./map-tile-authoring.js";
import { MapCaptureRepository, MapCaptureRepositoryLive } from "./map-tile-repository.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("MapCaptureRepository", () => {
	it("atomically saves and reloads a portable plan", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-map-plan-"));
		roots.push(root);
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "Fixture.uproject"), "{}", "utf8");
		const path = join(root, ".ue-shed", "map-capture", "plans", "overview.json");
		const plan = makeDefaultMapCapturePlan({
			mapPath: "/Game/Maps/L_Fixture",
			projectId: "Fixture"
		});

		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repository = yield* MapCaptureRepository;
				yield* repository.savePlan(path, plan);
				return yield* repository.loadPlan(path);
			}).pipe(Effect.provide(MapCaptureRepositoryLive))
		);

		expect(loaded).toEqual(plan);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(plan);
	});
});
