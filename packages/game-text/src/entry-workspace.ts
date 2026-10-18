// Named exports only. The Game Text workspace a host runs over its selected project (Plan 058 D10).

export { makeGameTextWorkspace, type GameTextWorkspaceApi } from "./workspace.js";
export { makeGameTextIdRepairs, type GameTextIdRepairsHost } from "./workspace-id-repairs.js";
export type {
	GameTextWorkspaceFileChoice,
	GameTextWorkspaceFileFilter,
	GameTextWorkspaceFileHooks,
	GameTextWorkspaceHost,
	GameTextWorkspaceHostFailure,
	GameTextWorkspaceProgress,
	GameTextWorkspaceProject,
	GameTextWorkspaceProjectState
} from "./workspace-host.js";
export { makeGameTextWorkspaceLocalization } from "./workspace-localization.js";
export {
	makeGameTextOperations,
	safeLocalizationLogLine,
	type GameTextOperationsApi,
	type GameTextOperationsHost
} from "./workspace-operations.js";
