// The names other packages and apps use (Plan 058 D13). A new module stays private until a
// consumer needs it and it is listed here; `node scripts/measure-package-exports.ts host`
// shows which listed names are used.
export {
	AuthoringClientLive,
	ShedAuthoring,
	ShedAuthoringLive,
	makeShedAuthoringTestLayer,
	sessionView
} from "./authoring.js";
export type { ShedAuthoringApi } from "./authoring.js";
export { ShedHostConfiguration, shedHostConfigurationLayer } from "./configuration.js";
export {
	AuthoringFilePicker,
	AuthoringFilePickerCancelled,
	AuthoringFilePickerError
} from "./file-picker.js";
export { SavedTableIndex } from "./saved-table-index.js";
export { ShedHostLive } from "./live.js";
