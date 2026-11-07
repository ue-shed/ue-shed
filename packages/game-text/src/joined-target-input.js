import { textLocationPath } from "./text-origin.js";
import { decodeWtf8 } from "./wtf8.js";
import { keyedUnitId } from "./gathered-text.js";
import { projectRelativePath } from "./project-relative-path.js";
import { HostSliceClock, sortRowsInSlices } from "./host-slices.js";
import { Effect, Schema } from "effect";
import { localizationGatherCoverage } from "./localization.js";
import { snapshotCheck, snapshotFailure } from "./snapshot-format.js";
import { TextOccurrenceId } from "./identifiers.js";
export const absent = 0xffffffff;
export const u32 = Effect.fn("JoinedTarget.u32")(function* (reader, name) {
    const value = yield* reader.section(name);
    if (!(value instanceof Uint32Array))
        return yield* snapshotFailure(name, "Expected u32 column");
    return value;
});
/** Only rule-dependent segments expand. UTF-8 and offsets stay outside the JS heap. */
export class JoinStrings {
    loaded = new Map();
    reader;
    empty;
    constructor(reader, empty) {
        this.reader = reader;
        this.empty = empty;
    }
    segment(id) {
        const segments = this.reader.manifest.segments;
        let low = 0, high = segments.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (segments[mid].start <= id)
                low = mid + 1;
            else
                high = mid;
        }
        const index = low - 1;
        snapshotCheck(index >= 0 && id < segments[index].start + segments[index].count, "join.string", "ID outside dependency");
        return index;
    }
    need(columns) {
        const empty = this.empty, segmentOf = (id) => this.segment(id), loaded = this.loaded, reader = this.reader;
        return Effect.gen(function* () {
            const segments = reader.manifest.segments, selected = new Uint8Array(segments.length), clock = new HostSliceClock();
            // Consecutive IDs usually share a segment, which skips its binary search.
            let low = 0, high = 0;
            for (const values of columns)
                for (let row = 0; row < values.length; row++) {
                    const id = values[row];
                    if (id !== empty && (id < low || id >= high)) {
                        const segment = segmentOf(id);
                        selected[segment] = 1;
                        low = segments[segment].start;
                        high = low + segments[segment].count;
                    }
                    if (clock.step())
                        yield* Effect.yieldNow;
                }
            for (let segment = 0; segment < selected.length; segment++)
                if (selected[segment] && !loaded.has(segment))
                    loaded.set(segment, yield* reader.packedSegment(segment));
        });
    }
    bytes(id) {
        if (id === this.empty)
            return Buffer.alloc(0);
        const segment = this.segment(id), packed = this.loaded.get(segment);
        snapshotCheck(packed !== undefined, "join.string", "Segment was not requested");
        const local = id - this.reader.manifest.segments[segment].start;
        return packed.bytes.subarray(packed.offsets[local], packed.offsets[local + 1]);
    }
    string(id) {
        return decodeWtf8(this.bytes(id));
    }
}
const FileMeta = Schema.Struct({
    format: Schema.Literals(["manifest", "archive", "po", "locres"]),
    count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    poFormat: Schema.Literals(["Unreal", "Crowdin"]),
    hasSourceText: Schema.Boolean,
    pathPrefix: Schema.optionalKey(Schema.String)
});
const FileMetaJson = Schema.fromJsonString(FileMeta);
const decodeFileMetaJson = Schema.decodeEffect(FileMetaJson);
export const loadJoinFile = Effect.fn("JoinedTarget.file")(function* (reader, name, failure) {
    const columns = {};
    if (failure !== undefined || !reader.manifest.active[name])
        return {
            name,
            missing: failure === undefined || failure === "file_missing",
            hasSourceText: false,
            pathPrefix: "",
            columns,
            order: new Uint32Array()
        };
    const file = yield* reader.layer(name);
    const meta = yield* decodeFileMetaJson(new TextDecoder().decode(yield* file.section("file.meta")));
    for (const field of [
        "namespace",
        "key",
        "source",
        "source-extra",
        "translation-extra",
        "translation",
        "options",
        "ordinal",
        "path",
        "notes",
        "metadata"
    ])
        columns[field] = yield* u32(file, `entry.${field}`);
    for (const values of Object.values(columns))
        snapshotCheck(values.length === meta.count, "join.file", "Column lengths differ");
    const order = Uint32Array.from({ length: meta.count }, (_, index) => index);
    order.sort((a, b) => columns.namespace[a] - columns.namespace[b] ||
        columns.key[a] - columns.key[b] ||
        columns.ordinal[a] - columns.ordinal[b]);
    return {
        name,
        reader: file,
        missing: false,
        hasSourceText: meta.hasSourceText,
        pathPrefix: meta.pathPrefix ?? "",
        columns,
        order
    };
});
export const occurrenceFields = [
    "source",
    "notes",
    "namespace",
    "key",
    "object",
    "property",
    "class",
    "row",
    "identity",
    "location",
    "editable",
    "audience",
    // OCCURRENCE_HAS_COPIES | OCCURRENCE_COPY_DIFFERS from the package layer.
    "copies"
];
export const normalizedPackagePath = (path) => path.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
export function pathHash(path) {
    let hash = 2166136261;
    for (let index = 0; index < path.length; index++)
        hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
    return hash >>> 0;
}
export function packagePath(packages, row) {
    return projectRelativePath(packages.projectRoot, packages.strings.string(packages.paths[row]));
}
export function packageStatus(packages, path) {
    const hash = pathHash(path), order = packages.order;
    let low = 0, high = order.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (packages.hash[order[mid]] < hash)
            low = mid + 1;
        else
            high = mid;
    }
    let status;
    for (; low < order.length && packages.hash[order[low]] === hash; low++) {
        const row = order[low];
        if (normalizedPackagePath(packagePath(packages, row)) !== path)
            continue;
        const next = packages.status[row];
        if (status === 3 || (status === 1 && next === 0))
            continue;
        status = next;
    }
    return status;
}
export function occurrenceLocation(packages, row) {
    const { occurrence: c, strings } = packages;
    const objectPath = strings.string(c.object[row]);
    if (c.location[row] === 2)
        return { kind: "string_table_entry", objectPath, entryKey: strings.string(c.row[row]) };
    const propertyPath = strings.string(c.property[row]);
    return c.location[row] === 1
        ? { kind: "data_table_cell", objectPath, propertyPath, row: strings.string(c.row[row]) }
        : {
            kind: "asset_property",
            objectPath,
            propertyPath,
            classPath: strings.string(c.class[row])
        };
}
export function unitId(packages, row, namespace, key) {
    const c = packages.occurrence, kind = c.identity[row];
    if (kind < 2 && key !== "")
        return keyedUnitId(kind === 1, namespace, key, c.location[row] === 2);
    const location = occurrenceLocation(packages, row);
    const suffix = location.kind === "string_table_entry"
        ? `entry:${location.entryKey}`
        : location.kind === "data_table_cell"
            ? `row:${location.row}:property:${location.propertyPath}`
            : location.kind === "code_place"
                ? `line:${location.line ?? ""}:macro:${location.macro}`
                : `property:${location.propertyPath}`;
    return `occurrence:${textLocationPath(location)}:${suffix}:${packagePath(packages, packages.packageRow[row])}`;
}
export const loadJoinPackages = Effect.fn("JoinedTarget.packages")(function* (reader, strings, projectRoot, target) {
    const clock = new HostSliceClock();
    const names = Object.keys(reader.manifest.active)
        .filter((name) => name.startsWith("package-text."))
        .sort();
    const shards = [];
    const starts = [];
    let occurrenceCount = 0, packageCount = 0;
    for (const name of names) {
        const file = yield* reader.layer(name), columns = {};
        for (const field of [
            "package.path",
            "package.status",
            "package.decode_errors",
            "package.occurrence_start",
            ...occurrenceFields.map((field) => `occurrence.${field}`)
        ])
            columns[field] = yield* u32(file, field);
        const count = columns["package.path"].length;
        snapshotCheck(columns["package.occurrence_start"].length === count + 1, "join.packages", "Invalid range column");
        starts.push(occurrenceCount);
        occurrenceCount += columns["occurrence.source"].length;
        packageCount += count;
        shards.push({ columns, count });
    }
    starts.push(occurrenceCount);
    // SAFETY: The closed occurrenceFields tuple initializes every required field with u32s.
    // Verified by: packages/game-text/src/index-refresh.test.ts
    // ("retains readers across refresh steps updating selected inputs and review")
    const occurrence = Object.fromEntries(occurrenceFields.map((field) => [field, new Uint32Array(occurrenceCount)]));
    const paths = new Uint32Array(packageCount), status = new Uint32Array(packageCount), packageRow = new Uint32Array(occurrenceCount), hash = new Uint32Array(packageCount), coverage = new Uint32Array(occurrenceCount);
    let pkg = 0, offset = 0;
    for (const shard of shards) {
        paths.set(shard.columns["package.path"], pkg);
        for (const field of occurrenceFields)
            occurrence[field].set(shard.columns[`occurrence.${field}`], offset);
        for (let row = 0; row < shard.count; row++, pkg++) {
            const c = shard.columns;
            let next = c["package.status"][row];
            // Preserve the diagnostic precedence not_gatherable -> partial. Decoder gaps are detail;
            // the reader's status already says whether gatherable text is missing.
            if (next === 2)
                next = 1;
            status[pkg] = next;
            const start = c["package.occurrence_start"][row], end = c["package.occurrence_start"][row + 1];
            snapshotCheck(start <= end && end <= c["occurrence.source"].length, "join.packages", "Invalid occurrence range");
            packageRow.fill(pkg, offset + start, offset + end);
            if (clock.step())
                yield* Effect.yieldNow;
        }
        offset += shard.columns["occurrence.source"].length;
    }
    yield* strings.need([paths, occurrence.class]);
    const packages = {
        names,
        starts,
        occurrence,
        packageRow,
        paths,
        status,
        hash,
        order: Uint32Array.from({ length: packageCount }, (_, row) => row),
        coverage,
        strings,
        projectRoot
    };
    let previousPackage = absent;
    let ratings = new Map();
    let currentPath = "";
    for (let row = 0; row < packageCount; row++) {
        hash[row] = pathHash(normalizedPackagePath(packagePath(packages, row)));
        if (clock.step())
            yield* Effect.yieldNow;
    }
    yield* sortRowsInSlices(packages.order, (a, b) => hash[a] - hash[b] || a - b, clock);
    for (let row = 0; row < occurrenceCount; row++) {
        if (clock.step())
            yield* Effect.yieldNow;
        const packageIndex = packageRow[row];
        if (packageIndex !== previousPackage) {
            previousPackage = packageIndex;
            ratings = new Map();
            currentPath = packagePath(packages, packageIndex);
        }
        const kind = occurrence.location[row], classId = occurrence.class[row], key = classId * 3 + kind;
        let rating = ratings.get(key);
        if (rating === undefined) {
            const location = kind === 2
                ? { kind: "string_table_entry", objectPath: "", entryKey: "" }
                : kind === 1
                    ? { kind: "data_table_cell", objectPath: "", propertyPath: "", row: "" }
                    : {
                        kind: "asset_property",
                        objectPath: "",
                        propertyPath: "",
                        classPath: strings.string(classId)
                    };
            const result = localizationGatherCoverage(target, {
                id: TextOccurrenceId.make("join"),
                packageFile: currentPath,
                source: "",
                devNotes: "",
                identity: { status: "unresolved", reason: "missing_key" },
                location,
                editCapability: "read_only"
            });
            rating =
                result.status === "unknown"
                    ? 2 +
                        [
                            "gather_settings_unavailable",
                            "class_hierarchy_unavailable",
                            "asset_class_unavailable",
                            "path_not_project_relative"
                        ].indexOf(result.reason)
                    : result.status === "inside"
                        ? 1
                        : 0;
            ratings.set(key, rating);
        }
        coverage[row] = rating;
    }
    return packages;
});
