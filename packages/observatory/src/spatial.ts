import { Schema } from "effect";
import type { ObservedActor as ObservedActorType } from "./actor-models.js";
import { WorldScoutResult, WorldScoutFocusResult } from "./scout-contracts.js";
export const decodeWorldScoutResult = Schema.decodeUnknownEffect(WorldScoutResult);
export const decodeWorldScoutFocusResult = Schema.decodeUnknownEffect(WorldScoutFocusResult);

export interface SpatialPoint {
	readonly actor: ObservedActorType;
	readonly xPercent: number;
	readonly yPercent: number;
}

export interface SpatialProjection {
	readonly center: { readonly x: number; readonly y: number };
	readonly height: number;
	readonly points: ReadonlyArray<SpatialPoint>;
	readonly width: number;
}

export function projectActors(
	actors: ReadonlyArray<ObservedActorType>,
	paddingRatio = 0.08
): SpatialProjection {
	if (actors.length === 0) {
		return { center: { x: 0, y: 0 }, height: 1, points: [], width: 1 };
	}
	const minX = Math.min(...actors.map((actor) => actor.location.x - actor.bounds.extent.x));
	const maxX = Math.max(...actors.map((actor) => actor.location.x + actor.bounds.extent.x));
	const minY = Math.min(...actors.map((actor) => actor.location.y - actor.bounds.extent.y));
	const maxY = Math.max(...actors.map((actor) => actor.location.y + actor.bounds.extent.y));
	const rawWidth = Math.max(1, maxX - minX);
	const rawHeight = Math.max(1, maxY - minY);
	const padX = rawWidth * paddingRatio;
	const padY = rawHeight * paddingRatio;
	const width = rawWidth + padX * 2;
	const height = rawHeight + padY * 2;
	const size = Math.max(width, height);
	const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
	const left = center.x - size / 2;
	const top = center.y + size / 2;
	return {
		center,
		height,
		points: actors.map((actor) => ({
			actor,
			xPercent: ((actor.location.x - left) / size) * 100,
			yPercent: ((top - actor.location.y) / size) * 100
		})),
		width
	};
}
