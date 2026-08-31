import { Schema } from "effect";

export const WorkbenchRecentProject = Schema.Struct({
	projectName: Schema.NonEmptyString,
	projectRoot: Schema.NonEmptyString
});
export interface WorkbenchRecentProject extends Schema.Schema.Type<typeof WorkbenchRecentProject> {}

export const WorkbenchRecentProjects = Schema.Array(WorkbenchRecentProject);

export const WorkbenchProjectSummary = Schema.Struct({
	/** The Project Index can expose summary/maps before the Input Atlas projection is loaded. */
	inputAtlas: Schema.Literals(["deferred", "ready", "failed"]),
	mapCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	packageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	projectName: Schema.NonEmptyString,
	projectRoot: Schema.NonEmptyString
});
export interface WorkbenchProjectSummary extends Schema.Schema.Type<
	typeof WorkbenchProjectSummary
> {}

export const WorkbenchProjectFailure = Schema.Struct({
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString
});
export interface WorkbenchProjectFailure extends Schema.Schema.Type<
	typeof WorkbenchProjectFailure
> {}

/** A bounded Workbench operation whose completed count comes from the underlying scanner. */
export const WorkbenchTaskProgress = Schema.Struct({
	cacheHits: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	completed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	phase: Schema.Literals(["idle", "enumerating", "scanning", "ready", "failed"]),
	stage: Schema.Literals(["project_index", "texture_audit", "game_text"]),
	total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export interface WorkbenchTaskProgress extends Schema.Schema.Type<typeof WorkbenchTaskProgress> {}

/** The selected Workbench project and its cached, header-first package inventory. */
export const WorkbenchProjectState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ error: WorkbenchProjectFailure, status: Schema.Literal("failed") }),
	Schema.Struct({ project: WorkbenchProjectSummary, status: Schema.Literal("ready") })
]);
export type WorkbenchProjectState = Schema.Schema.Type<typeof WorkbenchProjectState>;

/** Explicit editor launch behavior for the currently selected offline project. */
export const ProjectLaunchMode = Schema.Literals(["ue_shed", "normal"]);
export type ProjectLaunchMode = Schema.Schema.Type<typeof ProjectLaunchMode>;

export const ProjectLaunchResult = Schema.Union([
	Schema.Struct({ mode: ProjectLaunchMode, status: Schema.Literal("launched") }),
	Schema.Struct({
		message: Schema.NonEmptyString,
		recovery: Schema.NonEmptyString,
		status: Schema.Literal("failed")
	})
]);
export type ProjectLaunchResult = Schema.Schema.Type<typeof ProjectLaunchResult>;
