import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { fixtureArrangement, fixtureSet } from "./camera-arrangement.test-support.js";
import {
	CameraArrangement,
	CameraArrangementCommand,
	approveArrangementCamera,
	resolveArrangementCamera
} from "./camera-arrangement.js";
import { CameraApproval, makeCameraAuthoringStore } from "./camera-authoring-store.js";
import { CameraBridgeSnapshot } from "./camera-authoring-bridge.js";
import { prepareCameraRecovery, restoreCameraRecovery } from "./camera-authoring-recovery.js";
import { legacyReviewRenderPolicy } from "./camera-render-schema.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-durability-"));
	roots.push(root);
	const arrangement = fixtureArrangement();
	const store = makeCameraAuthoringStore(join(root, "draft.json"));
	await Effect.runPromise(store.create(arrangement, fixtureSet()));
	const approval = Schema.decodeUnknownSync(CameraApproval)({
		operationId: "save",
		expectedRevision: 0,
		cameraId: "camera-0",
		destination: join(root, "review.json")
	});
	return { root, arrangement, store, approval };
}

it("does not commit approval intent when the destination is locked", async () => {
	const { store, approval } = await fixture();
	await writeFile(`${approval.destination}.lock`, "another writer");
	await expect(Effect.runPromise(store.approve(approval))).rejects.toMatchObject({
		code: "busy"
	});
	const untouched = await Effect.runPromise(store.load());
	expect(untouched.projection).toBeUndefined();
	expect(untouched.outcomes).toEqual([]);
	await rm(`${approval.destination}.lock`);
	expect((await Effect.runPromise(store.approve(approval))).reviewSet.views).toHaveLength(1);
});

it("allows disjoint concurrent approval losers to retry and keep editing", async () => {
	const { root, approval } = await fixture();
	const stores = await Promise.all(
		Array.from({ length: 8 }, async (_, index) => {
			const arrangement = Schema.decodeUnknownSync(CameraArrangement)({
				...fixtureArrangement(),
				id: `set-${index}`,
				cameras: fixtureArrangement().cameras.map((camera) => ({
					...camera,
					viewId: `view-${index}-${camera.id}`
				}))
			});
			const store = makeCameraAuthoringStore(join(root, `set-${index}.json`));
			await Effect.runPromise(store.create(arrangement, fixtureSet()));
			return store;
		})
	);
	await Promise.allSettled(stores.map((store) => Effect.runPromise(store.approve(approval))));
	for (const store of stores) {
		const saved = await Effect.runPromise(store.approve(approval));
		expect(saved.projection).toBeUndefined();
		await Effect.runPromise(
			store.mutate(
				Schema.decodeUnknownSync(CameraArrangementCommand)({
					kind: "tune",
					arrangementId: saved.arrangement.id,
					expectedRevision: 0,
					operationId: "edit-after-approval",
					settings: { distanceScale: 2 }
				})
			)
		);
	}
	expect(JSON.parse(await readFile(approval.destination, "utf8")).views).toHaveLength(8);
});

it("honors native recovery after a committed gesture was subsequently edited on the host", async () => {
	const { arrangement, store } = await fixture();
	const native = Schema.decodeUnknownSync(CameraBridgeSnapshot)({
		version: 1,
		status: "ready",
		message: "",
		sessionId: arrangement.id,
		cameraId: "camera-0",
		producerId: "producer",
		revision: 0,
		sequence: 1,
		pending: true,
		piloting: false,
		saveRequested: false,
		pose: { ...resolveArrangementCamera(arrangement, "camera-0"), fieldOfViewDegrees: 55 }
	});
	const initial = await Effect.runPromise(prepareCameraRecovery(store, native));
	await Effect.runPromise(restoreCameraRecovery(store, initial, "native"));
	await Effect.runPromise(
		store.mutate(
			Schema.decodeUnknownSync(CameraArrangementCommand)({
				kind: "override",
				arrangementId: arrangement.id,
				expectedRevision: 1,
				operationId: "host-edit",
				cameraId: "camera-0",
				overrides: { fieldOfViewDegrees: 40 }
			})
		)
	);
	await expect(
		Effect.runPromise(restoreCameraRecovery(store, initial, "native"))
	).rejects.toMatchObject({ code: "stale" });
	const proposal = await Effect.runPromise(prepareCameraRecovery(store, native));
	const restored = await Effect.runPromise(restoreCameraRecovery(store, proposal, "native"));
	expect(resolveArrangementCamera(restored.arrangement, "camera-0").fieldOfViewDegrees).toBe(55);
	expect(restored.arrangement.revision).toBe(3);
	expect(
		(await Effect.runPromise(restoreCameraRecovery(store, proposal, "native"))).arrangement
			.revision
	).toBe(3);
});

it("reuses identical capture policies without changing profiles referenced by other Views", () => {
	const arrangement = CameraArrangement.make({
		...fixtureArrangement(),
		renderPolicy: legacyReviewRenderPolicy
	});
	let set = fixtureSet();
	for (let index = 0; index < 20; index++)
		set = approveArrangementCamera(arrangement, "camera-0", set);
	expect(set.views).toHaveLength(1);
	expect(set.captureProfiles).toHaveLength(2);
	const profile = set.captureProfiles[1];
	expect(profile?.renderPolicy).toEqual(legacyReviewRenderPolicy);
	set = approveArrangementCamera(
		{
			...arrangement,
			renderPolicy: {
				...legacyReviewRenderPolicy,
				exposure: { mode: "fixed_ev100", ev100: 8, compensation: "project" }
			}
		},
		"camera-0",
		set
	);
	expect(set.captureProfiles).toHaveLength(3);
	expect(set.captureProfiles[1]).toEqual(profile);
});
