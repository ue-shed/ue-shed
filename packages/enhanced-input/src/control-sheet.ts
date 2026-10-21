// The control sheet: one row per mapping, the way a designer or UX reviewer reads a control
// scheme. It follows the saved-investigation export pattern: a versioned document with its source
// and coverage, then CSV (with a metadata row) or Markdown.

import { InvestigationSource, investigationTable } from "@ue-shed/unreal-assets/investigation";
import { Schema } from "effect";
import { deviceOf, objectName, parameterLabel, type AtlasInstancedDetail } from "./atlas.js";
import { modifierLabel, triggerLabel } from "./atlas.js";
import type { InputConflictAnalysis } from "./conflicts.js";
import {
	EnhancedInputReport,
	type InputInstancedObjectRef,
	type InputActionRecord,
	type InputMappingRecord
} from "./schema.js";

export const InputControlSheetRow = Schema.Struct({
	context: Schema.String,
	contextDescription: Schema.NullOr(Schema.String),
	action: Schema.NullOr(Schema.String),
	actionDescription: Schema.NullOr(Schema.String),
	/** The player-facing name from the settings the mapping's `SettingBehavior` selects. */
	displayName: Schema.NullOr(Schema.String),
	displayNameSource: Schema.suspend(() => MappableDisplayNameSource),
	key: Schema.NullOr(Schema.String),
	device: Schema.NullOr(Schema.Literals(["gamepad", "keyboard", "mouse"])),
	triggers: Schema.Array(Schema.String),
	modifiers: Schema.Array(Schema.String),
	contested: Schema.Boolean,
	conflictClasses: Schema.Array(Schema.String)
});
export type InputControlSheetRow = Schema.Schema.Type<typeof InputControlSheetRow>;

export const InputControlSheetExport = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	kind: Schema.Literal("enhanced_input_control_sheet"),
	source: InvestigationSource,
	status: EnhancedInputReport.fields.status,
	coverage: EnhancedInputReport.fields.coverage,
	/** True when conflict classes came from at least one co-activation set. */
	classified: Schema.Boolean,
	coActivationSets: Schema.Array(Schema.String),
	rows: Schema.Array(InputControlSheetRow)
});
export type InputControlSheetExport = Schema.Schema.Type<typeof InputControlSheetExport>;

export const InputControlSheetFormat = Schema.Literals(["json", "csv", "markdown"]);
export type InputControlSheetFormat = Schema.Schema.Type<typeof InputControlSheetFormat>;

/** `hold (HoldTimeThreshold 0.4)`. A trigger with no saved override shows its label only. */
export function instancedLabel(detail: Pick<AtlasInstancedDetail, "label" | "parameters">): string {
	const parameters = detail.parameters ?? [];
	return parameters.length === 0
		? detail.label
		: `${detail.label} (${parameters.map(parameterLabel).join(", ")})`;
}

function labelled(
	references: readonly InputInstancedObjectRef[],
	label: (classPath: string) => string
): string[] {
	return references.map((reference) =>
		instancedLabel({
			label:
				reference.classPath === undefined
					? objectName(reference.objectPath)
					: label(reference.classPath),
			parameters: reference.parameters ?? null
		})
	);
}

/**
 * Where a row's mappable display name came from. `setting_behavior_not_serialized` means the
 * mapping does not save `SettingBehavior`, so which settings apply is not claimed.
 */
export const MappableDisplayNameSource = Schema.Literals([
	"mapping",
	"action",
	"ignored",
	"settings_not_serialized",
	"setting_behavior_not_serialized",
	"unknown_setting_behavior"
]);
export type MappableDisplayNameSource = Schema.Schema.Type<typeof MappableDisplayNameSource>;

/** A mapping's display name and the settings it came from. */
export interface MappableDisplayName {
	readonly displayName: string | null;
	readonly source: MappableDisplayNameSource;
}

function settingsDisplayName(
	settings: InputActionRecord["playerMappableKeySettings"],
	source: "mapping" | "action"
): MappableDisplayName {
	return settings?.status === "available" && settings.value.displayName.status === "available"
		? { displayName: settings.value.displayName.value, source }
		: { displayName: null, source: "settings_not_serialized" };
}

/**
 * The display name Unreal shows for a mapping, following its saved `SettingBehavior` as
 * `FEnhancedActionKeyMapping::GetPlayerMappableKeySettings` does in UE 5.7: the action's settings
 * when inheriting, the mapping's own when overriding, and none when ignoring. A behaviour the
 * package does not save is reported as such rather than assumed.
 */
export function mappableDisplayName(
	mapping: InputMappingRecord,
	action: InputActionRecord | undefined
): MappableDisplayName {
	const behavior = mapping.settingBehavior;
	if (behavior === undefined || behavior.status !== "available") {
		return { displayName: null, source: "setting_behavior_not_serialized" };
	}
	switch (behavior.value.split("::").at(-1)) {
		case "IgnoreSettings":
			return { displayName: null, source: "ignored" };
		case "InheritSettingsFromAction":
			return settingsDisplayName(action?.playerMappableKeySettings, "action");
		case "OverrideSettings":
			return settingsDisplayName(mapping.playerMappableKeySettings, "mapping");
		default:
			return { displayName: null, source: "unknown_setting_behavior" };
	}
}

/** Builds the control sheet document. Pass a conflict analysis to fill the conflict columns. */
export function inputControlSheet(
	report: EnhancedInputReport,
	source: InvestigationSource,
	options?: { readonly conflicts?: InputConflictAnalysis }
): InputControlSheetExport {
	const actions = new Map(report.actions.map((action) => [String(action.objectPath), action]));
	const conflictKeys = new Map(
		(options?.conflicts?.keys ?? []).map((entry) => [entry.key, entry])
	);
	const contestedKeys = new Map<string, Set<string>>();
	for (const context of report.mappingContexts) {
		for (const mapping of context.mappings) {
			if (mapping.keyName.status !== "available") continue;
			const contexts = contestedKeys.get(mapping.keyName.value) ?? new Set<string>();
			contexts.add(context.objectPath);
			contestedKeys.set(mapping.keyName.value, contexts);
		}
	}
	const rows = report.mappingContexts.flatMap((context) =>
		context.mappings.map((mapping): InputControlSheetRow => {
			const action = mapping.action === null ? undefined : actions.get(mapping.action);
			const mappable = mappableDisplayName(mapping, action);
			const key = mapping.keyName.status === "available" ? mapping.keyName.value : null;
			return {
				context: context.objectPath,
				contextDescription:
					context.contextDescription.status === "available"
						? context.contextDescription.value
						: null,
				action: mapping.action,
				actionDescription:
					action?.actionDescription.status === "available"
						? action.actionDescription.value
						: null,
				displayName: mappable.displayName,
				displayNameSource: mappable.source,
				key,
				device: key === null ? null : deviceOf(key),
				triggers: [
					...labelled(mapping.triggers, triggerLabel),
					...labelled(action?.triggers ?? [], triggerLabel).map(
						(label) => `${label} [action]`
					)
				],
				modifiers: [
					...labelled(mapping.modifiers, modifierLabel),
					...labelled(action?.modifiers ?? [], modifierLabel).map(
						(label) => `${label} [action]`
					)
				],
				contested: key !== null && (contestedKeys.get(key)?.size ?? 0) > 1,
				conflictClasses: key === null ? [] : [...(conflictKeys.get(key)?.classes ?? [])]
			};
		})
	);
	return {
		schemaVersion: 1,
		kind: "enhanced_input_control_sheet",
		source,
		status: report.status,
		coverage: report.coverage,
		classified: options?.conflicts?.classified ?? false,
		coActivationSets: (options?.conflicts?.coActivationSets ?? []).map((set) => set.id),
		rows
	};
}

export function inputControlSheetCsv(document: InputControlSheetExport): string {
	const { rows, ...metadata } = document;
	return investigationTable(
		metadata,
		[
			"context",
			"action",
			"display_name",
			"display_name_source",
			"action_description",
			"key",
			"device",
			"triggers",
			"modifiers",
			"contested",
			"conflict_classes"
		],
		rows.map((row) => [
			objectName(row.context),
			row.action === null ? null : objectName(row.action),
			row.displayName,
			row.displayNameSource,
			row.actionDescription,
			row.key,
			row.device,
			row.triggers.join("; "),
			row.modifiers.join("; "),
			row.contested,
			row.conflictClasses.join("; ")
		])
	);
}

function cell(value: string | null): string {
	return (value ?? "").replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

/** One table per mapping context, in report order, with provenance first. */
export function inputControlSheetMarkdown(document: InputControlSheetExport): string {
	const lines: string[] = [
		"# Control sheet",
		"",
		`Project: \`${document.source.projectRoot}\`. Read from saved packages; ${document.coverage.mappingContexts} mapping contexts, ${document.coverage.inputActions} actions, scan ${document.status}.`,
		document.classified
			? `Conflict classes use co-activation sets: ${document.coActivationSets.map((id) => `\`${id}\``).join(", ")}.`
			: "No co-activation set was supplied, so only contested keys are marked.",
		""
	];
	const contexts = [...new Set(document.rows.map((row) => row.context))];
	for (const context of contexts) {
		const rows = document.rows.filter((row) => row.context === context);
		const description = rows[0]?.contextDescription;
		lines.push(`## ${objectName(context)}`, "");
		if (description) lines.push(cell(description), "");
		lines.push(
			"| Action | Key | Device | Triggers | Modifiers | Conflicts |",
			"| --- | --- | --- | --- | --- | --- |"
		);
		for (const row of rows) {
			const action = row.action === null ? "No action" : objectName(row.action);
			const name = row.displayName ?? row.actionDescription;
			const conflicts = [
				...(row.contested ? ["contested"] : []),
				...row.conflictClasses.map((name) => name.replaceAll("_", " "))
			];
			lines.push(
				`| ${cell(name ? `${action} (${name})` : action)} | ${cell(row.key ?? "not serialized")} | ${cell(row.device)} | ${cell(row.triggers.join(", "))} | ${cell(row.modifiers.join(", "))} | ${cell(conflicts.join(", "))} |`
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}
