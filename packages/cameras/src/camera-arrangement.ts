import { CameraRenderPolicy } from "./camera-render-schema.js";
import { Schema } from "effect";
import {
	CameraActorEntry,
	CameraVisibilityList,
	CameraVisibilityOutput,
	cameraActorIdentity,
	mergeCameraVisibility
} from "./camera-visibility.js";
import {
	ApprovedPose,
	ReviewSetId,
	subjectLocatorFromSelection,
	defaultNaturalOnlyVisibilityPolicy,
	type ReviewSelectionResponse,
	SubjectBounds,
	SubjectLocator,
	ReviewSet,
	ReviewView,
	ReviewViewId,
	CaptureProfileId,
	VisibilityPolicyId,
	type ReviewAuthoringSession,
	initialReviewViewRevision,
	nextReviewViewRevision
} from "./review-schema.js";

const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u));
export const CameraArrangementId = Identifier.pipe(Schema.brand("CameraArrangementId"));
export const ArrangementCameraId = Identifier.pipe(Schema.brand("ArrangementCameraId"));
export type ArrangementCameraId = typeof ArrangementCameraId.Type;
export const CameraOperationId = Identifier.pipe(Schema.brand("CameraOperationId"));
const Revision = Schema.Int.check(
	Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
);
const FOV = Schema.Finite.check(Schema.isBetween({ minimum: 5, maximum: 170 }));
const Scale = Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 100 }));
const Margin = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.45 }));
const Vector = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, z: Schema.Finite });
export const CameraArrangementSettings = Schema.Struct({
	fieldOfViewDegrees: FOV,
	distanceScale: Scale,
	heightOffset: Schema.Finite,
	margin: Margin,
	elevationDegrees: Schema.optionalKey(
		Schema.Finite.check(Schema.isBetween({ minimum: -89, maximum: 89 }))
	),
	yawOffset: Schema.optionalKey(Schema.Finite),
	aimOffset: Schema.optionalKey(Vector)
});
export const CameraArrangementOverrides = CameraArrangementSettings.mapFields((fields) => ({
	fieldOfViewDegrees: Schema.optionalKey(fields.fieldOfViewDegrees),
	distanceScale: Schema.optionalKey(fields.distanceScale),
	heightOffset: Schema.optionalKey(fields.heightOffset),
	margin: Schema.optionalKey(fields.margin),
	elevationDegrees: fields.elevationDegrees,
	yawOffset: fields.yawOffset,
	aimOffset: fields.aimOffset
}));
export const CameraArrangementGroup = Schema.Struct({
	id: Identifier,
	name: Schema.NonEmptyString,
	overrides: CameraArrangementOverrides,
	visibility: Schema.optionalKey(CameraVisibilityList)
});
export const CameraLayout = Schema.Struct({
	kind: Schema.Literals(["single", "orbit", "arc"]),
	count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
	startDegrees: Schema.Finite,
	spanDegrees: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 360 })),
	orientation: Schema.Literals(["world", "subject"])
});
export type CameraLayout = typeof CameraLayout.Type;
export const ArrangementCamera = Schema.Struct({
	id: ArrangementCameraId,
	displayName: Schema.NonEmptyString,
	yawDegrees: Schema.Finite,
	overrides: CameraArrangementOverrides,
	manualPose: Schema.optionalKey(ApprovedPose),
	viewId: ReviewViewId,
	groupId: Schema.optionalKey(Identifier),
	visibility: Schema.optionalKey(CameraVisibilityList)
});
export type ArrangementCamera = typeof ArrangementCamera.Type;
export const CameraArrangement = Schema.Struct({
	version: Schema.Literal(1),
	id: CameraArrangementId,
	revision: Revision,
	projectName: Schema.NonEmptyString,
	mapPath: Schema.NonEmptyString,
	subject: SubjectLocator,
	bounds: SubjectBounds,
	settings: CameraArrangementSettings,
	cameras: Schema.Array(ArrangementCamera).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	retiredCameraIds: Schema.Array(ArrangementCameraId),
	captureProfileId: CaptureProfileId,
	visibilityPolicyId: VisibilityPolicyId,
	displayName: Schema.optionalKey(Schema.NonEmptyString),
	groups: Schema.optionalKey(Schema.Array(CameraArrangementGroup).check(Schema.isMaxLength(64))),
	visibility: Schema.optionalKey(CameraVisibilityList),
	output: Schema.optionalKey(CameraVisibilityOutput),
	renderPolicy: Schema.optionalKey(CameraRenderPolicy)
}).check(
	Schema.makeFilter((value) => {
		const ids = value.cameras.map((camera) => camera.id);
		if (new Set(ids).size !== ids.length) return "Camera identities must be unique.";
		if (new Set(value.cameras.map((camera) => camera.viewId)).size !== ids.length)
			return "View identities must be unique.";
		if (ids.some((id) => value.retiredCameraIds.includes(id)))
			return "Retired identities cannot be reused.";
		const groups = value.groups ?? [];
		if (new Set(groups.map((group) => group.id)).size !== groups.length)
			return "Group identities must be unique.";
		if (
			value.cameras.some(
				(camera) => camera.groupId && !groups.some((group) => group.id === camera.groupId)
			)
		)
			return "Camera references a missing group.";
		return undefined;
	})
);
export type CameraArrangement = typeof CameraArrangement.Type;

export function effectiveCameraArrangementSettings(
	arrangement: CameraArrangement,
	camera: ArrangementCamera
) {
	return {
		...arrangement.settings,
		...arrangement.groups?.find((group) => group.id === camera.groupId)?.overrides,
		...camera.overrides
	};
}
export function effectiveCameraArrangementVisibility(
	arrangement: CameraArrangement,
	camera: ArrangementCamera
) {
	const result = mergeCameraVisibility(
		arrangement.visibility,
		arrangement.groups?.find((group) => group.id === camera.groupId)?.visibility,
		camera.visibility
	);
	return result.hide.length
		? mergeCameraVisibility(result, {
				hide: [],
				protect: [
					{
						label: "Capture subject",
						locator:
							arrangement.subject.kind === "actor_guid"
								? {
										kind: "actor_guid",
										actorGuid: arrangement.subject.actorGuid,
										lastKnownActorPath:
											arrangement.subject.lastKnownActorPath ?? ""
									}
								: arrangement.subject
					}
				]
			})
		: result;
}
export function cameraIdsInScope(
	arrangement: CameraArrangement,
	scope: CameraEditScope
): readonly ArrangementCameraId[] {
	if (scope.kind === "arrangement") return arrangement.cameras.map((camera) => camera.id);
	if (scope.kind === "group") {
		if (!arrangement.groups?.some((group) => group.id === scope.groupId))
			throw arrangementFailure("scope_mismatch", "The group is outside this arrangement.");
		return arrangement.cameras
			.filter((camera) => camera.groupId === scope.groupId)
			.map((camera) => camera.id);
	}
	if (
		new Set(scope.cameraIds).size !== scope.cameraIds.length ||
		scope.cameraIds.some((id) => !arrangement.cameras.some((camera) => camera.id === id))
	)
		throw arrangementFailure(
			"scope_mismatch",
			"Select unique cameras from this arrangement only."
		);
	return scope.cameraIds;
}
function isCustomizedCamera(camera: ArrangementCamera) {
	return (
		camera.manualPose !== undefined ||
		Object.keys(camera.overrides).length > 0 ||
		(camera.visibility?.hide.length ?? 0) > 0 ||
		(camera.visibility?.protect.length ?? 0) > 0
	);
}
type EditingCommand = Extract<
	CameraArrangementCommand,
	{
		kind:
			| "batch"
			| "visibility"
			| "edit_visibility"
			| "output"
			| "render_policy"
			| "rename"
			| "group"
			| "add"
			| "duplicate"
			| "remove"
			| "reorder"
			| "nudge";
	}
>;
function applyArrangementEditing(
	current: CameraArrangement,
	command: EditingCommand
): CameraArrangement {
	let cameras = [...current.cameras],
		groups = [...(current.groups ?? [])],
		settings = current.settings;
	let visibility = current.visibility,
		output = current.output,
		retiredCameraIds = current.retiredCameraIds;
	if (command.kind === "render_policy")
		return CameraArrangement.make({
			...current,
			revision: current.revision + 1,
			renderPolicy: command.policy
		});
	if (command.kind === "edit_visibility") {
		const ids = new Set(cameraIdsInScope(current, command.scope));
		const edit = (existing: typeof CameraVisibilityList.Type | undefined) => {
			const entries = new Map(
				(existing?.[command.list] ?? []).map((entry) => [
					cameraActorIdentity(entry.locator),
					entry
				])
			);
			for (const entry of command.entries) {
				const key = cameraActorIdentity(entry.locator);
				if (command.operation === "add") entries.set(key, entry);
				else entries.delete(key);
			}
			return CameraVisibilityList.make({
				hide: existing?.hide ?? [],
				protect: existing?.protect ?? [],
				[command.list]: [...entries.values()]
			});
		};
		if (command.scope.kind === "arrangement") visibility = edit(visibility);
		else if (command.scope.kind === "group") {
			const id = command.scope.groupId;
			groups = groups.map((group) =>
				group.id === id ? { ...group, visibility: edit(group.visibility) } : group
			);
		} else
			cameras = cameras.map((camera) =>
				ids.has(camera.id) ? { ...camera, visibility: edit(camera.visibility) } : camera
			);
	} else if (
		command.kind === "batch" ||
		command.kind === "visibility" ||
		command.kind === "nudge"
	) {
		const ids = new Set(cameraIdsInScope(current, command.scope));
		if (command.kind === "batch") {
			const patch = (value: typeof CameraArrangementOverrides.Type) => {
				const next = { ...value, ...command.settings };
				for (const key of command.resetFields) delete next[key];
				return next;
			};
			if (command.scope.kind === "arrangement") {
				if (command.resetFields.length)
					throw arrangementFailure(
						"invalid",
						"Arrangement defaults cannot inherit. Reset group or camera overrides instead."
					);
				settings = CameraArrangementSettings.make({ ...settings, ...command.settings });
			} else if (command.scope.kind === "group") {
				const groupId = command.scope.groupId;
				groups = groups.map((group) =>
					group.id === groupId ? { ...group, overrides: patch(group.overrides) } : group
				);
			} else
				cameras = cameras.map((camera) =>
					ids.has(camera.id) ? { ...camera, overrides: patch(camera.overrides) } : camera
				);
		} else if (command.kind === "visibility") {
			if (command.scope.kind === "arrangement") visibility = command.visibility;
			else if (command.scope.kind === "group") {
				const groupId = command.scope.groupId;
				groups = groups.map((group) =>
					group.id === groupId ? { ...group, visibility: command.visibility } : group
				);
			} else
				cameras = cameras.map((camera) =>
					ids.has(camera.id) ? { ...camera, visibility: command.visibility } : camera
				);
		} else
			cameras = cameras.map((camera) => {
				if (!ids.has(camera.id)) return camera;
				const pose = resolveArrangementCamera(current, camera.id),
					yaw = (pose.rotation.yaw * Math.PI) / 180,
					pitch = (pose.rotation.pitch * Math.PI) / 180;
				return {
					...camera,
					manualPose: {
						...pose,
						location: {
							x:
								pose.location.x +
								command.translation.x +
								command.dolly * Math.cos(pitch) * Math.cos(yaw),
							y:
								pose.location.y +
								command.translation.y +
								command.dolly * Math.cos(pitch) * Math.sin(yaw),
							z:
								pose.location.z +
								command.translation.z +
								command.dolly * Math.sin(pitch)
						}
					}
				};
			});
	} else if (command.kind === "output") output = command.output;
	else if (command.kind === "rename")
		cameras = cameras.map((camera) =>
			camera.id === command.cameraId
				? { ...camera, displayName: command.displayName }
				: camera
		);
	else if (command.kind === "group") {
		const ids = new Set(
			cameraIdsInScope(current, { kind: "cameras", cameraIds: command.cameraIds })
		);
		groups = [...groups.filter((group) => group.id !== command.group.id), command.group];
		cameras = cameras.map((camera) =>
			ids.has(camera.id) ? { ...camera, groupId: command.group.id } : camera
		);
	} else if (command.kind === "add" || command.kind === "duplicate") {
		const source =
			command.kind === "duplicate"
				? cameras.find((camera) => camera.id === command.cameraId)
				: undefined;
		const added =
			command.kind === "add"
				? command.camera
				: source
					? {
							...source,
							id: command.newCameraId,
							viewId: command.newViewId,
							displayName: `${source.displayName} copy`
						}
					: undefined;
		if (!added) throw arrangementFailure("camera_missing", "The source camera is missing.");
		const after = command.kind === "add" ? command.afterCameraId : command.cameraId;
		const index =
			after === undefined
				? cameras.length - 1
				: cameras.findIndex((camera) => camera.id === after);
		if (index < 0)
			throw arrangementFailure("camera_missing", "The insertion camera is missing.");
		cameras.splice(index + 1, 0, added);
	} else if (command.kind === "remove") {
		const ids = new Set(
			cameraIdsInScope(current, { kind: "cameras", cameraIds: command.cameraIds })
		);
		if (
			cameras.some(
				(camera) =>
					ids.has(camera.id) &&
					isCustomizedCamera(camera) &&
					!command.discardCustomizedIds.includes(camera.id)
			)
		)
			throw arrangementFailure(
				"customization_at_risk",
				"Review and acknowledge removal of customized cameras."
			);
		cameras = cameras.filter((camera) => !ids.has(camera.id));
		retiredCameraIds = [...retiredCameraIds, ...ids];
	} else {
		cameraIdsInScope(current, { kind: "cameras", cameraIds: command.cameraIds });
		if (command.cameraIds.length !== cameras.length)
			throw arrangementFailure("invalid", "Reordering must retain every camera.");
		cameras = command.cameraIds.map((id) => cameras.find((camera) => camera.id === id)!);
	}
	return CameraArrangement.make({
		...current,
		revision: current.revision + 1,
		cameras,
		groups,
		settings,
		retiredCameraIds,
		...(visibility ? { visibility } : undefined),
		...(output ? { output } : undefined)
	});
}

/** Explicit proposal; callers supply fresh identities. Retained IDs retain their overrides on acceptance. */
export function proposeCameraLayout(
	arrangement: CameraArrangement,
	layout: CameraLayout,
	identities: readonly { id: ArrangementCameraId; viewId: typeof ReviewViewId.Type }[]
) {
	const count = layout.kind === "single" ? 1 : layout.count;
	if (identities.length !== count)
		throw arrangementFailure("invalid", "Supply one identity per proposed camera.");
	const cameras = identities.map((identity, index) =>
		ArrangementCamera.make({
			...identity,
			displayName: `${layout.kind} ${index + 1}`,
			overrides: {},
			yawDegrees:
				layout.startDegrees +
				(layout.orientation === "subject" ? arrangement.bounds.rotation.yaw : 0) +
				(layout.kind === "single"
					? 0
					: layout.kind === "orbit"
						? (index * 360) / count
						: count === 1
							? 0
							: (index * layout.spanDegrees) / (count - 1))
		})
	);
	return { cameras, ...previewArrangementRegeneration(arrangement, cameras) };
}

/** Recipes copy camera placement relative to the actor; never carry actor locators or View ownership. */
export const CameraArrangementRecipe = Schema.Struct({
	version: Schema.Literal(1),
	name: Schema.NonEmptyString,
	settings: CameraArrangementSettings,
	groups: Schema.Array(
		CameraArrangementGroup.mapFields((fields) => ({
			id: fields.id,
			name: fields.name,
			overrides: fields.overrides
		}))
	),
	cameras: Schema.Array(
		ArrangementCamera.mapFields((fields) => ({
			displayName: fields.displayName,
			yawDegrees: fields.yawDegrees,
			overrides: fields.overrides,
			groupId: fields.groupId,
			relativePose: fields.manualPose
		}))
	).check(Schema.isMinLength(1), Schema.isMaxLength(256))
});
export type CameraArrangementRecipe = typeof CameraArrangementRecipe.Type;
export function exportCameraArrangementRecipe(
	arrangement: CameraArrangement,
	name: string
): CameraArrangementRecipe {
	return CameraArrangementRecipe.make({
		version: 1,
		name,
		settings: arrangement.settings,
		groups: (arrangement.groups ?? []).map(({ id, name: groupName, overrides }) => ({
			id,
			name: groupName,
			overrides
		})),
		cameras: arrangement.cameras.map((camera) => ({
			displayName: camera.displayName,
			yawDegrees: camera.yawDegrees,
			overrides: camera.overrides,
			...(camera.groupId ? { groupId: camera.groupId } : undefined),
			...(camera.manualPose
				? {
						relativePose: {
							...camera.manualPose,
							location: {
								x: camera.manualPose.location.x - arrangement.bounds.center.x,
								y: camera.manualPose.location.y - arrangement.bounds.center.y,
								z: camera.manualPose.location.z - arrangement.bounds.center.z
							}
						}
					}
				: undefined)
		}))
	});
}
export function importCameraArrangementRecipe(
	arrangement: CameraArrangement,
	recipe: CameraArrangementRecipe,
	identities: readonly { id: ArrangementCameraId; viewId: typeof ReviewViewId.Type }[]
): CameraArrangement {
	if (identities.length !== recipe.cameras.length)
		throw arrangementFailure("invalid", "Supply fresh identities for every recipe camera.");
	return CameraArrangement.make({
		...arrangement,
		settings: recipe.settings,
		groups: recipe.groups,
		cameras: recipe.cameras.map(({ relativePose, ...camera }, index) => ({
			...camera,
			...identities[index]!,
			...(relativePose
				? {
						manualPose: {
							...relativePose,
							location: {
								x: relativePose.location.x + arrangement.bounds.center.x,
								y: relativePose.location.y + arrangement.bounds.center.y,
								z: relativePose.location.z + arrangement.bounds.center.z
							}
						}
					}
				: undefined)
		}))
	});
}

/** Explicit migration: keep every legacy candidate's exact pose rather than regenerate its identity. */
export function migrateLegacyCameraArrangement(args: {
	readonly session: ReviewAuthoringSession;
	readonly id: typeof CameraArrangementId.Type;
	readonly projectName: string;
	readonly captureProfileId: typeof CaptureProfileId.Type;
	readonly visibilityPolicyId: typeof VisibilityPolicyId.Type;
	readonly identities: readonly {
		readonly candidateId: string;
		readonly cameraId: ArrangementCameraId;
		readonly viewId: typeof ReviewViewId.Type;
	}[];
}): CameraArrangement {
	const { session } = args;
	const candidates = session.candidates.filter(
		(candidate) => !session.discardedCandidateIds.includes(candidate.id)
	);
	if (
		args.identities.length !== candidates.length ||
		new Set(args.identities.map((entry) => entry.candidateId)).size !== candidates.length
	)
		throw arrangementFailure(
			"invalid",
			"Provide one explicit stable camera/View identity for each retained legacy candidate."
		);
	const cameras = candidates.map((candidate) => {
		const identity = args.identities.find((entry) => entry.candidateId === candidate.id);
		if (!identity)
			throw arrangementFailure(
				"invalid",
				"A retained legacy candidate is missing its stable identity."
			);
		const pose =
			session.selectedCandidateId === candidate.id && session.draftPose
				? session.draftPose
				: candidate.approvedPose;
		return ArrangementCamera.make({
			id: identity.cameraId,
			viewId: identity.viewId,
			displayName: candidate.displayName,
			yawDegrees: pose.rotation.yaw - 180,
			overrides: { fieldOfViewDegrees: pose.fieldOfViewDegrees },
			manualPose: pose
		});
	});
	return CameraArrangement.make({
		version: 1,
		id: args.id,
		revision: 0,
		projectName: args.projectName,
		mapPath: session.subject.mapPath,
		subject: session.subject.actorGuid
			? {
					kind: "actor_guid",
					actorGuid: session.subject.actorGuid,
					lastKnownActorPath: session.subject.actorPath
				}
			: { kind: "actor_path", actorPath: session.subject.actorPath },
		bounds: session.subject.bounds,
		settings: { fieldOfViewDegrees: 60, distanceScale: 1, heightOffset: 0, margin: 0.12 },
		cameras,
		retiredCameraIds: [],
		captureProfileId: args.captureProfileId,
		visibilityPolicyId: args.visibilityPolicyId
	});
}

const Scope = {
	arrangementId: CameraArrangementId,
	expectedRevision: Revision,
	operationId: CameraOperationId
};
export const CameraEditScope = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("arrangement") }),
	Schema.Struct({ kind: Schema.Literal("group"), groupId: Identifier }),
	Schema.Struct({
		kind: Schema.Literal("cameras"),
		cameraIds: Schema.Array(ArrangementCameraId).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		)
	})
]);
export type CameraEditScope = typeof CameraEditScope.Type;
export const CameraArrangementCommand = Schema.Union([
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("edit_visibility"),
		scope: CameraEditScope,
		list: Schema.Literals(["hide", "protect"]),
		operation: Schema.Literals(["add", "remove"]),
		entries: Schema.Array(CameraActorEntry).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		)
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("batch"),
		scope: CameraEditScope,
		settings: CameraArrangementOverrides,
		resetFields: Schema.Array(
			Schema.Literals([
				"fieldOfViewDegrees",
				"distanceScale",
				"heightOffset",
				"margin",
				"elevationDegrees",
				"yawOffset",
				"aimOffset"
			])
		)
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("visibility"),
		scope: CameraEditScope,
		visibility: CameraVisibilityList
	}),
	Schema.Struct({ ...Scope, kind: Schema.Literal("output"), output: CameraVisibilityOutput }),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("render_policy"),
		policy: CameraRenderPolicy.check(
			Schema.makeFilter((policy) =>
				policy.visibility
					? "Use scoped visibility instead of render policy exclusions."
					: undefined
			)
		)
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("rename"),
		cameraId: ArrangementCameraId,
		displayName: Schema.NonEmptyString
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("group"),
		group: CameraArrangementGroup,
		cameraIds: Schema.Array(ArrangementCameraId).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		)
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("add"),
		camera: ArrangementCamera,
		afterCameraId: Schema.optionalKey(ArrangementCameraId)
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("duplicate"),
		cameraId: ArrangementCameraId,
		newCameraId: ArrangementCameraId,
		newViewId: ReviewViewId
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("remove"),
		cameraIds: Schema.Array(ArrangementCameraId).check(Schema.isMinLength(1)),
		discardCustomizedIds: Schema.Array(ArrangementCameraId)
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("reorder"),
		cameraIds: Schema.Array(ArrangementCameraId).check(Schema.isMinLength(1))
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("nudge"),
		scope: CameraEditScope,
		translation: Vector,
		dolly: Schema.Finite
	}),
	Schema.Struct({ ...Scope, kind: Schema.Literal("tune"), settings: CameraArrangementOverrides }),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("override"),
		cameraId: ArrangementCameraId,
		overrides: CameraArrangementOverrides
	}),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("pose"),
		cameraId: ArrangementCameraId,
		pose: ApprovedPose,
		lensChanged: Schema.Boolean,
		poseChanged: Schema.Boolean
	}),
	Schema.Struct({ ...Scope, kind: Schema.Literal("unpin"), cameraId: ArrangementCameraId }),
	Schema.Struct({
		...Scope,
		kind: Schema.Literal("regenerate"),
		settings: Schema.optionalKey(CameraArrangementSettings),
		groups: Schema.optionalKey(Schema.Array(CameraArrangementGroup)),
		cameras: Schema.Array(ArrangementCamera).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(256)
		),
		discardCustomizedIds: Schema.Array(ArrangementCameraId)
	})
]);
export type CameraArrangementCommand = typeof CameraArrangementCommand.Type;
export class CameraArrangementError extends Schema.TaggedErrorClass<CameraArrangementError>()(
	"CameraArrangementError",
	{
		code: Schema.Literals([
			"stale",
			"scope_mismatch",
			"camera_missing",
			"customization_at_risk",
			"invalid",
			"busy",
			"storage",
			"operation_reused"
		]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}
export function arrangementFailure(
	code: (typeof CameraArrangementError.Type)["code"],
	message: string
) {
	return new CameraArrangementError({
		code,
		message,
		recovery:
			"Inspect the latest arrangement and retry with its revision and an explicit camera scope."
	});
}

/** Aspect-aware sphere fit uses the smaller horizontal/vertical FOV; values are Unreal centimetres. */
export function arrangementFitDistance(
	bounds: typeof SubjectBounds.Type,
	fieldOfViewDegrees: number,
	aspect: number,
	margin: number
) {
	if (!Number.isFinite(aspect) || aspect <= 0)
		throw arrangementFailure("invalid", "Aspect must be positive and finite.");
	const horizontal = (fieldOfViewDegrees * Math.PI) / 360;
	const vertical = Math.atan(Math.tan(horizontal) / aspect);
	return (
		Math.max(1, Math.hypot(bounds.extent.x, bounds.extent.y, bounds.extent.z)) /
		(Math.sin(Math.min(horizontal, vertical)) * (1 - margin * 2))
	);
}
export function resolveArrangementCamera(
	arrangement: CameraArrangement,
	cameraId: string
): typeof ApprovedPose.Type {
	const camera = arrangement.cameras.find((entry) => entry.id === cameraId);
	if (camera === undefined)
		throw arrangementFailure(
			"camera_missing",
			`Camera ${cameraId} does not belong to ${arrangement.id}.`
		);
	const settings = effectiveCameraArrangementSettings(arrangement, camera);
	if (camera.manualPose !== undefined)
		return ApprovedPose.make({
			...camera.manualPose,
			fieldOfViewDegrees: settings.fieldOfViewDegrees
		});
	const distance =
		arrangementFitDistance(
			arrangement.bounds,
			settings.fieldOfViewDegrees,
			16 / 9,
			settings.margin
		) * settings.distanceScale;
	const yawDegrees = camera.yawDegrees + (settings.yawOffset ?? 0);
	const yaw = (yawDegrees * Math.PI) / 180;
	const elevation = ((settings.elevationDegrees ?? 0) * Math.PI) / 180;
	const aim = settings.aimOffset ?? { x: 0, y: 0, z: 0 };
	const horizontalDistance = distance * Math.cos(elevation);
	const height = distance * Math.sin(elevation) + settings.heightOffset;
	const location = {
		x: arrangement.bounds.center.x + aim.x + Math.cos(yaw) * horizontalDistance,
		y: arrangement.bounds.center.y + aim.y + Math.sin(yaw) * horizontalDistance,
		z: arrangement.bounds.center.z + aim.z + height
	};
	return ApprovedPose.make({
		aspectRatio: "16:9",
		projection: "perspective",
		fieldOfViewDegrees: settings.fieldOfViewDegrees,
		location,
		rotation: {
			pitch: (-Math.atan2(height, horizontalDistance) * 180) / Math.PI || 0,
			yaw: yawDegrees + 180,
			roll: 0
		}
	});
}
export function previewArrangementRegeneration(
	arrangement: CameraArrangement,
	cameras: readonly ArrangementCamera[]
) {
	const retained = new Set(cameras.map((camera) => camera.id));
	return {
		removed: arrangement.cameras
			.filter((camera) => !retained.has(camera.id))
			.map((camera) => camera.id),
		customized: arrangement.cameras
			.filter((camera) => !retained.has(camera.id) && isCustomizedCamera(camera))
			.map((camera) => camera.id),
		added: cameras
			.filter((camera) => !arrangement.cameras.some((existing) => existing.id === camera.id))
			.map((camera) => camera.id)
	};
}
/** No selection/global state: every mutation is bound to one actor's explicit arrangement revision. */
export function applyCameraArrangementCommand(
	current: CameraArrangement,
	command: CameraArrangementCommand
): CameraArrangement {
	if (command.arrangementId !== current.id)
		throw arrangementFailure("scope_mismatch", "The command targets another arrangement.");
	if (command.expectedRevision !== current.revision)
		throw arrangementFailure(
			"stale",
			"The arrangement changed after this command was authored."
		);
	if ("cameraId" in command && !current.cameras.some((camera) => camera.id === command.cameraId))
		throw arrangementFailure("camera_missing", "The camera is outside this arrangement.");
	if (
		command.kind === "batch" ||
		command.kind === "visibility" ||
		command.kind === "edit_visibility" ||
		command.kind === "output" ||
		command.kind === "render_policy" ||
		command.kind === "rename" ||
		command.kind === "group" ||
		command.kind === "add" ||
		command.kind === "duplicate" ||
		command.kind === "remove" ||
		command.kind === "reorder" ||
		command.kind === "nudge"
	)
		return applyArrangementEditing(current, command);
	let cameras = current.cameras;
	let retiredCameraIds = current.retiredCameraIds;
	if (command.kind === "regenerate") {
		const proposal = previewArrangementRegeneration(current, command.cameras);
		if (proposal.customized.some((id) => !command.discardCustomizedIds.includes(id)))
			throw arrangementFailure(
				"customization_at_risk",
				"Explicitly acknowledge removal of customized cameras."
			);
		// A retained identity keeps its exceptions and pinned pose, even if its generated direction changes.
		cameras = command.cameras.map((camera) => {
			const existing = current.cameras.find((entry) => entry.id === camera.id);
			return existing === undefined ? camera : { ...existing, yawDegrees: camera.yawDegrees };
		});
		retiredCameraIds = [...retiredCameraIds, ...proposal.removed];
	} else if (command.kind !== "tune") {
		cameras = current.cameras.map((camera) => {
			if (camera.id !== command.cameraId) return camera;
			if (command.kind === "override") return { ...camera, overrides: command.overrides };
			if (command.kind === "pose")
				return {
					...camera,
					...(command.poseChanged ? { manualPose: command.pose } : undefined),
					overrides: command.lensChanged
						? {
								...camera.overrides,
								fieldOfViewDegrees: command.pose.fieldOfViewDegrees
							}
						: camera.overrides
				};
			const { manualPose: _removed, ...unpinned } = camera;
			return unpinned;
		});
	}
	return CameraArrangement.make({
		...current,
		revision: current.revision + 1,
		settings:
			command.kind === "tune"
				? { ...current.settings, ...command.settings }
				: command.kind === "regenerate"
					? (command.settings ?? current.settings)
					: current.settings,
		...(command.kind === "regenerate" && command.groups
			? { groups: command.groups }
			: undefined),
		cameras,
		retiredCameraIds
	});
}

/** Materialize exact approved poses into the existing capture-only Review Set contract. */
export function approveArrangementCamera(
	arrangement: CameraArrangement,
	cameraId: string,
	set: ReviewSet
): ReviewSet {
	if (set.project.mapPath !== arrangement.mapPath)
		throw arrangementFailure("scope_mismatch", "The Review Set belongs to another map.");
	const camera = arrangement.cameras.find((entry) => entry.id === cameraId);
	if (camera === undefined)
		throw arrangementFailure(
			"camera_missing",
			"The camera does not belong to this arrangement."
		);
	const existing = set.views.find((view) => view.id === camera.viewId);
	if (
		existing?.authoring &&
		(existing.authoring.arrangementId !== arrangement.id ||
			existing.authoring.cameraId !== camera.id)
	)
		throw arrangementFailure(
			"scope_mismatch",
			"The destination View belongs to another camera arrangement."
		);
	if (
		existing &&
		JSON.stringify(existing.target) !==
			JSON.stringify({ kind: "actor", subject: arrangement.subject })
	)
		throw arrangementFailure(
			"scope_mismatch",
			"The destination View belongs to another subject."
		);
	const sourceProfile = set.captureProfiles.find(
		(profile) => profile.id === arrangement.captureProfileId
	);
	if (!sourceProfile) throw arrangementFailure("invalid", "Capture profile is missing.");
	const captureProfileId = arrangement.renderPolicy
		? CaptureProfileId.make(`${camera.viewId}-capture-r${(existing?.revision.number ?? 0) + 1}`)
		: arrangement.captureProfileId;
	const view = ReviewView.make({
		...existing,
		...(arrangement.output !== undefined
			? {
					authoredVisibility: {
						version: 1 as const,
						output: arrangement.output,
						actors: effectiveCameraArrangementVisibility(arrangement, camera)
					}
				}
			: undefined),
		authoring: { arrangementId: arrangement.id, cameraId: camera.id },
		id: camera.viewId,
		displayName: camera.displayName,
		purpose: existing?.purpose ?? "Authored camera",
		tags: existing?.tags ?? [],
		captureProfileId,
		visibilityPolicyId: arrangement.visibilityPolicyId,
		target: { kind: "actor", subject: arrangement.subject },
		viewpoint: {
			kind: "world_fixed",
			approvedPose: resolveArrangementCamera(arrangement, camera.id)
		},
		framingRecipe: { kind: "manual", version: 1 },
		revision: existing
			? nextReviewViewRevision(camera.viewId, existing.revision)
			: initialReviewViewRevision(camera.viewId)
	});
	return ReviewSet.make({
		...set,
		captureProfiles: arrangement.renderPolicy
			? [
					...set.captureProfiles,
					{
						...sourceProfile,
						id: captureProfileId,
						renderPolicy: arrangement.renderPolicy
					}
				]
			: set.captureProfiles,
		contract: {
			name: "ue-shed-review-set",
			version: {
				major: 1,
				minor: arrangement.output !== undefined || set.contract.version.minor === 5 ? 5 : 4
			}
		},
		views: existing
			? set.views.map((entry) => (entry.id === view.id ? view : entry))
			: [...set.views, view]
	});
}

/** A useful single-camera starting point; hosts can present layouts after the actor is attached. */
export function createCameraArrangementFromSelection(args: {
	id: typeof CameraArrangementId.Type;
	projectName: string;
	selection: Extract<ReviewSelectionResponse, { status: "selected" }>;
}) {
	const selected = args.selection,
		policy = defaultNaturalOnlyVisibilityPolicy();
	const captureProfileId = CaptureProfileId.make("capture");
	const arrangement = CameraArrangement.make({
		version: 1,
		id: args.id,
		revision: 0,
		displayName: selected.displayName,
		projectName: args.projectName,
		mapPath: selected.mapPath,
		subject: subjectLocatorFromSelection(selected),
		bounds: selected.bounds,
		settings: {
			fieldOfViewDegrees: 60,
			distanceScale: 1.15,
			heightOffset: 0,
			margin: 0.1,
			elevationDegrees: 15
		},
		cameras: [
			{
				id: ArrangementCameraId.make("camera-1"),
				viewId: ReviewViewId.make(args.id),
				displayName: selected.displayName,
				yawDegrees: 0,
				overrides: {}
			}
		],
		retiredCameraIds: [],
		captureProfileId,
		visibilityPolicyId: policy.id,
		output: "natural_only"
	});
	const reviewSet = ReviewSet.make({
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 5 } },
		id: ReviewSetId.make(args.id),
		displayName: selected.displayName,
		project: { id: args.projectName, mapPath: selected.mapPath },
		captureProfiles: [
			{
				id: captureProfileId,
				imageFormat: "png",
				renderProfile: "full_fidelity",
				resolution: { width: 1280, height: 720 }
			}
		],
		visibilityPolicies: [policy],
		views: []
	});
	return { arrangement, reviewSet };
}
