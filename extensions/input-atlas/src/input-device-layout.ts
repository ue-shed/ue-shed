// Where a key sits on a diagram. This is presentation only — a project can bind any `FKey`, so
// the layout is a best-effort placement and anything it does not know about is still listed
// rather than dropped.

import type { AtlasKey, InputAtlas } from "@ue-shed/enhanced-input/browser";

export type GamepadControl =
	| { readonly key: string; readonly shape: "stick"; readonly cx: number; readonly cy: number }
	| { readonly key: string; readonly shape: "face"; readonly cx: number; readonly cy: number }
	| {
			readonly key: string;
			readonly shape: "pad";
			readonly x: number;
			readonly y: number;
			readonly width: number;
			readonly height: number;
	  };

export const GAMEPAD_VIEWBOX = "0 0 340 196";

export const GAMEPAD_BODY =
	"M 44 42 Q 18 42 12 78 L 6 148 Q 4 180 32 186 Q 58 190 74 164 L 92 146 " +
	"L 248 146 L 266 164 Q 282 190 308 186 Q 336 180 334 148 L 328 78 " +
	"Q 322 42 296 42 Z";

export const STICK_RADIUS = 20;
export const FACE_RADIUS = 13;

export const gamepadControls: readonly GamepadControl[] = [
	{ key: "Gamepad_LeftTrigger", shape: "pad", x: 58, y: 6, width: 48, height: 14 },
	{ key: "Gamepad_RightTrigger", shape: "pad", x: 234, y: 6, width: 48, height: 14 },
	{ key: "Gamepad_LeftShoulder", shape: "pad", x: 52, y: 24, width: 60, height: 14 },
	{ key: "Gamepad_RightShoulder", shape: "pad", x: 228, y: 24, width: 60, height: 14 },
	{ key: "Gamepad_LeftThumbstick", shape: "stick", cx: 74, cy: 76 },
	{ key: "Gamepad_FaceButton_Top", shape: "face", cx: 266, cy: 57 },
	{ key: "Gamepad_FaceButton_Right", shape: "face", cx: 287, cy: 78 },
	{ key: "Gamepad_FaceButton_Bottom", shape: "face", cx: 266, cy: 99 },
	{ key: "Gamepad_FaceButton_Left", shape: "face", cx: 245, cy: 78 },
	{ key: "Gamepad_DPad_Up", shape: "pad", x: 114, y: 88, width: 16, height: 17 },
	{ key: "Gamepad_DPad_Down", shape: "pad", x: 114, y: 127, width: 16, height: 17 },
	{ key: "Gamepad_DPad_Left", shape: "pad", x: 96, y: 108, width: 17, height: 16 },
	{ key: "Gamepad_DPad_Right", shape: "pad", x: 131, y: 108, width: 17, height: 16 },
	{ key: "Gamepad_RightThumbstick", shape: "stick", cx: 196, cy: 120 },
	{ key: "Gamepad_Special_Left", shape: "pad", x: 150, y: 72, width: 18, height: 10 },
	{ key: "Gamepad_Special_Right", shape: "pad", x: 174, y: 72, width: 18, height: 10 }
];

export interface KeyboardCap {
	readonly key: string;
	/** Cap width in grid units; modifiers and the space bar are wider than a letter. */
	readonly span?: number;
}

export const keyboardRows: readonly (readonly KeyboardCap[])[] = [
	[{ key: "Escape", span: 2 }, { key: "One" }, { key: "Two" }, { key: "Three" }, { key: "Four" }],
	[{ key: "Tab", span: 2 }, { key: "Q" }, { key: "W" }, { key: "E" }, { key: "R" }],
	[{ key: "A" }, { key: "S" }, { key: "D" }, { key: "F" }, { key: "G" }],
	[
		{ key: "LeftShift", span: 2 },
		{ key: "LeftControl", span: 2 },
		{ key: "SpaceBar", span: 4 }
	]
];

export const mouseCaps: readonly KeyboardCap[] = [
	{ key: "LeftMouseButton", span: 2 },
	{ key: "RightMouseButton", span: 2 },
	{ key: "MiddleMouseButton", span: 2 }
];

/** Short caps for the diagram. The atlas keeps the serialized `FKey` name as identity. */
export const keyLabels: Readonly<Record<string, string>> = {
	Escape: "Esc",
	LeftControl: "Ctrl",
	LeftShift: "Shift",
	SpaceBar: "Space",
	One: "1",
	Two: "2",
	Three: "3",
	Four: "4",
	LeftMouseButton: "LMB",
	MiddleMouseButton: "MMB",
	RightMouseButton: "RMB",
	Gamepad_LeftThumbstick: "L",
	Gamepad_RightThumbstick: "R",
	Gamepad_LeftShoulder: "LB",
	Gamepad_RightShoulder: "RB",
	Gamepad_LeftTrigger: "LT",
	Gamepad_RightTrigger: "RT",
	Gamepad_FaceButton_Top: "Y",
	Gamepad_FaceButton_Right: "B",
	Gamepad_FaceButton_Bottom: "A",
	Gamepad_FaceButton_Left: "X",
	Gamepad_DPad_Up: "▲",
	Gamepad_DPad_Down: "▼",
	Gamepad_DPad_Left: "◀",
	Gamepad_DPad_Right: "▶",
	Gamepad_Special_Left: "⧉",
	Gamepad_Special_Right: "≡"
};

export function capLabel(key: string): string {
	return keyLabels[key] ?? key;
}

const placed: ReadonlySet<string> = new Set([
	...gamepadControls.map((control) => control.key),
	...keyboardRows.flat().map((cap) => cap.key),
	...mouseCaps.map((cap) => cap.key)
]);

export function isPlaced(key: string): boolean {
	return placed.has(key);
}

/** Bound keys the diagram has no slot for. Real projects always have some. */
export function unplacedKeys(atlas: InputAtlas): readonly AtlasKey[] {
	return atlas.keys.filter((entry) => !placed.has(entry.key));
}
