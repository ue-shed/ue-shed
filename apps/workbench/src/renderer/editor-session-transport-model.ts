import type { EditorPlaySessionCommand, EditorPlaySessionMode } from "@ue-shed/protocol";

export type EditorSessionTransportState =
	| { readonly status: "offline" }
	| { readonly status: "stopped" }
	| {
			readonly status: "starting" | "running" | "paused" | "stopping";
			readonly mode: EditorPlaySessionMode;
	  };

export interface TransportAction {
	readonly command: EditorPlaySessionCommand;
	readonly label: string;
	readonly primary?: boolean;
}

export function parseRemoteControlPort(value: string): number | undefined {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

export function editorSessionTransportActions(
	state: EditorSessionTransportState
): ReadonlyArray<TransportAction> {
	switch (state.status) {
		case "stopped":
			return [
				{ command: "start_play", label: "PLAY", primary: true },
				{ command: "start_simulate", label: "SIM" }
			];
		case "running":
			return [
				{ command: "pause", label: "PAUSE" },
				{ command: "stop", label: "STOP", primary: true }
			];
		case "paused":
			return [
				{ command: "resume", label: "RESUME", primary: true },
				{ command: "stop", label: "STOP" }
			];
		default:
			return [];
	}
}

export function editorSessionTransportLabel(state: EditorSessionTransportState): string {
	if (state.status === "offline") return "EDITOR OFFLINE";
	if (state.status === "stopped") return "EDITOR READY";
	return `${state.mode === "play" ? "PIE" : "SIE"} ${state.status.toUpperCase()}`;
}
