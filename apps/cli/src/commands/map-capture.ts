import { Argument, Command, Flag } from "effect/cli";
import { nonNegativeIntegerFlag, optionalFlag, optionalValue } from "./options.js";
import { lazyWorkflow } from "../lazy-workflows.js";

const runMapCaptureSelection = lazyWorkflow(
	() => import("../workflows/map-capture.js"),
	(module) => module.runMapCaptureSelection
);
const runMapCaptureReadiness = lazyWorkflow(
	() => import("../workflows/map-capture.js"),
	(module) => module.runMapCaptureReadiness
);
const runMapCapturePlanFromSelection = lazyWorkflow(
	() => import("../workflows/map-capture.js"),
	(module) => module.runMapCapturePlanFromSelection
);
const runMapCaptureInspect = lazyWorkflow(
	() => import("../workflows/map-capture.js"),
	(module) => module.runMapCaptureInspect
);
const runMapCapturePlanValidate = lazyWorkflow(
	() => import("../workflows/map-capture.js"),
	(module) => module.runMapCapturePlanValidate
);
const runMapCaptureRun = lazyWorkflow(
	() => import("../workflows/map-capture.js"),
	(module) => module.runMapCaptureRun
);
const runMapCaptureRuns = lazyWorkflow(
	() => import("../workflows/map-capture.js"),
	(module) => module.runMapCaptureRuns
);

const mapCapturePlanValidateCommand = Command.make(
	"validate",
	{
		projectRoot: Argument.String("project-root"),
		planPath: Argument.String("plan")
	},
	({ projectRoot, planPath }) =>
		runMapCapturePlanValidate({
			_tag: "MapCapturePlanValidate",
			planPath,
			projectRoot
		})
).pipe(Command.withDescription("Validate an external Map Capture Plan."));

const mapCaptureInspectCommand = Command.make(
	"inspect",
	{
		projectRoot: Argument.String("project-root"),
		planPath: Argument.String("plan")
	},
	({ projectRoot, planPath }) =>
		runMapCaptureInspect({ _tag: "MapCaptureInspect", planPath, projectRoot })
).pipe(Command.withDescription("Inspect snapped bounds, levels, and deterministic tile counts."));

const levelsFlag = Flag.atMost(
	nonNegativeIntegerFlag("level", "Map capture levels must be non-negative integers."),
	24
);

const mapCaptureRunCommand = Command.make(
	"run",
	{
		projectRoot: Argument.String("project-root"),
		planPath: Argument.String("plan"),
		endpoint: Argument.String("endpoint"),
		correlationId: optionalFlag("correlation"),
		captureBackend: Flag.Literals("backend", [
			"lit_camera_tiles",
			"scene_capture_tiles",
			"viewport_high_resolution"
		]).pipe(Flag.optional),
		openMap: Flag.Boolean("open-map").pipe(Flag.optional),
		levels: levelsFlag,
		tilesPath: optionalFlag("tiles")
	},
	({
		projectRoot,
		planPath,
		endpoint,
		correlationId,
		captureBackend,
		openMap,
		levels,
		tilesPath
	}) => {
		const backend = optionalValue(captureBackend);
		const correlation = optionalValue(correlationId);
		const shouldOpenMap = optionalValue(openMap);
		const tiles = optionalValue(tilesPath);
		return runMapCaptureRun({
			_tag: "MapCaptureRun",
			...(backend === undefined ? undefined : { captureBackend: backend }),
			...(correlation === undefined ? undefined : { correlationId: correlation }),
			endpoint,
			...(shouldOpenMap === undefined ? undefined : { openMap: shouldOpenMap }),
			...(levels.length === 0 ? undefined : { levels }),
			planPath,
			projectRoot,
			...(tiles === undefined ? undefined : { tilesPath: tiles })
		});
	}
).pipe(
	Command.withDescription(
		"Capture all tiles, repeated --level subsets, or explicit tiles; --open-map safely switches first."
	)
);

const mapCaptureRunsCommand = Command.make(
	"runs",
	{
		projectRoot: Argument.String("project-root"),
		planId: Argument.String("plan-id")
	},
	({ projectRoot, planId }) => runMapCaptureRuns({ _tag: "MapCaptureRuns", planId, projectRoot })
).pipe(Command.withDescription("List only atomically completed runs for one plan."));

export const mapCaptureCommand = Command.make("map-capture").pipe(
	Command.withDescription("Capture generic top-down orthographic tile pyramids."),
	Command.withSubcommands([
		Command.make("plan").pipe(
			Command.withDescription("Validate external map-capture definitions."),
			Command.withSubcommands([
				mapCapturePlanValidateCommand,
				Command.make(
					"from-selection",
					{
						projectRoot: Argument.String("project-root"),
						endpoint: Argument.String("endpoint"),
						output: Argument.String("output")
					},
					({ projectRoot, endpoint, output }) =>
						runMapCapturePlanFromSelection(projectRoot, endpoint, output)
				).pipe(
					Command.withDescription(
						"Create a plan around selected editor actors with ten percent padding."
					)
				)
			])
		),
		Command.make("selection", { endpoint: Argument.String("endpoint") }, ({ endpoint }) =>
			runMapCaptureSelection(endpoint)
		).pipe(Command.withDescription("Inspect combined bounds of selected editor actors.")),
		Command.make(
			"readiness",
			{ endpoint: Argument.String("endpoint"), mapPath: Argument.String("map-path") },
			({ endpoint, mapPath }) => runMapCaptureReadiness(endpoint, mapPath)
		).pipe(Command.withDescription("Inspect Lit capture blockers without starting capture.")),
		mapCaptureInspectCommand,
		mapCaptureRunCommand,
		mapCaptureRunsCommand
	])
);
