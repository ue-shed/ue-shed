import { createHash } from "node:crypto";
import type { Json } from "./model.ts";
const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);
/** Canonical encoding of already typed JSON; no repeated recursive schema decoding. */
export function canonical(value: Json): string {
	if (isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && value instanceof Object)
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export const checksum = (value: Json): string =>
	createHash("sha256").update(canonical(value)).digest("hex");
