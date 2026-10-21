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
 * Editor arguments that add process-local Remote Control allowlist rules, which UE 5.8 requires,
 * without replacing the project's own permissions. Each enabled UE Shed plugin ID adds its exact
 * API classes; `additionalClasses` adds a host's own plugin classes the same way. Child classes
 * are never allowed. Earlier engines ignore these settings.
 */
export function unrealRemoteControlPermissions(
	pluginIds: readonly string[],
	additionalClasses: readonly RemoteControlAllowedClass[] = []
): readonly string[] {
	const enabled = new Set(pluginIds);
	const classes = [
		...Object.entries(remoteClasses).flatMap(([id, owned]) => (enabled.has(id) ? owned : [])),
		...additionalClasses
	];
	return [...new Set(classes)].map(
		(classPath) =>
			`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:+CustomAllowedRemoteFunctionCalls=(ClassPath=/Script/${classPath},bAllowChildClasses=False)`
	);
}
