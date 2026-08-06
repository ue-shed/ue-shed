import { Effect, Schema } from "effect";
import { ReviewRepository, type ReviewStorageError } from "./review-repository.js";
import {
	ReviewViewId,
	VisibilityPolicyId,
	decodeReviewSet,
	type ReviewSet,
	type ReviewViewId as ReviewViewIdType,
	type VisibilityOverrides,
	type VisibilityPolicy,
	type VisibilityPolicyId as VisibilityPolicyIdType
} from "./review-schema.js";

export class ReviewVisibilityPolicyError extends Schema.TaggedErrorClass<ReviewVisibilityPolicyError>()(
	"ReviewVisibilityPolicyError",
	{
		code: Schema.Literals([
			"duplicate_view",
			"empty_selection",
			"invalid_assignment",
			"policy_id_conflict",
			"policy_not_found",
			"view_not_found"
		]),
		message: Schema.String,
		policyId: Schema.optional(Schema.String),
		recovery: Schema.String,
		viewIds: Schema.Array(Schema.String)
	}
) {}

export interface ReviewVisibilityPolicyInspection {
	readonly policies: ReadonlyArray<{
		readonly assignedViewIds: ReadonlyArray<ReviewViewIdType>;
		readonly policy: VisibilityPolicy;
	}>;
	readonly views: ReadonlyArray<{
		readonly displayName: string;
		readonly overrides: VisibilityOverrides | undefined;
		readonly policyId: VisibilityPolicyIdType;
		readonly viewId: ReviewViewIdType;
	}>;
}

export function inspectReviewVisibilityPolicies(
	reviewSet: ReviewSet
): ReviewVisibilityPolicyInspection {
	return {
		policies: reviewSet.visibilityPolicies.map((policy) => ({
			assignedViewIds: reviewSet.views
				.filter((view) => view.visibilityPolicyId === policy.id)
				.map((view) => view.id),
			policy
		})),
		views: reviewSet.views.map((view) => ({
			displayName: view.displayName,
			overrides: view.visibilityOverrides,
			policyId: view.visibilityPolicyId,
			viewId: view.id
		}))
	};
}

function invalidAssignment(
	message: string,
	policyId: VisibilityPolicyIdType,
	viewIds: ReadonlyArray<ReviewViewIdType>
): ReviewVisibilityPolicyError {
	return new ReviewVisibilityPolicyError({
		code: "invalid_assignment",
		message,
		policyId,
		recovery:
			"Choose a policy and per-View overrides that satisfy the Review Set contract, then retry.",
		viewIds: [...viewIds]
	});
}

export function replaceViewVisibilityPolicy(args: {
	readonly policy: VisibilityPolicy;
	readonly reviewSet: ReviewSet;
	readonly viewId: ReviewViewIdType;
	readonly visibilityOverrides?: VisibilityOverrides | undefined;
}): Effect.Effect<ReviewSet, ReviewVisibilityPolicyError> {
	const view = args.reviewSet.views.find((candidate) => candidate.id === args.viewId);
	if (view === undefined) {
		return Effect.fail(
			new ReviewVisibilityPolicyError({
				code: "view_not_found",
				message: `Review View ${args.viewId} was not found.`,
				recovery: "List the Review Set Views and choose an existing View ID.",
				viewIds: [args.viewId]
			})
		);
	}
	if (args.reviewSet.visibilityPolicies.some((policy) => policy.id === args.policy.id)) {
		return Effect.fail(
			new ReviewVisibilityPolicyError({
				code: "policy_id_conflict",
				message: `Visibility Policy ${args.policy.id} already exists.`,
				policyId: args.policy.id,
				recovery: "Use a new policy ID so the existing immutable preset remains unchanged.",
				viewIds: [args.viewId]
			})
		);
	}

	const replacement = {
		...view,
		...(args.visibilityOverrides === undefined
			? {}
			: { visibilityOverrides: args.visibilityOverrides }),
		visibilityPolicyId: args.policy.id
	};
	const candidate = {
		...args.reviewSet,
		views: args.reviewSet.views.map((item) => (item.id === args.viewId ? replacement : item)),
		visibilityPolicies: [...args.reviewSet.visibilityPolicies, args.policy]
	};
	return decodeReviewSet(candidate).pipe(
		Effect.mapError((cause) => invalidAssignment(String(cause), args.policy.id, [args.viewId]))
	);
}

export function applyVisibilityPolicyToViews(args: {
	readonly policyId: VisibilityPolicyIdType;
	readonly reviewSet: ReviewSet;
	readonly viewIds: ReadonlyArray<ReviewViewIdType>;
}): Effect.Effect<ReviewSet, ReviewVisibilityPolicyError> {
	if (args.viewIds.length === 0) {
		return Effect.fail(
			new ReviewVisibilityPolicyError({
				code: "empty_selection",
				message: "Applying a Visibility Policy requires at least one selected View.",
				policyId: args.policyId,
				recovery: "Select one or more Views explicitly, then retry.",
				viewIds: []
			})
		);
	}
	const selected = new Set(args.viewIds);
	if (selected.size !== args.viewIds.length) {
		return Effect.fail(
			new ReviewVisibilityPolicyError({
				code: "duplicate_view",
				message: "The selected View list contains duplicate IDs.",
				policyId: args.policyId,
				recovery: "Provide each selected View ID exactly once.",
				viewIds: [...args.viewIds]
			})
		);
	}
	if (!args.reviewSet.visibilityPolicies.some((policy) => policy.id === args.policyId)) {
		return Effect.fail(
			new ReviewVisibilityPolicyError({
				code: "policy_not_found",
				message: `Visibility Policy ${args.policyId} was not found.`,
				policyId: args.policyId,
				recovery: "List the Review Set policies and choose an existing policy ID.",
				viewIds: [...args.viewIds]
			})
		);
	}
	const missing = args.viewIds.filter(
		(viewId) => !args.reviewSet.views.some((view) => view.id === viewId)
	);
	if (missing.length > 0) {
		return Effect.fail(
			new ReviewVisibilityPolicyError({
				code: "view_not_found",
				message: `Review View ${missing[0]} was not found.`,
				policyId: args.policyId,
				recovery: "List the Review Set Views and choose existing View IDs.",
				viewIds: missing
			})
		);
	}

	const candidate = {
		...args.reviewSet,
		views: args.reviewSet.views.map((view) =>
			selected.has(view.id) ? { ...view, visibilityPolicyId: args.policyId } : view
		)
	};
	return decodeReviewSet(candidate).pipe(
		Effect.mapError((cause) => invalidAssignment(String(cause), args.policyId, args.viewIds))
	);
}

export function inspectReviewVisibilityPoliciesAtPath(
	path: string
): Effect.Effect<ReviewVisibilityPolicyInspection, ReviewStorageError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) =>
		repository.loadSet(path).pipe(Effect.map(inspectReviewVisibilityPolicies))
	);
}

export function replaceViewVisibilityPolicyAtPath(args: {
	readonly path: string;
	readonly policy: VisibilityPolicy;
	readonly viewId: ReviewViewIdType;
	readonly visibilityOverrides?: VisibilityOverrides | undefined;
}): Effect.Effect<ReviewSet, ReviewStorageError | ReviewVisibilityPolicyError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) =>
		repository.loadSet(args.path).pipe(
			Effect.flatMap((reviewSet) => replaceViewVisibilityPolicy({ ...args, reviewSet })),
			Effect.tap((reviewSet) => repository.saveSet({ path: args.path, reviewSet }))
		)
	);
}

export function applyVisibilityPolicyToViewsAtPath(args: {
	readonly path: string;
	readonly policyId: VisibilityPolicyIdType;
	readonly viewIds: ReadonlyArray<ReviewViewIdType>;
}): Effect.Effect<ReviewSet, ReviewStorageError | ReviewVisibilityPolicyError, ReviewRepository> {
	return Effect.flatMap(ReviewRepository, (repository) =>
		repository.loadSet(args.path).pipe(
			Effect.flatMap((reviewSet) => applyVisibilityPolicyToViews({ ...args, reviewSet })),
			Effect.tap((reviewSet) => repository.saveSet({ path: args.path, reviewSet }))
		)
	);
}

export const makeReviewViewId = ReviewViewId.make;
export const makeVisibilityPolicyId = VisibilityPolicyId.make;
