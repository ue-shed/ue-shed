import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Json } from "./model.ts";

const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);
export function difference(a: Json, b: Json, path = "$"): string | undefined {
	if (Object.is(a, b)) return undefined;
	if (!(a instanceof Object) || !(b instanceof Object))
		return `${path}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`;
	if (isArray(a) || isArray(b)) {
		if (!isArray(a) || !isArray(b)) return `${path}: array kind differs`;
		if (a.length !== b.length) return `${path}: expected length ${a.length}, got ${b.length}`;
		for (let i = 0; i < a.length; i++) {
			const diff = difference(a[i]!, b[i]!, `${path}[${i}]`);
			if (diff) return diff;
		}
		return undefined;
	}
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const av = a[key],
			bv = b[key];
		if (av === undefined || bv === undefined) {
			if (av !== bv) return `${path}.${key}: property presence differs`;
		} else {
			const diff = difference(av, bv, `${path}.${key}`);
			if (diff) return diff;
		}
	}
	return undefined;
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/full/diff.ts")) {
	const root = resolve(process.argv[2]!);
	const result = JSON.parse(await readFile(resolve(root, "parity.json"), "utf8"));
	for (const [index, sample] of result.samples.entries())
		if (!sample.matches) {
			const expected = JSON.parse(
				await readFile(resolve(root, `expected-${index}.json`), "utf8")
			);
			const actual = JSON.parse(
				await readFile(resolve(root, `actual-${index}.json`), "utf8")
			);
			console.log(
				JSON.stringify({ name: sample.name, difference: difference(expected, actual) })
			);
		}
}
