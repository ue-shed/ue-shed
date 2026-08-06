import { randomUUID } from "node:crypto";
import { copyFile, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	CaptureProfile,
	CaptureProfileId,
	ReviewCaptureRequestCurrent,
	ReviewViewId,
	captureReviewView,
	generateFramingCandidates,
	inspectReviewSelection,
	previewReviewCandidate
} from "@ue-shed/cameras";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const enabled = process.env.UE_SHED_MAP_REVIEW_FLOW_E2E === "1" && endpoint !== undefined;
const fixtureContractPath = fileURLToPath(
	new URL("../../../fixtures/unreal-project/fixture-contract.json", import.meta.url)
);
const editorActorSubsystem = "/Script/UnrealEd.Default__EditorActorSubsystem";
const editorLoadingLibrary = "/Script/UnrealEd.Default__EditorLoadingAndSavingUtils";

const FixtureContract = Schema.Struct({
	mapReviewGallery: Schema.Struct({
		map: Schema.NonEmptyString,
		occluders: Schema.Record(Schema.String, Schema.NonEmptyString),
		subjects: Schema.Record(Schema.String, Schema.NonEmptyString)
	})
});

test.skip(!enabled, "run through pnpm test:flow:map-review with the live gallery editor");
test.setTimeout(300_000);

async function remoteCall(args: {
	readonly functionName: string;
	readonly objectPath: string;
	readonly parameters?: Readonly<Record<string, unknown>>;
}): Promise<unknown> {
	if (endpoint === undefined) throw new Error("The live Map Review endpoint is unavailable.");
	const response = await fetch(`${endpoint}/remote/object/call`, {
		body: JSON.stringify({
			functionName: args.functionName,
			generateTransaction: false,
			objectPath: args.objectPath,
			parameters: args.parameters ?? {}
		}),
		headers: { "content-type": "application/json" },
		method: "PUT",
		signal: AbortSignal.timeout(30_000)
	});
	if (!response.ok) throw new Error(`${args.functionName} failed with HTTP ${response.status}.`);
	return response.json() as Promise<unknown>;
}

async function contract() {
	return Schema.decodeUnknownSync(FixtureContract)(
		JSON.parse(await readFile(fixtureContractPath, "utf8")) as unknown
	).mapReviewGallery;
}

async function selectSubject(actorPath: string) {
	await remoteCall({ functionName: "SelectNothing", objectPath: editorActorSubsystem });
	await remoteCall({
		functionName: "SetActorSelectionState",
		objectPath: editorActorSubsystem,
		parameters: { Actor: actorPath, bShouldBeSelected: true }
	});
	const selection = await Effect.runPromise(
		inspectReviewSelection(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
	);
	if (selection.status !== "selected") {
		throw new Error(`Could not inspect ${actorPath}: ${selection.message}`);
	}
	return selection;
}

test.afterEach(async () => {
	await remoteCall({ functionName: "SelectNothing", objectPath: editorActorSubsystem });
	const gallery = await contract();
	const dirty = Schema.decodeUnknownSync(
		Schema.Struct({ OutDirtyPackages: Schema.Array(Schema.String) })
	)(
		await remoteCall({
			functionName: "GetDirtyMapPackages",
			objectPath: editorLoadingLibrary
		})
	);
	expect(dirty.OutDirtyPackages.some((path) => path.includes(gallery.map))).toBe(false);
});

test("frames varied gallery subjects with real Unreal previews", async ({
	browserName: _browserName
}, testInfo) => {
	if (endpoint === undefined) throw new Error("The live Map Review endpoint is unavailable.");
	const gallery = await contract();
	const subjectKeys = ["compact", "tall", "wide", "asymmetric", "compound"] as const;
	const bounds: Array<{ readonly key: string; readonly signature: string }> = [];
	const profile = CaptureProfile.make({
		id: CaptureProfileId.make("gallery-preview"),
		imageFormat: "png",
		renderProfile: "full_fidelity",
		resolution: { height: 180, width: 320 }
	});

	for (const key of subjectKeys) {
		const actorPath = gallery.subjects[key];
		if (actorPath === undefined) throw new Error(`Missing gallery subject ${key}.`);
		const selection = await selectSubject(actorPath);
		expect(selection.mapPath).toBe(gallery.map);
		bounds.push({ key, signature: JSON.stringify(selection.bounds.extent) });
		const candidates = generateFramingCandidates(selection);
		expect(candidates).toHaveLength(7);
		expect(
			new Set(candidates.map((candidate) => candidate.approvedPose.location.x)).size
		).toBeGreaterThan(1);
		const preview = await Effect.runPromise(
			previewReviewCandidate({
				candidate: candidates[0]!,
				endpoint,
				mapPath: gallery.map,
				profile,
				subject: { actorPath, displayName: selection.displayName }
			}).pipe(Effect.provide(RemoteControlClientLive))
		);
		expect({ height: preview.height, width: preview.width }).toEqual({
			height: 180,
			width: 320
		});
		expect(preview.projection.status).toBe("projected");
		await writeFile(
			testInfo.outputPath(`${key}-projection.json`),
			JSON.stringify(preview.projection)
		);
	}

	expect(new Set(bounds.map((item) => item.signature)).size).toBe(subjectKeys.length);
});

test("captures occlusion bays and restores explicit Clear interventions", async ({
	browserName: _browserName
}, testInfo) => {
	if (endpoint === undefined) throw new Error("The live Map Review endpoint is unavailable.");
	const gallery = await contract();
	const subjectKeys = ["clear", "partial", "full", "translucent", "enclosed"] as const;
	const stagingPaths: string[] = [];
	const evidence: Array<Readonly<Record<string, unknown>>> = [];
	try {
		for (const key of subjectKeys) {
			const actorPath = gallery.subjects[key];
			if (actorPath === undefined) throw new Error(`Missing gallery subject ${key}.`);
			const selection = await selectSubject(actorPath);
			const candidate = generateFramingCandidates(selection)[0]!;
			const partialOccluder = gallery.occluders.partial;
			if (key === "partial" && partialOccluder === undefined) {
				throw new Error("Missing partial occluder fixture contract.");
			}
			const response = await Effect.runPromise(
				captureReviewView({
					endpoint,
					request: ReviewCaptureRequestCurrent.make({
						assessment: { method: "automatic" },
						clearCompanion:
							key === "partial"
								? {
										actors: [partialOccluder!],
										status: "requested",
										strategy: "hide_explicit"
									}
								: { status: "not_requested" },
						contract: {
							name: "ue-shed-review-capture",
							version: { major: 1, minor: 4 }
						},
						expectedMapPath: gallery.map,
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { actorPath, diagnosticLabel: key, kind: "actor_path" },
						viewId: ReviewViewId.make(`gallery-${key}`),
						viewpoint: { approvedPose: candidate.approvedPose, kind: "world_fixed" }
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(response.status).toBe("captured");
			if (response.status !== "captured") continue;
			expect(response.mapPackageDirtyAfter).toBe(response.mapPackageDirtyBefore);
			expect(response.subjectProjection?.status).toBe("projected");
			const artifacts =
				"stagedArtifacts" in response
					? response.stagedArtifacts
					: [{ stagingPath: response.stagingPath, variant: "pure" as const }];
			stagingPaths.push(...artifacts.map((artifact) => artifact.stagingPath));
			for (const artifact of artifacts) {
				await copyFile(
					artifact.stagingPath,
					testInfo.outputPath(`${key}-${artifact.variant}.png`)
				);
			}
			if (key === "partial") {
				expect(artifacts.map((artifact) => artifact.variant).sort()).toEqual([
					"clear",
					"pure"
				]);
				expect(
					"clearCompanion" in response ? response.clearCompanion : undefined
				).toMatchObject({
					restoration: { status: "restored" },
					status: "captured"
				});
			}
			evidence.push({
				key,
				projection: response.subjectProjection,
				visibility: "visibility" in response ? response.visibility : undefined
			});
		}
		await writeFile(
			testInfo.outputPath("occlusion-evidence.json"),
			`${JSON.stringify(evidence, null, 2)}\n`,
			"utf8"
		);
		expect(evidence).toHaveLength(subjectKeys.length);
	} finally {
		await Promise.all(stagingPaths.map((path) => unlink(path).catch(() => undefined)));
	}
});
