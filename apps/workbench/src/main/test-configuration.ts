import { Layer } from "effect";
import { makeWorkbenchConfigurationLayer } from "./workbench-config.js";
import { makeWorkbenchUnrealConnectionLayer } from "./services/unreal-connection.js";

/** Mirror the host's configuration and selected-target composition in service tests. */
export const makeWorkbenchTestConfigurationLayer = (
	configuration: Parameters<typeof makeWorkbenchConfigurationLayer>[0]
) =>
	Layer.merge(
		makeWorkbenchConfigurationLayer(configuration),
		makeWorkbenchUnrealConnectionLayer(configuration.remoteControlEndpoint)
	);
