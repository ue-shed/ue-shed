import type {
	EvidenceMarker,
	InterventionClip,
	RawInputClip,
	ScenarioCheckpoint,
	ScenarioClip,
	ScenarioDocument,
	ScenarioElementId,
	SemanticActionClip,
	TimelineTimeMs,
	WorldConditionClip
} from "./schema.js";
import { makeTimelineTimeMs } from "./schema.js";

export type ScenarioEditResult =
	| { readonly status: "updated"; readonly document: ScenarioDocument }
	| { readonly status: "not_found"; readonly clipId: ScenarioElementId };

export type ScenarioSeekPlan =
	| {
			readonly status: "restore";
			readonly checkpoint: ScenarioCheckpoint;
			readonly targetMs: TimelineTimeMs;
	  }
	| {
			readonly status: "restore_and_replay";
			readonly checkpoint: ScenarioCheckpoint;
			readonly targetMs: TimelineTimeMs;
			readonly replayDurationMs: number;
			readonly crossesNonSeekable: boolean;
	  }
	| {
			readonly status: "unavailable";
			readonly targetMs: TimelineTimeMs;
			readonly reason: string;
	  };

export function clipsInScenario(document: ScenarioDocument): readonly ScenarioClip[] {
	const clips: ScenarioClip[] = [];
	for (const track of document.tracks) {
		switch (track.kind) {
			case "semantic_actions":
			case "raw_input":
			case "world_conditions":
			case "evidence":
			case "interventions":
				clips.push(...track.clips);
		}
	}
	return clips;
}

export function clipEndMs(clip: ScenarioClip): number {
	switch (clip.kind) {
		case "semantic_action":
		case "raw_input":
		case "intervention":
			return clip.startMs + clip.durationMs;
		case "world_condition":
			return clip.startMs + clip.timeoutMs;
		case "evidence":
			return clip.startMs;
	}
}

export function findScenarioClip(
	document: ScenarioDocument,
	clipId: ScenarioElementId
): ScenarioClip | undefined {
	return clipsInScenario(document).find((clip) => clip.id === clipId);
}

function moveSemanticClip(clip: SemanticActionClip, startMs: TimelineTimeMs): SemanticActionClip {
	return { ...clip, startMs };
}

function moveRawClip(clip: RawInputClip, startMs: TimelineTimeMs): RawInputClip {
	return { ...clip, startMs };
}

function moveWorldClip(clip: WorldConditionClip, startMs: TimelineTimeMs): WorldConditionClip {
	return { ...clip, startMs };
}

function moveEvidence(clip: EvidenceMarker, startMs: TimelineTimeMs): EvidenceMarker {
	return { ...clip, startMs };
}

function moveIntervention(clip: InterventionClip, startMs: TimelineTimeMs): InterventionClip {
	return { ...clip, startMs };
}

export function moveScenarioClip(options: {
	readonly document: ScenarioDocument;
	readonly clipId: ScenarioElementId;
	readonly startMs: number;
}): ScenarioEditResult {
	if (findScenarioClip(options.document, options.clipId) === undefined) {
		return { status: "not_found", clipId: options.clipId };
	}
	const boundedStart = makeTimelineTimeMs(
		Math.max(0, Math.min(Math.round(options.startMs), options.document.durationMs))
	);
	return {
		status: "updated",
		document: {
			...options.document,
			tracks: options.document.tracks.map((track) => {
				switch (track.kind) {
					case "semantic_actions":
						return {
							...track,
							clips: track.clips.map((clip) =>
								clip.id === options.clipId
									? moveSemanticClip(clip, boundedStart)
									: clip
							)
						};
					case "raw_input":
						return {
							...track,
							clips: track.clips.map((clip) =>
								clip.id === options.clipId ? moveRawClip(clip, boundedStart) : clip
							)
						};
					case "world_conditions":
						return {
							...track,
							clips: track.clips.map((clip) =>
								clip.id === options.clipId
									? moveWorldClip(clip, boundedStart)
									: clip
							)
						};
					case "evidence":
						return {
							...track,
							clips: track.clips.map((clip) =>
								clip.id === options.clipId ? moveEvidence(clip, boundedStart) : clip
							)
						};
					case "interventions":
						return {
							...track,
							clips: track.clips.map((clip) =>
								clip.id === options.clipId
									? moveIntervention(clip, boundedStart)
									: clip
							)
						};
				}
			})
		}
	};
}

export function planScenarioSeek(options: {
	readonly document: ScenarioDocument;
	readonly targetMs: number;
}): ScenarioSeekPlan {
	const targetMs = makeTimelineTimeMs(
		Math.max(0, Math.min(Math.round(options.targetMs), options.document.durationMs))
	);
	const checkpoint = [...options.document.checkpoints]
		.filter((candidate) => candidate.atMs <= targetMs)
		.sort((left, right) => right.atMs - left.atMs)[0];
	if (checkpoint === undefined) {
		return {
			status: "unavailable",
			targetMs,
			reason: "No restorable checkpoint exists before this time."
		};
	}
	if (checkpoint.atMs === targetMs) return { status: "restore", checkpoint, targetMs };
	return {
		status: "restore_and_replay",
		checkpoint,
		targetMs,
		replayDurationMs: targetMs - checkpoint.atMs,
		crossesNonSeekable: options.document.nonSeekableIntervals.some(
			(interval) => interval.endMs > checkpoint.atMs && interval.startMs < targetMs
		)
	};
}

export interface ScenarioTimelineIssue {
	readonly elementId: ScenarioElementId;
	readonly message: string;
}

export function inspectScenarioTimeline(
	document: ScenarioDocument
): readonly ScenarioTimelineIssue[] {
	const issues: ScenarioTimelineIssue[] = [];
	for (const clip of clipsInScenario(document)) {
		if (clipEndMs(clip) > document.durationMs) {
			issues.push({ elementId: clip.id, message: "Clip extends beyond scenario duration." });
		}
		if (clip.kind === "semantic_action") {
			for (const keyframe of clip.keyframes) {
				if (keyframe.offsetMs > clip.durationMs) {
					issues.push({
						elementId: clip.id,
						message: "Action keyframe extends beyond its semantic clip."
					});
				}
			}
		}
	}
	return issues;
}
