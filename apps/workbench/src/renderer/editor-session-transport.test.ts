import { describe, expect, it } from "vitest";
import {
	editorSessionTransportActions,
	editorSessionTransportLabel,
	parseRemoteControlPort
} from "./editor-session-transport-model.js";

describe("editor session transport", () => {
	it("accepts only TCP port numbers", () => {
		expect(parseRemoteControlPort("31001")).toBe(31001);
		expect(parseRemoteControlPort("0")).toBeUndefined();
		expect(parseRemoteControlPort("65536")).toBeUndefined();
		expect(parseRemoteControlPort("30001.5")).toBeUndefined();
		expect(parseRemoteControlPort("not-a-port")).toBeUndefined();
	});

	it("offers start modes only while the editor is stopped", () => {
		expect(
			editorSessionTransportActions({ status: "stopped" }).map(({ command }) => command)
		).toEqual(["start_play", "start_simulate"]);
	});

	it("offers pause and stop while PIE is running", () => {
		const state = { mode: "play", sessionId: "session-1", status: "running" } as const;
		expect(editorSessionTransportLabel(state)).toBe("Play · running");
		expect(editorSessionTransportActions(state).map(({ command }) => command)).toEqual([
			"pause",
			"stop"
		]);
	});

	it("offers resume and stop while a session is paused", () => {
		const state = { mode: "simulate", sessionId: "session-2", status: "paused" } as const;
		expect(editorSessionTransportLabel(state)).toBe("Simulate · paused");
		expect(editorSessionTransportActions(state).map(({ command }) => command)).toEqual([
			"resume",
			"stop"
		]);
	});
});
