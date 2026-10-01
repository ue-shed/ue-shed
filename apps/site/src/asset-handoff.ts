import type { SequenceReadResult } from "@ue-shed/extension-sequencer/contract";
import type { AuthoringReadResult } from "@ue-shed/extension-data-authoring/wasm";
import type { BlueprintGraphReadResult } from "@ue-shed/extension-blueprint-graphs/contract";
import type { SiteAssetRead } from "./blueprints/browser-reader.js";

interface BlueprintHandoff {
	readonly read: BlueprintGraphReadResult;
	readonly fileName: string;
}

// One retained inspection makes browser Back useful. It holds decoded evidence, not file bytes.
// These values are tab-local, disappear on refresh, and never enter history or persistent storage.
let inspection: SiteAssetRead | undefined;
let blueprint: BlueprintHandoff | undefined;
let sequence: { readonly read: SequenceReadResult; readonly fileName: string } | undefined;
let authoring: { readonly read: AuthoringReadResult; readonly fileName: string } | undefined;
let file: File | undefined;

export function rememberInspection(read: SiteAssetRead): void {
	inspection = read;
}
export function lastInspection(): SiteAssetRead | undefined {
	return inspection;
}
export function offerBlueprint(read: BlueprintGraphReadResult, fileName: string): void {
	blueprint = { read, fileName };
}
export function takeBlueprint(): BlueprintHandoff | undefined {
	const value = blueprint;
	blueprint = undefined;
	return value;
}
export function offerInspectionFile(value: File): void {
	file = value;
}
export function takeInspectionFile(): File | undefined {
	const value = file;
	file = undefined;
	return value;
}

export function offerSequence(read: SequenceReadResult, fileName: string): void {
	sequence = { read, fileName };
}
export function takeSequence() {
	const value = sequence;
	sequence = undefined;
	return value;
}

export function offerAuthoring(read: AuthoringReadResult, fileName: string): void {
	authoring = { read, fileName };
}

export function takeAuthoring() {
	const value = authoring;
	authoring = undefined;
	return value;
}
