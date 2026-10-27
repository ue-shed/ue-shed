import { Schema } from "effect";

/** Exact API classes exposed by each optional UE Shed plugin; never allow child classes. */
const remoteClasses = {
	UEShedCore: [
		"UEShedCore.UEShedCoreLibrary",
		"UEShedCoreEditor.UEShedEditorWorldControlLibrary",
		"UEShedCoreEditor.UEShedEditorWindowLibrary",
		"UEShedCoreEditor.UEShedEditorResponsivenessLibrary",
		"UEShedCoreEditor.UEShedEditorPlaySessionLibrary",
		"UEShedCoreEditor.UEShedEditorAssetNavigationLibrary"
	],
	UEShedWorld: ["UEShedWorldEditor.UEShedWorldLibrary"],
	UEShedCameras: [
		"UEShedCameras.UEShedCameraLibrary",
		"UEShedCamerasEditor.UEShedCameraReviewLibrary",
		"UEShedCamerasEditor.UEShedCameraRenderingLibrary"
	],
	UEShedCameraAuthoringBridge: ["UEShedCameraAuthoringBridge.UEShedCameraAuthoringBridgeLibrary"],
	UEShedAuthoring: ["UEShedAuthoring.UEShedAuthoringLibrary"],
	UEShedAutomation: ["UEShedAutomation.UEShedAutomationLibrary"],
	UEShedObservatory: ["UEShedObservatoryEditor.UEShedObservatoryLibrary"],
	UEShedAssetAudits: ["UEShedAssetAudits.UEShedAssetAuditsLibrary"],
	UEShedGameText: ["UEShedGameText.UEShedGameTextLibrary"],
	UEShedScenarios: ["UEShedScenariosEditor.UEShedScenarioLibrary"]
};

/**
 * A native class a launch allows Remote Control to call, written `Module.Class` (for example
 * `MyStudioEditor.MyStudioToolsLibrary`) and resolved under `/Script/`. Each part accepts only
 * letters, digits and underscores, so the value is safe on the editor command line.
 */
export const RemoteControlAllowedClass = Schema.NonEmptyString.check(
	Schema.isMaxLength(256),
	Schema.isPattern(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/u)
);
/** A `Module.Class` path that a launch adds to the Remote Control allowlist. */
export type RemoteControlAllowedClass = typeof RemoteControlAllowedClass.Type;

/**
 * One function a launch allows Remote Control to call on an exact class, for engine or project
 * functions whose whole class should stay closed (for example `UnrealEd.EditorActorSubsystem`
 * and `GetAllLevelActors`). The function name accepts only letters, digits and underscores.
 */
export const RemoteControlAllowedFunction = Schema.Struct({
	classPath: RemoteControlAllowedClass,
	functionName: Schema.NonEmptyString.check(
		Schema.isMaxLength(256),
		Schema.isPattern(/^[A-Za-z0-9_]+$/u)
	)
});
/** A single class function that a launch adds to the Remote Control allowlist. */
export type RemoteControlAllowedFunction = typeof RemoteControlAllowedFunction.Type;

const allowRule =
	"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:+CustomAllowedRemoteFunctionCalls=";

/**
 * Editor arguments that add process-local Remote Control allowlist rules, which UE 5.8 requires,
 * without replacing the project's own permissions. Each enabled UE Shed plugin ID adds its exact
 * API classes; `additionalClasses` adds a host's own plugin classes the same way, and
 * `functions` adds single functions. Child classes are never allowed. Earlier engines ignore
 * these settings.
 */
export function unrealRemoteControlPermissions(
	pluginIds: readonly string[],
	additionalClasses: readonly RemoteControlAllowedClass[] = [],
	functions: readonly RemoteControlAllowedFunction[] = []
): readonly string[] {
	const enabled = new Set(pluginIds);
	const classes = [
		...Object.entries(remoteClasses).flatMap(([id, owned]) => (enabled.has(id) ? owned : [])),
		...additionalClasses
	];
	return [
		...new Set([
			...classes.map(
				(classPath) =>
					`${allowRule}(ClassPath=/Script/${classPath},bAllowChildClasses=False)`
			),
			...functions.map(
				({ classPath, functionName }) =>
					`${allowRule}(ClassPath="/Script/${classPath}",FunctionName=("${functionName}"),bAllowChildClasses=False)`
			)
		])
	];
}
