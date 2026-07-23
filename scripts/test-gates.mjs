const gates = [
	{
		file: "packages/engine-discovery/src/real-unreal.integration.test.ts",
		name: "real Unreal editor play-session lifecycle",
		missing: (environment) =>
			environment.UE_SHED_UNREAL_PLAY_SESSION_INTEGRATION === "1" &&
			environment.UE_SHED_REMOTE_CONTROL_ENDPOINT
				? undefined
				: "set UE_SHED_UNREAL_PLAY_SESSION_INTEGRATION=1 and UE_SHED_REMOTE_CONTROL_ENDPOINT"
	},
	{
		file: "packages/unreal-connection/src/real-unreal.integration.test.ts",
		name: "real Unreal Remote Control authoring",
		missing: (environment) =>
			environment.UE_SHED_REMOTE_CONTROL_ENDPOINT
				? undefined
				: "set UE_SHED_REMOTE_CONTROL_ENDPOINT"
	},
	{
		file: "packages/unreal-assets/src/commandlet-conformance.integration.test.ts",
		name: "real Unreal commandlet UAsset conformance",
		missing: (environment) =>
			environment.UE_SHED_UNREAL_EVIDENCE_DIR
				? undefined
				: "set UE_SHED_UNREAL_EVIDENCE_DIR or run pnpm test:uasset-conformance"
	},
	{
		file: "packages/unreal-assets/src/live-parity.integration.test.ts",
		name: "saved and live authoring parity",
		missing: (environment) =>
			environment.UE_SHED_LIVE_SNAPSHOT_DIR ? undefined : "set UE_SHED_LIVE_SNAPSHOT_DIR"
	},
	{
		file: "packages/authoring/src/unreal-mutation.integration.test.ts",
		name: "real Unreal authoring mutation",
		missing: (environment) =>
			environment.UE_SHED_UNREAL_INTEGRATION === "1"
				? undefined
				: "set UE_SHED_UNREAL_INTEGRATION=1 or run pnpm test:unreal-authoring"
	},
	{
		file: "packages/cameras/src/review-unreal.integration.test.ts",
		name: "real Unreal durable review capture",
		missing: (environment) =>
			environment.UE_SHED_REMOTE_CONTROL_ENDPOINT
				? undefined
				: "set UE_SHED_REMOTE_CONTROL_ENDPOINT with the fixture map open"
	},
	{
		file: "packages/observatory/src/real-unreal.integration.test.ts",
		name: "real Unreal Observatory actor observation stream",
		missing: (environment) =>
			environment.UE_SHED_REMOTE_CONTROL_ENDPOINT
				? undefined
				: "set UE_SHED_REMOTE_CONTROL_ENDPOINT with the fixture map open"
	}
];

function selectedGates(arguments_) {
	if (arguments_.includes("component")) return [];
	const explicitTests = arguments_.filter((argument) =>
		/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(argument)
	);
	return explicitTests.length === 0
		? gates
		: gates.filter((gate) => explicitTests.some((test) => gate.file.endsWith(test)));
}

export function reportUnrealTestGates(environment, arguments_ = []) {
	const selected = selectedGates(arguments_);
	if (selected.length === 0) return;
	process.stdout.write("\nUnreal integration test gates:\n");
	for (const gate of selected) {
		const missing = gate.missing(environment);
		process.stdout.write(
			`  ${missing ? "SKIP" : "RUN "} ${gate.name} (${gate.file})${missing ? ` — ${missing}` : ""}\n`
		);
	}
	process.stdout.write("\n");
}
