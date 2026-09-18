import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { basename, join } from "node:path";
import {
	CaptureProfile,
	CaptureProfileId,
	ReviewSet,
	ReviewSetId,
	ReviewViewId,
	defaultNaturalOnlyVisibilityPolicy,
	type ReviewSelectionResponse
} from "./review-schema.js";
import { DEFAULT_REVIEW_ROOT, ReviewRepository } from "./review-repository.js";

const defaultCaptureProfileId = "default-png-720p";
const initialReviewViewId = "initial-view";

function mapIdentifier(mapPath: string): string {
	const readable = mapPath
		.replaceAll(/[^A-Za-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, 90);
	const hash = createHash("sha256").update(mapPath).digest("hex").slice(0, 12);
	return `map-${readable || "review"}-${hash}`;
}

function mapDisplayName(mapPath: string): string {
	const name = mapPath.split("/").filter(Boolean).at(-1) ?? "Map";
	return `${name} Map Review`;
}

export interface MapReviewBootstrap {
	readonly reviewSet: typeof ReviewSet.Type;
	readonly reviewSetPath: string;
	readonly viewId: typeof ReviewViewId.Type;
}

/**
 * Creates the portable, map-scoped definition held by a first authoring session until an author
 * explicitly keeps a candidate. The empty set is valid, but it is not written before approval.
 */
export function bootstrapMapReviewSet(args: {
	readonly projectRoot: string;
	readonly selection: Extract<ReviewSelectionResponse, { readonly status: "selected" }>;
}): MapReviewBootstrap {
	const id = ReviewSetId.make(mapIdentifier(args.selection.mapPath));
	const projectId = basename(args.projectRoot) || "local-project";
	const captureProfile = CaptureProfile.make({
		id: CaptureProfileId.make(defaultCaptureProfileId),
		imageFormat: "png",
		renderProfile: "full_fidelity",
		resolution: { height: 720, width: 1280 }
	});
	const visibilityPolicy = defaultNaturalOnlyVisibilityPolicy();
	return {
		reviewSet: ReviewSet.make({
			captureProfiles: [captureProfile],
			contract: { name: "ue-shed-review-set", version: { major: 1, minor: 2 } },
			description:
				"Created from the first selected actor. Review Views remain portable and outside the map.",
			displayName: mapDisplayName(args.selection.mapPath),
			id,
			project: { id: projectId, mapPath: args.selection.mapPath },
			views: [],
			visibilityPolicies: [visibilityPolicy]
		}),
		reviewSetPath: join(args.projectRoot, DEFAULT_REVIEW_ROOT, "sets", `${id}.json`),
		viewId: ReviewViewId.make(initialReviewViewId)
	};
}

/** Explicit first-set creation. A fresh identity never overwrites a previously published set. */
export const createMapReviewSet = Effect.fn("CameraReview.createMapReviewSet")(function* (args: {
	readonly projectRoot: string;
	readonly selection: Extract<ReviewSelectionResponse, { readonly status: "selected" }>;
	readonly displayName?: string;
}) {
	const repository = yield* ReviewRepository;
	const bootstrap = bootstrapMapReviewSet(args);
	const id = ReviewSetId.make(`review-${randomUUID()}`);
	const reviewSet = ReviewSet.make({
		...bootstrap.reviewSet,
		id,
		displayName: args.displayName?.trim() || bootstrap.reviewSet.displayName
	});
	const reviewSetPath = join(args.projectRoot, DEFAULT_REVIEW_ROOT, "sets", `${id}.json`);
	yield* repository.saveSet({ path: reviewSetPath, reviewSet });
	return { ...bootstrap, reviewSet, reviewSetPath };
});
