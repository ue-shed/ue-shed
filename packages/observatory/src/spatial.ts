import { ErrorGuidanceFields } from "@ue-shed/protocol";
import { type Brand, Effect, Schema } from "effect";
import type { ObservedActor as ObservedActorType } from "./actor-models.js";
import { WorldScoutResult, WorldScoutFocusResult } from "./scout-contracts.js";
/**
 * A value that does not match the World Scout contract: the two sides disagree about the contract, so
 * repeating the same call returns the same mismatch.
 */
export class WorldScoutContractError extends Schema.TaggedError<
	WorldScoutContractError,
	Brand.Brand<"packages/observatory/src/spatial/WorldScoutContractError">
>()("WorldScoutContractError", {
	code: Schema.Literal("invalid_contract"),
	...ErrorGuidanceFields,
	cause: Schema.optionalKey(Schema.Defect())
}) {}

/**
 * A unary parser for one World Scout contract value: it decodes the encoded value and fails with
 * `WorldScoutContractError` naming `subject`, keeping the schema issue as its cause.
 */
function worldScoutContractParser<S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	subject: string
) {
	const decode = Schema.decodeUnknownEffect(schema);
	return (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser is the boundary: it decodes its input here.
		encoded: unknown
	): Effect.Effect<S["Type"], WorldScoutContractError> =>
		decode(encoded).pipe(
			Effect.mapError(
				(cause) =>
					new WorldScoutContractError({
						code: "invalid_contract",
						message: `The ${subject} does not match the World Scout contract.`,
						recovery:
							"Run the host and client from the same UE Shed version, then retry.",
						retrySafe: false,
						nextStep: "escalate",
						cause
					})
			)
		);
}

export const parseWorldScoutResult = worldScoutContractParser(
	WorldScoutResult,
	"world scout result"
);
export const parseWorldScoutFocusResult = worldScoutContractParser(
	WorldScoutFocusResult,
	"world scout focus result"
);

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
