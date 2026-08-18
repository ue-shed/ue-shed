import { Effect, Schema } from "effect";
import { reviseReviewView } from "./review-framing.js";
import { ReviewRepository, type ReviewStorageError } from "./review-repository.js";
import {
	decodeReviewSet,
	type ReviewSet,
	type ReviewView,
	type ReviewViewDefinition
} from "./review-schema.js";

export class ReviewViewDefinitionError extends Schema.TaggedErrorClass<ReviewViewDefinitionError>()(
	"ReviewViewDefinitionError",
	{
		message: Schema.String,
		recovery: Schema.String,
		viewId: Schema.String
	}
) {}

export interface PutReviewViewResult {
	readonly reviewSet: ReviewSet;
	readonly status: "created" | "revised" | "unchanged";
	readonly view: ReviewView;
}

export function putReviewView(args: {
	readonly reviewSet: ReviewSet;
	readonly view: ReviewView;
}): Effect.Effect<PutReviewViewResult, ReviewViewDefinitionError> {
	const current = args.reviewSet.views.find((view) => view.id === args.view.id);
	if (current !== undefined) {
		let definition: ReviewViewDefinition;
		if (args.view.target.kind === "oriented_box") {
			if (args.view.viewpoint.kind !== "world_fixed") {
				return Effect.fail(
					new ReviewViewDefinitionError({
						message: "Oriented-area Views must use a world-fixed viewpoint.",
						recovery: "Provide a world-fixed approved pose for the area View.",
						viewId: args.view.id
					})
				);
			}
			definition = { target: args.view.target, viewpoint: args.view.viewpoint };
		} else if (args.view.viewpoint.kind === "world_fixed") {
			definition = { target: args.view.target, viewpoint: args.view.viewpoint };
		} else {
			definition = { target: args.view.target, viewpoint: args.view.viewpoint };
		}
		const result = reviseReviewView({
			definition,
			reviewSet: args.reviewSet,
			viewId: args.view.id,
			...(args.view.visibilityOverrides === undefined
				? undefined
				: { visibilityOverrides: args.view.visibilityOverrides }),
			visibilityPolicyId: args.view.visibilityPolicyId
		});
		if (result.status === "view_not_found") {
			return Effect.fail(
				new ReviewViewDefinitionError({
					message: `Review View ${args.view.id} was not found during revision.`,
					recovery: "Reload the Review Set and retry the revision.",
					viewId: args.view.id
				})
			);
		}
		const view = result.reviewSet.views.find((candidate) => candidate.id === args.view.id)!;
		return Effect.succeed({ reviewSet: result.reviewSet, status: result.status, view });
	}
	const candidate = { ...args.reviewSet, views: [...args.reviewSet.views, args.view] };
	return decodeReviewSet(candidate).pipe(
		Effect.map((reviewSet) => ({ reviewSet, status: "created" as const, view: args.view })),
		Effect.mapError(
			(cause) =>
				new ReviewViewDefinitionError({
					message: String(cause),
					recovery:
						"Choose existing Capture Profile and Visibility Policy IDs and satisfy the Review View contract.",
					viewId: args.view.id
				})
		)
	);
}

export function putReviewViewAtPath(args: {
	readonly path: string;
	readonly view: ReviewView;
}): Effect.Effect<
	PutReviewViewResult,
	ReviewStorageError | ReviewViewDefinitionError,
	ReviewRepository
> {
	return Effect.flatMap(ReviewRepository, (repository) =>
		repository.loadSet(args.path).pipe(
			Effect.flatMap((reviewSet) => putReviewView({ reviewSet, view: args.view })),
			Effect.tap((result) =>
				repository.saveSet({ path: args.path, reviewSet: result.reviewSet })
			)
		)
	);
}
