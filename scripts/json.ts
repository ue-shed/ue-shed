export type JsonValue = null | boolean | number | string | JsonObject | readonly JsonValue[];

export interface JsonObject {
	readonly [key: string]: JsonValue;
}

export function isJsonObject(value: JsonValue): value is JsonObject {
	return value instanceof Object && !Array.isArray(value);
}

export function isJsonNumber(value: JsonValue): value is number {
	return Object.prototype.toString.call(value) === "[object Number]";
}

export function isJsonString(value: JsonValue): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

export function parseJson(contents: string): JsonValue {
	// SAFETY: JSON.parse without a reviver can only construct values in the JSON data model.
	return JSON.parse(contents) as JsonValue;
}

export function parseJsonObject(contents: string): JsonObject {
	const value = parseJson(contents);
	if (!isJsonObject(value)) throw new Error("Expected a JSON object.");
	return value;
}
