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

export interface KeyboardGap {
	readonly gap: number;
}

export type KeyboardCell = KeyboardCap | KeyboardGap;

export function isKeyboardCap(cell: KeyboardCell): cell is KeyboardCap {
	return "key" in cell;
}

const gap = (units = 1): KeyboardGap => ({ gap: units });

/**
 * A complete ANSI-style desktop keyboard. A few tall numpad keys are represented as ordinary
 * caps because the diagram is a compact interactive control surface, not a physical keycap render.
 */
export const keyboardRows: readonly (readonly KeyboardCell[])[] = [
	[
		{ key: "Escape" },
		gap(),
		{ key: "F1" },
		{ key: "F2" },
		{ key: "F3" },
		{ key: "F4" },
		gap(),
		{ key: "F5" },
		{ key: "F6" },
		{ key: "F7" },
		{ key: "F8" },
		gap(),
		{ key: "F9" },
		{ key: "F10" },
		{ key: "F11" },
		{ key: "F12" },
		gap(),
		{ key: "PrintScreen" },
		{ key: "ScrollLock" },
		{ key: "Pause" }
	],
	[
		{ key: "Tilde" },
		{ key: "One" },
		{ key: "Two" },
		{ key: "Three" },
		{ key: "Four" },
		{ key: "Five" },
		{ key: "Six" },
		{ key: "Seven" },
		{ key: "Eight" },
		{ key: "Nine" },
		{ key: "Zero" },
		{ key: "Hyphen" },
		{ key: "Equals" },
		{ key: "BackSpace", span: 2 },
		gap(),
		{ key: "Insert" },
		{ key: "Home" },
		{ key: "PageUp" },
		gap(),
		{ key: "NumLock" },
		{ key: "Divide" },
		{ key: "Multiply" },
		{ key: "Subtract" }
	],
	[
		{ key: "Tab", span: 2 },
		{ key: "Q" },
		{ key: "W" },
		{ key: "E" },
		{ key: "R" },
		{ key: "T" },
		{ key: "Y" },
		{ key: "U" },
		{ key: "I" },
		{ key: "O" },
		{ key: "P" },
		{ key: "LeftBracket" },
		{ key: "RightBracket" },
		{ key: "Backslash", span: 2 },
		gap(),
		{ key: "Delete" },
		{ key: "End" },
		{ key: "PageDown" },
		gap(),
		{ key: "NumPadSeven" },
		{ key: "NumPadEight" },
		{ key: "NumPadNine" },
		{ key: "Add" }
	],
	[
		{ key: "CapsLock", span: 2 },
		{ key: "A" },
		{ key: "S" },
		{ key: "D" },
		{ key: "F" },
		{ key: "G" },
		{ key: "H" },
		{ key: "J" },
		{ key: "K" },
		{ key: "L" },
		{ key: "Semicolon" },
		{ key: "Apostrophe" },
		{ key: "Enter", span: 2 },
		gap(5),
		{ key: "NumPadFour" },
		{ key: "NumPadFive" },
		{ key: "NumPadSix" }
	],
	[
		{ key: "LeftShift", span: 3 },
		{ key: "Z" },
		{ key: "X" },
		{ key: "C" },
		{ key: "V" },
		{ key: "B" },
		{ key: "N" },
		{ key: "M" },
		{ key: "Comma" },
		{ key: "Period" },
		{ key: "Slash" },
		{ key: "RightShift", span: 3 },
		gap(2),
		{ key: "Up" },
		gap(2),
		{ key: "NumPadOne" },
		{ key: "NumPadTwo" },
		{ key: "NumPadThree" },
		{ key: "NumPadEnter" }
	],
	[
		{ key: "LeftControl", span: 2 },
		{ key: "LeftCommand" },
		{ key: "LeftAlt", span: 2 },
		{ key: "SpaceBar", span: 6 },
		{ key: "RightAlt", span: 2 },
		{ key: "RightCommand" },
		{ key: "RightControl", span: 2 },
		gap(),
		{ key: "Left" },
		{ key: "Down" },
		{ key: "Right" },
		gap(),
		{ key: "NumPadZero", span: 2 },
		{ key: "Decimal" }
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
	Backslash: "\\",
	BackSpace: "Backspace",
	CapsLock: "Caps",
	Decimal: ".",
	Divide: "/",
	Equals: "=",
	Hyphen: "-",
	LeftAlt: "Alt",
	LeftBracket: "[",
	LeftCommand: "Win",
	LeftControl: "Ctrl",
	LeftShift: "Shift",
	NumLock: "Num",
	NumPadEnter: "Enter",
	NumPadZero: "0",
	NumPadOne: "1",
	NumPadTwo: "2",
	NumPadThree: "3",
	NumPadFour: "4",
	NumPadFive: "5",
	NumPadSix: "6",
	NumPadSeven: "7",
	NumPadEight: "8",
	NumPadNine: "9",
	PageDown: "PgDn",
	PageUp: "PgUp",
	PrintScreen: "PrtSc",
	RightAlt: "Alt",
	RightBracket: "]",
	RightCommand: "Win",
	RightControl: "Ctrl",
	RightShift: "Shift",
	ScrollLock: "ScrLk",
	Semicolon: ";",
	SpaceBar: "Space",
	Tilde: "`",
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
	...keyboardRows.flatMap((row) =>
		row.flatMap((cell) => (isKeyboardCap(cell) ? [cell.key] : []))
	),
	...mouseCaps.map((cap) => cap.key)
]);

export function isPlaced(key: string): boolean {
	return placed.has(key);
}

/** Bound keys the diagram has no slot for. Real projects always have some. */
export function unplacedKeys(atlas: InputAtlas): readonly AtlasKey[] {
	return atlas.keys.filter((entry) => !placed.has(entry.key));
}
