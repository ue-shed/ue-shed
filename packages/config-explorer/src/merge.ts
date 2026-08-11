import type {
	ConfigComparison,
	ConfigContribution,
	ConfigContributionEffect,
	ConfigDiagnostic,
	ConfigOperation,
	ConfigSource,
	ConfigSourceLocation,
	ConfigValueState
} from "./schema.js";

export interface ParsedConfigCommand {
	readonly source: ConfigSource;
	readonly location: ConfigSourceLocation;
	readonly operation: ConfigOperation;
	readonly value?: string;
}

interface ValueItem {
	readonly value: string;
	readonly contribution: number;
}

interface FoldState {
	readonly items: readonly ValueItem[];
	readonly arraySemantics: boolean;
	readonly emptyInitializedBy?: number;
}

interface MutableContribution {
	readonly sequence: number;
	readonly source: ConfigSource;
	readonly location: ConfigSourceLocation;
	readonly operation: ConfigOperation;
	readonly inputValue?: string;
	readonly priorValue: ConfigValueState;
	readonly effect: ConfigContributionEffect;
	remainsEffective: boolean;
}

export interface FoldConfigResult {
	readonly effectiveValue: ConfigValueState;
	readonly contributions: readonly ConfigContribution[];
}

function publicState(state: FoldState): ConfigValueState {
	if (state.items.length === 0) {
		return state.emptyInitializedBy === undefined
			? { kind: "missing" }
			: { kind: "empty_array" };
	}
	if (!state.arraySemantics && state.items.length === 1) {
		return { kind: "scalar", value: state.items[0]!.value };
	}
	return { kind: "array", values: state.items.map((item) => item.value) };
}

function addContribution(
	contributions: MutableContribution[],
	command: ParsedConfigCommand,
	priorValue: ConfigValueState,
	effect: ConfigContributionEffect
): number {
	const sequence = contributions.length;
	contributions.push({
		sequence,
		source: command.source,
		location: command.location,
		operation: command.operation,
		...(command.value === undefined ? {} : { inputValue: command.value }),
		priorValue,
		effect,
		remainsEffective: false
	});
	return sequence;
}

export function foldConfigCommands(commands: readonly ParsedConfigCommand[]): FoldConfigResult {
	let state: FoldState = { items: [], arraySemantics: false };
	const contributions: MutableContribution[] = [];
	for (const command of commands) {
		const priorValue = publicState(state);
		const value = command.value ?? "";
		switch (command.operation) {
			case "set": {
				if (state.items.length === 0) {
					const sequence = contributions.length;
					state = { ...state, items: [{ value, contribution: sequence }] };
					addContribution(contributions, command, priorValue, {
						kind: "added",
						index: 0
					});
				} else {
					const replaced = state.items[0]!;
					const sequence = contributions.length;
					state = {
						...state,
						items: [{ value, contribution: sequence }, ...state.items.slice(1)]
					};
					addContribution(contributions, command, priorValue, {
						kind: "replaced",
						index: 0,
						previousValue: replaced.value
					});
				}
				break;
			}
			case "add_unique": {
				const duplicate = state.items.some((item) => item.value === value);
				if (duplicate) {
					addContribution(contributions, command, priorValue, { kind: "duplicate" });
				} else {
					const sequence = contributions.length;
					const index = state.items.length;
					state = {
						...state,
						arraySemantics: true,
						items: [...state.items, { value, contribution: sequence }]
					};
					addContribution(contributions, command, priorValue, { kind: "added", index });
				}
				break;
			}
			case "append": {
				const sequence = contributions.length;
				const index = state.items.length;
				state = {
					...state,
					arraySemantics: true,
					items: [...state.items, { value, contribution: sequence }]
				};
				addContribution(contributions, command, priorValue, { kind: "added", index });
				break;
			}
			case "remove": {
				const index = state.items.findIndex((item) => item.value === value);
				if (index === -1) {
					addContribution(contributions, command, priorValue, { kind: "no_match" });
				} else {
					state = {
						...state,
						arraySemantics: true,
						items: [...state.items.slice(0, index), ...state.items.slice(index + 1)]
					};
					const sequence = addContribution(contributions, command, priorValue, {
						kind: "removed",
						index
					});
					contributions[sequence]!.remainsEffective = true;
				}
				break;
			}
			case "clear": {
				const removedValues = state.items.map((item) => item.value);
				const clearedEmpty = state.emptyInitializedBy !== undefined;
				state = { items: [], arraySemantics: true };
				const sequence = addContribution(contributions, command, priorValue, {
					kind: "cleared",
					removedValues
				});
				contributions[sequence]!.remainsEffective =
					removedValues.length > 0 || clearedEmpty;
				break;
			}
			case "initialize_empty": {
				const removedValues = state.items.map((item) => item.value);
				const sequence = contributions.length;
				state = { items: [], arraySemantics: true, emptyInitializedBy: sequence };
				addContribution(contributions, command, priorValue, {
					kind: "initialized_empty",
					removedValues
				});
				break;
			}
		}
	}

	for (const item of state.items) {
		contributions[item.contribution]!.remainsEffective = true;
	}
	if (state.emptyInitializedBy !== undefined) {
		contributions[state.emptyInitializedBy]!.remainsEffective = true;
	}
	return {
		effectiveValue: publicState(state),
		contributions
	};
}

function comparable(value: ConfigValueState): string {
	switch (value.kind) {
		case "missing":
			return "missing";
		case "empty_array":
			return "empty_array";
		case "scalar":
			return `scalar:${value.value}`;
		case "array":
			return `array:${JSON.stringify(value.values)}`;
	}
}

export function compareConfigExplanations(options: {
	readonly left: ConfigComparison["left"];
	readonly right: ConfigComparison["right"];
}): ConfigComparison {
	const valueChanged =
		comparable(options.left.effectiveValue) !== comparable(options.right.effectiveValue);
	const coverageChanged =
		options.left.status !== options.right.status ||
		options.left.layers.map((layer) => `${layer.layer}:${layer.status}`).join("|") !==
			options.right.layers.map((layer) => `${layer.layer}:${layer.status}`).join("|");
	return {
		schemaVersion: 1,
		status:
			options.left.status === "partial" || options.right.status === "partial"
				? "partial"
				: valueChanged || coverageChanged
					? "different"
					: "same",
		left: options.left,
		right: options.right,
		valueChanged,
		coverageChanged
	};
}

export interface ParsedConfigFile {
	readonly commands: readonly ParsedConfigCommand[];
	readonly diagnostics: readonly ConfigDiagnostic[];
}
