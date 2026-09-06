import { Argument, Command, Flag } from "effect/unstable/cli";
import {
	runMapCaptureInspect,
	runMapCapturePlanValidate,
	runMapCaptureRun,
	runMapCaptureRuns
} from "../workflows/map-capture.js";
import { nonNegativeIntegerFlag, optionalFlag, optionalValue } from "./options.js";

const mapCapturePlanValidateCommand = Command.make(
	"validate",
	{
		projectRoot: Argument.string("project-root"),
		planPath: Argument.string("plan")
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
		projectRoot: Argument.string("project-root"),
		planPath: Argument.string("plan")
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
		projectRoot: Argument.string("project-root"),
		planPath: Argument.string("plan"),
		endpoint: Argument.string("endpoint"),
		correlationId: optionalFlag("correlation"),
		captureBackend: Flag.choice("backend", [
			"lit_camera_tiles",
			"scene_capture_tiles",
			"viewport_high_resolution"
		]).pipe(Flag.optional),
		openMap: Flag.boolean("open-map").pipe(Flag.optional),
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
		projectRoot: Argument.string("project-root"),
		planId: Argument.string("plan-id")
	},
	({ projectRoot, planId }) => runMapCaptureRuns({ _tag: "MapCaptureRuns", planId, projectRoot })
).pipe(Command.withDescription("List only atomically completed runs for one plan."));

export const mapCaptureCommand = Command.make("map-capture").pipe(
	Command.withDescription("Capture generic top-down orthographic tile pyramids."),
	Command.withSubcommands([
		Command.make("plan").pipe(
			Command.withDescription("Validate external map-capture definitions."),
			Command.withSubcommands([mapCapturePlanValidateCommand])
		),
		mapCaptureInspectCommand,
		mapCaptureRunCommand,
		mapCaptureRunsCommand
	])
);
