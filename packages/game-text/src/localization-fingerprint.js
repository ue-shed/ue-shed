import { Schema } from "effect";
import { sha256Hex } from "@ue-shed/localization/browser";
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const isJsonObject = Schema.is(JsonObject);
export function canonicalLocalizationJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalLocalizationJson).join(",")}]`;
    if (isJsonObject(value))
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalLocalizationJson(value[key] ?? null)}`)
            .join(",")}}`;
    return JSON.stringify(value);
}
/** SHA-256 hex over UTF-8, shared with the localization review file. */
export const localizationFingerprint = sha256Hex;
