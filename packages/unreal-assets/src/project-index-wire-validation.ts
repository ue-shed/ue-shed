/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This is the protocol boundary parser for decoded JSON frames: it establishes the wire contract by inspecting their representation, exactly as the schema it stands in for does. */
import {
	UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE,
	type UAssetIoEvent,
	type UAssetIoProjectIndexDictionaryPage
} from "@ue-shed/protocol";

/**
 * A dictionary page frame's exact type-side wire rules, checked in one walk instead of per value
 * through the schema. It only answers "valid": anything else goes through the schema. The test
 * checks it against `UAssetIoEvent` rule by rule.
 */
type DictionaryPageEvent = Extract<UAssetIoEvent, { readonly kind: "result" }> & {
	readonly result: {
		readonly kind: "project_index_dictionary_page";
		readonly page: UAssetIoProjectIndexDictionaryPage;
	};
};

const MAX_REFERENCES = 64;
const MAX_PAGE_STRINGS = UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE * 128;

type Record_ = { readonly [key: string]: unknown };

const isRecord = (value: unknown): value is Record_ =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Schema's `NonEmptyString` type side: trimmed and non-empty. */
const isText = (value: unknown): boolean =>
	typeof value === "string" && value.length > 0 && value.trim() === value;

const isCount = (value: unknown): boolean =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isReferences = (value: unknown): boolean => {
	if (!Array.isArray(value) || value.length > MAX_REFERENCES) return false;
	for (const reference of value) if (!isCount(reference)) return false;
	return true;
};

/**
 * Whether `value` has only the `allowed` keys and every key in `required`. Struct decoding
 * rejects excess keys, and `optionalKey` fields may be absent but never `undefined` in JSON.
 */
function hasKeys(value: Record_, allowed: ReadonlySet<string>, required: number): boolean {
	let present = 0;
	for (const key in value) {
		if (!Object.hasOwn(value, key) || !allowed.has(key)) return false;
		if (value[key] === undefined) return false;
		present += 1;
	}
	return present >= required;
}

const HEADER_DATA_KEYS = new Set([
	"packageFlags",
	"gatherableTextDataCount",
	"gatherableTextDataOffset",
	"hasTextProperty"
]);
const isHeaderData = (value: unknown): boolean =>
	isRecord(value) &&
	hasKeys(value, HEADER_DATA_KEYS, 4) &&
	isCount(value.packageFlags) &&
	isCount(value.gatherableTextDataCount) &&
	isCount(value.gatherableTextDataOffset) &&
	typeof value.hasTextProperty === "boolean";

const MAP_KEYS = new Set(["kind", "mapPath", "packageName"]);
const HEADER_KEYS = new Set([
	"headerData",
	"classes",
	"kind",
	"packageName",
	"packagePath",
	"serializedNames"
]);
const INVENTORY_KEYS = new Set(["kind", "packagePath", "signature", "headerData"]);
const PACKAGE_KEYS = new Set([
	"classes",
	"dependencies",
	"failure",
	"kind",
	"packageName",
	"packagePath"
]);
const DEPENDENCY_KEYS = new Set(["package", "packagePath", "hard", "game", "build"]);

const isDependency = (value: unknown): boolean =>
	isRecord(value) &&
	hasKeys(value, DEPENDENCY_KEYS, 4) &&
	isCount(value.package) &&
	(!("packagePath" in value) || isCount(value.packagePath)) &&
	typeof value.hard === "boolean" &&
	typeof value.game === "boolean" &&
	typeof value.build === "boolean";

function isItem(item: unknown): boolean {
	if (!isRecord(item)) return false;
	switch (item.kind) {
		case "map":
			return hasKeys(item, MAP_KEYS, 3) && isText(item.mapPath) && isText(item.packageName);
		case "header":
			return (
				hasKeys(item, HEADER_KEYS, 3) &&
				isText(item.packageName) &&
				isText(item.packagePath) &&
				(!("classes" in item) || isReferences(item.classes)) &&
				(!("serializedNames" in item) || isReferences(item.serializedNames)) &&
				(!("headerData" in item) || isHeaderData(item.headerData))
			);
		case "inventory":
			return (
				hasKeys(item, INVENTORY_KEYS, 3) &&
				isText(item.packagePath) &&
				isText(item.signature) &&
				(!("headerData" in item) || isHeaderData(item.headerData))
			);
		case "package": {
			if (
				!hasKeys(item, PACKAGE_KEYS, 5) ||
				!("classes" in item) ||
				!("dependencies" in item) ||
				!isText(item.packageName) ||
				!isText(item.packagePath) ||
				!isReferences(item.classes) ||
				("failure" in item && !isText(item.failure)) ||
				!Array.isArray(item.dependencies)
			)
				return false;
			for (const dependency of item.dependencies) if (!isDependency(dependency)) return false;
			return true;
		}
		default:
			return false;
	}
}

const PAGE_KEYS = new Set(["generation", "items", "nextCursor", "projectId", "strings"]);

function isPage(page: unknown): boolean {
	if (
		!isRecord(page) ||
		!hasKeys(page, PAGE_KEYS, 4) ||
		!("generation" in page) ||
		!("items" in page) ||
		!("projectId" in page) ||
		!("strings" in page)
	)
		return false;
	const { generation, items, strings } = page;
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)
		return false;
	if (!isText(page.projectId)) return false;
	if ("nextCursor" in page && !isText(page.nextCursor)) return false;
	if (!Array.isArray(strings) || strings.length > MAX_PAGE_STRINGS) return false;
	for (const value of strings) if (!isText(value)) return false;
	if (!Array.isArray(items) || items.length > UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE) return false;
	for (const item of items) if (!isItem(item)) return false;
	return true;
}

const EVENT_KEYS = new Set(["contract", "kind", "requestId", "sequence", "result"]);
const CONTRACT_KEYS = new Set(["name", "version"]);
const VERSION_KEYS = new Set(["major", "minor"]);
const RESULT_KEYS = new Set(["kind", "page"]);

/** Whether `input` is a dictionary page result frame that satisfies its exact wire schema. */
export function isValidProjectIndexDictionaryPageEvent(
	input: unknown
): input is DictionaryPageEvent {
	if (!isRecord(input) || input.kind !== "result" || !hasKeys(input, EVENT_KEYS, 5)) return false;
	const { contract, result } = input;
	if (!isRecord(contract) || !hasKeys(contract, CONTRACT_KEYS, 2)) return false;
	if (contract.name !== "uasset-io") return false;
	const version = contract.version;
	if (!isRecord(version) || !hasKeys(version, VERSION_KEYS, 2)) return false;
	if (version.major !== 1 || !isCount(version.minor)) return false;
	if (!isText(input.requestId) || !isCount(input.sequence)) return false;
	if (!isRecord(result) || !hasKeys(result, RESULT_KEYS, 2)) return false;
	return result.kind === "project_index_dictionary_page" && isPage(result.page);
}
