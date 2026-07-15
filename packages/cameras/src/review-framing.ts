import {
	ApprovedPose,
	FramingCandidate,
	FramingCandidateId,
	type FramingDiagnostic,
	type FramingPreset,
	type ReviewSet,
	type ReviewViewId,
	type SubjectBounds,
	decodeReviewSet
} from "./review-schema.js";

const degrees = 180 / Math.PI;
const radians = Math.PI / 180;
const defaultFieldOfViewDegrees = 60;
const defaultMargin = 0.12;

export interface ReviewSelection {
	readonly actorPath: string;
	readonly bounds: SubjectBounds;
	readonly displayName: string;
	readonly editorView?: typeof ApprovedPose.Type | undefined;
	readonly mapPath: string;
}

interface PresetDefinition {
	readonly displayName: string;
	readonly distanceScale: number;
	readonly elevation: number;
	readonly preset: Exclude<FramingPreset, "editor_view">;
	readonly yawOffsetDegrees?: number;
	readonly worldYawDegrees?: number;
}

const presetDefinitions: readonly PresetDefinition[] = [
	{
		displayName: "Context three-quarter",
		distanceScale: 1.8,
		elevation: 0.5,
		preset: "context_three_quarter",
		yawOffsetDegrees: 42
	},
	{
		displayName: "Facade front",
		distanceScale: 1.25,
		elevation: 0.08,
		preset: "facade_front",
		yawOffsetDegrees: 0
	},
	{
		displayName: "Cardinal north",
		distanceScale: 1.45,
		elevation: 0.18,
		preset: "cardinal_north",
		worldYawDegrees: 90
	},
	{
		displayName: "Cardinal east",
		distanceScale: 1.45,
		elevation: 0.18,
		preset: "cardinal_east",
		worldYawDegrees: 0
	},
	{
		displayName: "Cardinal south",
		distanceScale: 1.45,
		elevation: 0.18,
		preset: "cardinal_south",
		worldYawDegrees: -90
	},
	{
		displayName: "Cardinal west",
		distanceScale: 1.45,
		elevation: 0.18,
		preset: "cardinal_west",
		worldYawDegrees: 180
	}
];

function finiteBounds(bounds: SubjectBounds): boolean {
	return (
		[
			bounds.center.x,
			bounds.center.y,
			bounds.center.z,
			bounds.extent.x,
			bounds.extent.y,
			bounds.extent.z,
			bounds.rotation.pitch,
			bounds.rotation.roll,
			bounds.rotation.yaw
		].every(Number.isFinite) &&
		bounds.extent.x >= 0 &&
		bounds.extent.y >= 0 &&
		bounds.extent.z >= 0
	);
}

function aimAt(args: {
	readonly location: { readonly x: number; readonly y: number; readonly z: number };
	readonly target: { readonly x: number; readonly y: number; readonly z: number };
}) {
	const x = args.target.x - args.location.x;
	const y = args.target.y - args.location.y;
	const z = args.target.z - args.location.z;
	return {
		pitch: Math.atan2(z, Math.hypot(x, y)) * degrees,
		roll: 0,
		yaw: Math.atan2(y, x) * degrees
	};
}

function fitDistance(bounds: SubjectBounds, fieldOfViewDegrees: number, margin: number): number {
	const radius = Math.max(1, Math.hypot(bounds.extent.x, bounds.extent.y, bounds.extent.z));
	const usableFrame = 1 - margin * 2;
	return radius / Math.sin((fieldOfViewDegrees * radians) / 2) / usableFrame;
}

function candidateFromPreset(
	selection: ReviewSelection,
	definition: PresetDefinition
): typeof FramingCandidate.Type {
	const yaw =
		definition.worldYawDegrees ??
		selection.bounds.rotation.yaw + (definition.yawOffsetDegrees ?? 0);
	const distance =
		fitDistance(selection.bounds, defaultFieldOfViewDegrees, defaultMargin) *
		definition.distanceScale;
	const location = {
		x: selection.bounds.center.x + Math.cos(yaw * radians) * distance,
		y: selection.bounds.center.y + Math.sin(yaw * radians) * distance,
		z: selection.bounds.center.z + selection.bounds.extent.z * definition.elevation
	};
	return FramingCandidate.make({
		approvedPose: ApprovedPose.make({
			aspectRatio: "16:9",
			fieldOfViewDegrees: defaultFieldOfViewDegrees,
			location,
			projection: "perspective",
			rotation: aimAt({ location, target: selection.bounds.center })
		}),
		diagnostics: [
			{
				code: "bounds_snapshot",
				message: "Generated from the selected actor bounds captured in this session.",
				severity: "info"
			}
		],
		displayName: definition.displayName,
		id: FramingCandidateId.make(definition.preset),
		recipe: {
			kind: "preset",
			margin: defaultMargin,
			preset: definition.preset,
			subjectBounds: selection.bounds,
			version: 1
		}
	});
}

export function generateFramingCandidates(
	selection: ReviewSelection
): readonly (typeof FramingCandidate.Type)[] {
	if (!finiteBounds(selection.bounds)) return [];
	const generated = presetDefinitions.map((definition) =>
		candidateFromPreset(selection, definition)
	);
	if (!selection.editorView) return generated;
	return [
		...generated,
		FramingCandidate.make({
			approvedPose: selection.editorView,
			diagnostics: [
				{
					code: "bounds_snapshot",
					message: "Uses the active perspective viewport and selected actor bounds.",
					severity: "info"
				}
			],
			displayName: "Current editor view",
			id: FramingCandidateId.make("editor-view"),
			recipe: {
				kind: "preset",
				margin: defaultMargin,
				preset: "editor_view",
				subjectBounds: selection.bounds,
				version: 1
			}
		})
	];
}

function maximumDelta(left: SubjectBounds, right: SubjectBounds): number {
	return Math.max(
		Math.abs(left.center.x - right.center.x),
		Math.abs(left.center.y - right.center.y),
		Math.abs(left.center.z - right.center.z),
		Math.abs(left.extent.x - right.extent.x),
		Math.abs(left.extent.y - right.extent.y),
		Math.abs(left.extent.z - right.extent.z)
	);
}

export function framingDriftDiagnostics(args: {
	readonly approvedBounds: SubjectBounds;
	readonly currentBounds: SubjectBounds;
	readonly tolerance?: number;
}): readonly FramingDiagnostic[] {
	const tolerance = args.tolerance ?? 1;
	if (maximumDelta(args.approvedBounds, args.currentBounds) <= tolerance) return [];
	return [
		{
			code: "subject_bounds_changed",
			message:
				"The subject bounds changed after approval. The Approved Pose was retained; reframe explicitly to move it.",
			severity: "warning"
		}
	];
}

export type ApproveFramingCandidateResult =
	| { readonly status: "approved"; readonly reviewSet: ReviewSet }
	| { readonly status: "view_not_found"; readonly viewId: string };

export function approveFramingCandidate(args: {
	readonly candidate: typeof FramingCandidate.Type;
	readonly manualPose?: typeof ApprovedPose.Type;
	readonly manualReason?: string;
	readonly reviewSet: ReviewSet;
	readonly subject?: ReviewSet["views"][number]["subject"];
	readonly viewId: ReviewViewId;
}): ApproveFramingCandidateResult {
	const index = args.reviewSet.views.findIndex((view) => view.id === args.viewId);
	if (index === -1) return { status: "view_not_found", viewId: args.viewId };
	const manuallyAdjusted = args.manualPose !== undefined;
	const recipe = {
		...args.candidate.recipe,
		...(manuallyAdjusted
			? {
					manualAdjustment: {
						reason: args.manualReason?.trim() || "Adjusted in Map Review authoring"
					}
				}
			: {})
	};
	const diagnostics = [
		...args.candidate.diagnostics,
		...(manuallyAdjusted
			? [
					{
						code: "manual_adjustment" as const,
						message: recipe.manualAdjustment!.reason,
						severity: "info" as const
					}
				]
			: [])
	];
	const views = [...args.reviewSet.views];
	views[index] = {
		...views[index]!,
		approvedPose: args.manualPose ?? args.candidate.approvedPose,
		framingDiagnostics: diagnostics,
		framingRecipe: recipe,
		subject: args.subject ?? views[index]!.subject
	};
	return {
		reviewSet: decodeReviewSet({ ...args.reviewSet, views }),
		status: "approved"
	};
}
