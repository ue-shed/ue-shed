import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { movementGymScenario } from "./demo.js";
import {
	decodeScenarioExecutionRequest,
	movementGymExecutionRequest,
	ScenarioCancelResponse,
	ScenarioExecutionRequest,
	ScenarioPrepareResponse,
	ScenarioStartResponse,
	ScenarioStatusResponse
} from "./live.js";
import type { ScenarioDocument } from "./schema.js";

function withSemanticTrack(
	transform: (
		track: Extract<ScenarioDocument["tracks"][number], { readonly kind: "semantic_actions" }>
	) => Extract<ScenarioDocument["tracks"][number], { readonly kind: "semantic_actions" }>
): ScenarioDocument {
	return {
		...movementGymScenario,
		tracks: movementGymScenario.tracks.map((track) =>
			track.kind === "semantic_actions" ? transform(track) : track
		)
	};
}

async function fixture(name: string): Promise<unknown> {
	const path = fileURLToPath(
		new URL(`../../protocol/contracts/scenarios/live/v1/fixtures/${name}.json`, import.meta.url)
	);
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function expectFixtureRoundTrip<T, E>(
	name: string,
	schema: Schema.Codec<T, E, never, never>
) {
	const input = await fixture(name);
	const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(schema)(input));
	const encoded = await Effect.runPromise(Schema.encodeUnknownEffect(schema)(decoded));
	expect(encoded, name).toEqual(input);
}

describe("live Movement Gym request", () => {
	it("projects only the registered pre-evaluation action contract", () => {
		const request = movementGymExecutionRequest({
			document: movementGymScenario,
			evidenceLimit: 3,
			pieSessionId: "pie-session-1"
		});
		expect(request.injectionLayer).toBe("pre_evaluation");
		expect(request.actions.map((action) => action.actionId)).toEqual([
			"Move",
			"Jump",
			"Interact",
			"Move"
		]);
		expect(request.actions.flatMap((action) => action.keyframes)).toHaveLength(11);
		expect(request.wait.condition).toBe("landing_ready");
		expect(request.probe.condition).toBe("cache_open");
	});

	it("rejects an unproven injection layer", () => {
		const document = withSemanticTrack((track) => ({
			...track,
			injectAt: "evaluated_action"
		}));
		expect(() =>
			movementGymExecutionRequest({
				document,
				evidenceLimit: 3,
				pieSessionId: "pie-session-1"
			})
		).toThrow("Unsupported Movement Gym injection layer: evaluated_action");
	});

	it("rejects actions that are not explicitly registered", () => {
		const document = withSemanticTrack((track) => ({
			...track,
			clips: track.clips.map((clip, index) =>
				index === 0 ? { ...clip, actionPath: "/Game/Project/IA_StudioSpecific" } : clip
			)
		}));
		expect(() =>
			movementGymExecutionRequest({
				document,
				evidenceLimit: 3,
				pieSessionId: "pie-session-1"
			})
		).toThrow("Unsupported Movement Gym action");
	});

	it("rejects a partial or mistyped registered schedule", () => {
		const partial = withSemanticTrack((track) => ({ ...track, clips: track.clips.slice(1) }));
		expect(() =>
			movementGymExecutionRequest({
				document: partial,
				evidenceLimit: 3,
				pieSessionId: "pie-session-1"
			})
		).toThrow("exact registered four-clip action schedule");

		const mistyped = withSemanticTrack((track) => ({
			...track,
			clips: track.clips.map((clip) =>
				clip.actionPath.endsWith("IA_Jump")
					? {
							...clip,
							keyframes: clip.keyframes
								.slice(0, 1)
								.map((keyframe) => ({ ...keyframe, value: { x: 0, y: 1 } }))
						}
					: clip
			)
		}));
		expect(() =>
			movementGymExecutionRequest({
				document: mistyped,
				evidenceLimit: 3,
				pieSessionId: "pie-session-1"
			})
		).toThrow("Jump requires Boolean values");
	});

	it("round-trips the language-neutral request fixture", async () => {
		const input = await fixture("execution-request");
		await Effect.runPromise(decodeScenarioExecutionRequest(input));
		await expectFixtureRoundTrip("execution-request", ScenarioExecutionRequest);
	});

	it("round-trips every language-neutral response family", async () => {
		await expectFixtureRoundTrip("prepare-prepared", ScenarioPrepareResponse);
		await expectFixtureRoundTrip("start-accepted", ScenarioStartResponse);
		await expectFixtureRoundTrip("status-active", ScenarioStatusResponse);
		await expectFixtureRoundTrip("status-terminal-missing-divergence", ScenarioStatusResponse);
		await expectFixtureRoundTrip("status-terminal-cancelled", ScenarioStatusResponse);
		await expectFixtureRoundTrip("status-rejected-stale", ScenarioStatusResponse);
		await expectFixtureRoundTrip("cancel-accepted", ScenarioCancelResponse);
	});
});
