import {
	BLUEPRINT_LAYOUT,
	blueprintClassLabel as shortClass,
	blueprintNodeDisplay,
	blueprintPinLabel as pinLabel,
	blueprintPinTone as pinTone,
	type BlueprintPinTone as PinTone
} from "@ue-shed/blueprints";
import * as stylex from "@stylexjs/stylex";
import type { BlueprintNode, BlueprintPin } from "@ue-shed/protocol";
import type { JSX } from "@solidjs/web";
import { For, Show, createMemo } from "solid-js";
import { styles } from "./blueprint-graph-styles.js";

// UEdGraphNode_Comment constructor defaults (UE 5.7 and 5.8); tagged saves omit unchanged sizes.
const COMMENT_DEFAULT_WIDTH = 400;
const COMMENT_DEFAULT_HEIGHT = 100;

export function pinToneColor(tone: PinTone): string {
	switch (tone) {
		case "boolean":
			return "#ef6a67";
		case "exec":
			return "#d8e0e8";
		case "numeric":
			return "#80d9ad";
		case "object":
			return "#5bc0eb";
		case "struct":
			return "#f0b35b";
		case "text":
			return "#d78ce8";
		case "wildcard":
			return "#8a919c";
	}
}

export function PinGlyph(props: {
	readonly edge?: BlueprintPin["direction"] | undefined;
	readonly pin: BlueprintPin;
}) {
	const exec = createMemo(() => pinTone(props.pin) === "exec");
	const linked = createMemo(() => props.pin.linked_to.length > 0);
	const color = createMemo(() => pinToneColor(pinTone(props.pin)));
	return (
		<i
			aria-hidden="true"
			style={
				"border-color:" +
				color() +
				";background-color:" +
				(linked() || exec() ? color() : "transparent") +
				";opacity:" +
				(exec() && !linked() ? "0.5" : "1")
			}
			{...stylex.attrs(
				exec() && styles.pinExec,
				!exec() && styles.pinData,
				props.edge === "input" && styles.pinEdgeInput,
				props.edge === "output" && styles.pinEdgeOutput
			)}
		/>
	);
}

export function blueprintCommentFrame(node: BlueprintNode) {
	if (!node.class_path.endsWith("EdGraphNode_Comment")) return undefined;
	const display = blueprintNodeDisplay(node);
	return {
		height: (display.height ?? COMMENT_DEFAULT_HEIGHT) * BLUEPRINT_LAYOUT.positionScale,
		text: display.comment ?? node.title,
		width: (display.width ?? COMMENT_DEFAULT_WIDTH) * BLUEPRINT_LAYOUT.positionScale
	};
}

export function GraphCardContent(props: {
	readonly node: BlueprintNode;
	readonly pinHandle?: (pin: BlueprintPin) => JSX.Element;
}) {
	const kind = createMemo(() => props.node.kind);
	return (
		<>
			<span
				{...stylex.attrs(
					styles.nodeHeader,
					kind() === "event" && styles.nodeHeaderEvent,
					kind() === "function_call" && styles.nodeHeaderFunction,
					(kind() === "variable_get" || kind() === "variable_set") &&
						styles.nodeHeaderVariable
				)}
			>
				<span title={props.node.title} {...stylex.attrs(styles.nodeTitle)}>
					{props.node.title}
				</span>
				<small {...stylex.attrs(styles.nodeClass)}>
					{shortClass(props.node.class_path)}
				</small>
			</span>
			<For each={props.node.pins}>
				{(pin) => (
					<span {...stylex.attrs(styles.pinRow)}>
						<span {...stylex.attrs(styles.pinSide, styles.pinInput)}>
							<Show when={pin.direction === "input"}>{pinLabel(pin)}</Show>
						</span>
						<span {...stylex.attrs(styles.pinSide, styles.pinOutput)}>
							<Show when={pin.direction === "output"}>{pinLabel(pin)}</Show>
						</span>
						<PinGlyph edge={pin.direction} pin={pin} />
						{props.pinHandle?.(pin)}
					</span>
				)}
			</For>
		</>
	);
}
