import { absent, type JoinPackages } from "./joined-target-input.js";
import { duplicateOccurrencePlace } from "./duplicate-sources.js";
import { manifestPlace } from "./localization-key-changes.js";
import { normalizeTextPath, textFileKey } from "./text-origin.js";
import { HostSliceClock, runHostStepsSync, type HostSteps } from "./host-slices.js";

const hashUnit = (hash: number, unit: number) => Math.imul(hash ^ unit, 16777619) >>> 0;
function hashString(hash: number, value: string) {
	for (let index = 0; index < value.length; index++)
		hash = hashUnit(hash, value.charCodeAt(index));
	return hash;
}

/** Hash canonical ASCII directly; return undefined when full normalization is needed. */
function hashField(hash: number, bytes: Uint8Array): number | undefined {
	let end = bytes.length;
	while (end && (bytes[end - 1] === 32 || (bytes[end - 1]! >= 9 && bytes[end - 1]! <= 13))) end--;
	if (!end || bytes[0] === 10 || bytes[0] === 13) return undefined;
	for (let index = 0; index < end; index++) {
		let unit = bytes[index]!;
		if (unit > 127) return undefined;
		if (unit === 40) {
			let close = index + 1;
			while (close < end && bytes[close]! >= 48 && bytes[close]! <= 57) close++;
			if (close > index + 1 && bytes[close] === 41) {
				hash = hashUnit(hash, 91);
				while (++index < close) hash = hashUnit(hash, bytes[index]!);
				hash = hashUnit(hash, 93);
				continue;
			}
		}
		if (unit === 92) unit = 47;
		else if (unit >= 65 && unit <= 90) unit += 32;
		hash = hashUnit(hash, unit);
	}
	return hash;
}

type DuplicatePlaceInput = {
	readonly occurrence: Pick<
		JoinPackages["occurrence"],
		"object" | "property" | "row" | "location"
	>;
	readonly packageRow: Uint32Array;
	readonly packageFile: (row: number) => string;
	readonly string: (id: number) => string;
	readonly bytes: (id: number) => Uint8Array;
};

/** Numeric hashes avoid decoded keys for unique places; collisions use the original exact key. */
export function joinedDuplicatePlaces(packages: DuplicatePlaceInput, order: Uint32Array) {
	return runHostStepsSync(
		joinedDuplicatePlacesSteps(packages, order, new HostSliceClock(Infinity))
	);
}

/** Host steps for `joinedDuplicatePlaces`, yielding whenever `clock` ends a slice. */
export function* joinedDuplicatePlacesSteps(
	packages: DuplicatePlaceInput,
	order: Uint32Array,
	clock = new HostSliceClock()
): HostSteps<Uint32Array> {
	const c = packages.occurrence;
	const files = new Map<number, { path: string; hash: number }>();
	const objects = new Map<
		number,
		{ raw: string; prefix: string | undefined; hashes: Map<number, number> }
	>();
	const heads = new Map<number, number>();
	const next = new Uint32Array(order.length).fill(absent);
	const keys = new Map<number, string>();
	const places = new Uint32Array(order.length);
	let count = 0;
	const fileOf = (member: number) => {
		const row = packages.packageRow[member]!;
		let file = files.get(row);
		if (file === undefined) {
			const path = packages.packageFile(row);
			file = { path, hash: hashString(2166136261, textFileKey(path)) };
			files.set(row, file);
		}
		return file;
	};
	const keyOf = (member: number) => {
		let key = keys.get(member);
		if (key === undefined) {
			const objectPath = packages.string(c.object[member]!);
			const kind = c.location[member]!;
			key = duplicateOccurrencePlace({
				packageFile: fileOf(member).path,
				location:
					kind === 2
						? {
								kind: "string_table_entry",
								objectPath,
								entryKey: packages.string(c.row[member]!)
							}
						: kind === 1
							? {
									kind: "data_table_cell",
									objectPath,
									row: packages.string(c.row[member]!),
									propertyPath: packages.string(c.property[member]!)
								}
							: {
									kind: "asset_property",
									objectPath,
									propertyPath: packages.string(c.property[member]!),
									classPath: ""
								}
			});
			keys.set(member, key);
		}
		return key;
	};
	for (const member of order) {
		if (clock.step()) yield;
		const file = fileOf(member);
		const objectId = c.object[member]!;
		let object = objects.get(objectId);
		if (object === undefined) {
			const raw = packages.string(objectId);
			const normalized = raw
				.trimStart()
				.replaceAll("\\", "/")
				.toLowerCase()
				.replace(/\((\d+)\)/gu, "[$1]");
			// Unicode case mappings can depend on the complete path across the dot.
			object = {
				raw,
				prefix:
					!/[^\p{ASCII}]/u.test(raw) && /^\/[^.]+\.[^.:]+$/u.test(normalized)
						? normalized + "."
						: undefined,
				hashes: new Map()
			};
			objects.set(objectId, object);
		}
		let hash: number | undefined;
		if (c.location[member] === 0 && object.prefix !== undefined) {
			const packageRow = packages.packageRow[member]!;
			let prefix = object.hashes.get(packageRow);
			if (prefix === undefined) {
				prefix = hashString(hashUnit(file.hash, 0), object.prefix);
				object.hashes.set(packageRow, prefix);
			}
			hash = hashField(prefix, packages.bytes(c.property[member]!));
		}
		if (hash === undefined) {
			if (c.location[member] === 2) {
				hash = hashString(hashUnit(file.hash, 1), normalizeTextPath(object.raw));
				hash = hashString(hashUnit(hash, 0), packages.string(c.row[member]!));
			} else {
				const property = packages.string(c.property[member]!);
				const path =
					c.location[member] === 1
						? `${object.raw}.${packages.string(c.row[member]!)}.${property}`
						: `${object.raw}.${property}`;
				hash = hashString(hashUnit(file.hash, 0), manifestPlace(path) ?? path);
			}
		}
		const head = heads.get(hash);
		if (head === undefined) {
			heads.set(hash, member);
			places[member] = count++;
			continue;
		}
		const key = keyOf(member);
		let match = head;
		while (match !== absent && keyOf(match) !== key) match = next[match]!;
		if (match !== absent) places[member] = places[match]!;
		else {
			places[member] = count++;
			next[member] = head;
			heads.set(hash, member);
		}
	}
	return places;
}
