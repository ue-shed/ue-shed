import { Argument, Command, Flag } from "effect/unstable/cli";
import { runNiagaraPreview } from "../workflows/niagara.js";
import { optionalFlag, optionalValue, positiveIntegerFlag } from "./options.js";

function optionalNumber(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value);
}

const preview = Command.make(
	"preview",
	{
		background: Flag.choice("background", ["default", "dark", "light"]).pipe(Flag.optional),
		profile: Flag.choice("profile", [
			"ground_impact",
			"projectile",
			"aura",
			"environment"
		]).pipe(Flag.optional),
		renderMode: Flag.choice("render-mode", ["transparent", "scene"]).pipe(Flag.optional),
		cameraMode: Flag.choice("camera-mode", ["saved", "auto_fit"]).pipe(Flag.optional),
		exposureCompensation: optionalFlag("exposure"),
		cameraPadding: optionalFlag("camera-padding"),
		projectDescriptor: Argument.string("project"),
		systemObjectPath: Argument.string("system"),
		captureMode: Flag.choice("capture-mode", ["component_only", "full_scene"]).pipe(
			Flag.optional
		),
		durationSeconds: optionalFlag("duration"),
		engineRoot: optionalFlag("engine-root"),
		frameCount: positiveIntegerFlag("frames", "--frames requires a positive integer").pipe(
			Flag.optional
		),
		height: positiveIntegerFlag("height", "--height requires a positive integer").pipe(
			Flag.optional
		),
		outputRoot: optionalFlag("output-root"),
		pluginDescriptor: optionalFlag("plugin"),
		runId: optionalFlag("run-id"),
		simulationFramesPerSecond: positiveIntegerFlag(
			"simulation-fps",
			"--simulation-fps requires a positive integer"
		).pipe(Flag.optional),
		startSeconds: optionalFlag("start"),
		width: positiveIntegerFlag("width", "--width requires a positive integer").pipe(
			Flag.optional
		)
	},
	({
		background,
		profile,
		renderMode,
		cameraMode,
		exposureCompensation,
		cameraPadding,
		captureMode,
		durationSeconds,
		engineRoot,
		frameCount,
		height,
		outputRoot,
		pluginDescriptor,
		projectDescriptor,
		runId,
		simulationFramesPerSecond,
		startSeconds,
		systemObjectPath,
		width
	}) => {
		const selectedProfile = optionalValue(profile);
		const selectedBackground = optionalValue(background);
		const render = optionalValue(renderMode);
		const camera = optionalValue(cameraMode);
		const exposure = optionalNumber(optionalValue(exposureCompensation));
		const padding = optionalNumber(optionalValue(cameraPadding));
		const capture = optionalValue(captureMode);
		const duration = optionalNumber(optionalValue(durationSeconds));
		const engine = optionalValue(engineRoot);
		const frames = optionalValue(frameCount);
		const selectedHeight = optionalValue(height);
		const output = optionalValue(outputRoot);
		const plugin = optionalValue(pluginDescriptor);
		const selectedRunId = optionalValue(runId);
		const simulationRate = optionalValue(simulationFramesPerSecond);
		const start = optionalNumber(optionalValue(startSeconds));
		const selectedWidth = optionalValue(width);
		return runNiagaraPreview({
			_tag: "NiagaraPreview",
			...(selectedProfile === undefined ? undefined : { profile: selectedProfile }),
			...(selectedBackground === undefined ? undefined : { background: selectedBackground }),
			...(render === undefined ? undefined : { renderMode: render }),
			...(camera === undefined ? undefined : { cameraMode: camera }),
			...(exposure === undefined ? undefined : { exposureCompensation: exposure }),
			...(padding === undefined ? undefined : { cameraPadding: padding }),
			...(capture === undefined ? undefined : { captureMode: capture }),
			...(duration === undefined ? undefined : { durationSeconds: duration }),
			...(engine === undefined ? undefined : { engineRoot: engine }),
			...(frames === undefined ? undefined : { frameCount: frames }),
			...(selectedHeight === undefined ? undefined : { height: selectedHeight }),
			...(output === undefined ? undefined : { outputRoot: output }),
			...(plugin === undefined ? undefined : { pluginDescriptor: plugin }),
			projectDescriptor,
			...(selectedRunId === undefined ? undefined : { runId: selectedRunId }),
			...(simulationRate === undefined
				? undefined
				: { simulationFramesPerSecond: simulationRate }),
			...(start === undefined ? undefined : { startSeconds: start }),
			systemObjectPath,
			...(selectedWidth === undefined ? undefined : { width: selectedWidth })
		});
	}
).pipe(
	Command.withDescription(
		"Capture a Niagara preview with saved settings or a review profile and publish a portable PNG run."
	)
);

export const niagaraCommand = Command.make("niagara").pipe(
	Command.withDescription("Capture portable Niagara preview evidence."),
	Command.withSubcommands([preview])
);
