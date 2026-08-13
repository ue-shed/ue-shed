import assert from "node:assert/strict";
import test from "node:test";
import {
	createWorkbenchEnvironment,
	resolveRemoteControlEndpoint,
	unrealRemoteControlLaunchArguments
} from "./workbench-tools.ts";

test("enables every discovered plugin with Unreal's plural plugin switch", () => {
	assert.deepEqual(unrealRemoteControlLaunchArguments(["UEShedCore", "UEShedCameras"], 30_001), [
		"-EnablePlugins=UEShedCore,UEShedCameras,RemoteControl",
		"-RCWebControlEnable",
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=30001",
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlWebSocketServerPort=30002",
		"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:bAutoStartWebServer=True",
		"-NoLiveCoding"
	]);
});

test("honors an explicit Remote Control endpoint", async () => {
	const endpoint = await resolveRemoteControlEndpoint({
		UE_SHED_REMOTE_CONTROL_ENDPOINT: "http://127.0.0.1:30017"
	});
	assert.equal(endpoint, "http://127.0.0.1:30017");
});

test("prefers a live Remote Control server over the next free port", async () => {
	const endpoint = await resolveRemoteControlEndpoint(
		{},
		{
			fetch: async (url) => {
				if (String(url) === "http://127.0.0.1:30001/remote/info") {
					return { ok: true };
				}
				return { ok: false };
			}
		}
	);
	assert.equal(endpoint, "http://127.0.0.1:30001");
});

test("falls back to a free port pair when nothing answers", async () => {
	const endpoint = await resolveRemoteControlEndpoint(
		{},
		{
			fetch: async () => ({ ok: false })
		}
	);
	assert.match(endpoint, /^http:\/\/127\.0\.0\.1:300\d\d$/);
});

test("offers both offline fixture maps only for the fixture preset", async () => {
	const options = { fetch: async () => ({ ok: false }) };
	const fixtureEnvironment = await createWorkbenchEnvironment(
		{ ...process.env, UE_SHED_UASSET_EXECUTABLE: "uasset-test" },
		options
	);
	assert.equal(
		fixtureEnvironment.UE_SHED_SAVED_WORLD_MAPS,
		"Content/Fixture/Offline/L_OfflineWorld.umap;Content/Fixture/Cameras/L_CameraLoad.umap"
	);

	const projectEnvironment = await createWorkbenchEnvironment(
		{
			...process.env,
			UE_SHED_PROJECT_ROOT: "C:/Project",
			UE_SHED_UASSET_EXECUTABLE: "uasset-test"
		},
		options
	);
	assert.equal(projectEnvironment.UE_SHED_SAVED_WORLD_MAPS, undefined);
});
