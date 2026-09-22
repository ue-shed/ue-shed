/** Exact API classes exposed by each optional UE Shed plugin; never allow child classes. */
const remoteClasses = {
	UEShedCore: [
		"UEShedCore.UEShedCoreLibrary",
		"UEShedCoreEditor.UEShedEditorWorldControlLibrary",
		"UEShedCoreEditor.UEShedEditorWindowLibrary",
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
	UEShedObservatory: ["UEShedObservatoryEditor.UEShedObservatoryLibrary"],
	UEShedAssetAudits: ["UEShedAssetAudits.UEShedAssetAuditsLibrary"],
	UEShedScenarios: ["UEShedScenariosEditor.UEShedScenarioLibrary"]
};

/** UE 5.8 requires an allowlist. Add process-local rules without replacing project permissions. */
export function unrealRemoteControlPermissions(pluginIds: readonly string[]): readonly string[] {
	const enabled = new Set(pluginIds);
	return Object.entries(remoteClasses).flatMap(([id, classes]) =>
		(enabled.has(id) ? classes : []).map(
			(classPath) =>
				`-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:+CustomAllowedRemoteFunctionCalls=(ClassPath=/Script/${classPath},bAllowChildClasses=False)`
		)
	);
}
