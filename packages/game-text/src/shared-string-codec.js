import { isUtf8 } from "node:buffer";
import { decodeWtf8, encodeWtf8, hasWtf8Surrogate, isWtf8 } from "./wtf8.js";
import { snapshotCheck } from "./snapshot-format.js";
import { HostSliceClock, runHostStepsSync } from "./host-slices.js";
export const absentId = 0xffffffff;
export function packedStrings(values) {
    const offsets = new Float64Array(values.length + 1);
    let size = 0;
    for (let i = 0; i < values.length; i++) {
        offsets[i] = size;
        size += values[i].isWellFormed()
            ? Buffer.byteLength(values[i])
            : encodeWtf8(values[i]).length;
    }
    const bytes = Buffer.allocUnsafe(size);
    let position = 0;
    for (const value of values) {
        if (value.isWellFormed())
            position += bytes.write(value, position, "utf8");
        else {
            const encoded = encodeWtf8(value);
            bytes.set(encoded, position);
            position += encoded.length;
        }
    }
    offsets[values.length] = position;
    return { bytes, offsets };
}
export function stringBytes(strings, id) {
    return strings.bytes.subarray(strings.offsets[id], strings.offsets[id + 1]);
}
/** Native validation handles ordinary UTF-8 arenas; verify every individual string boundary. */
export function validatePackedStrings(strings, section) {
    const { bytes, offsets } = strings;
    snapshotCheck(offsets[0] === 0 && offsets.at(-1) === bytes.length, section, "Invalid packed lengths");
    const utf8 = isUtf8(bytes);
    for (let row = 1; row < offsets.length; row++) {
        const start = offsets[row - 1], end = offsets[row];
        snapshotCheck(Number.isSafeInteger(end) &&
            start <= end &&
            end <= bytes.length &&
            end - start <= 1024 ** 2, section, "Invalid packed string range");
        if (utf8)
            snapshotCheck(end === bytes.length || (bytes[end] & 0xc0) !== 0x80, section, "Invalid packed string boundary");
        else
            snapshotCheck(isWtf8(bytes.subarray(start, end)), section, "Invalid packed WTF-8");
    }
}
/** Comparators usually revisit one side of the previous pair. Retain two decoded IDs only. */
export function packedStringReader(strings) {
    let first = -1, second = -1, firstValue = "", secondValue = "";
    return (row) => {
        if (row === first)
            return firstValue;
        if (row === second) {
            [first, second] = [second, first];
            [firstValue, secondValue] = [secondValue, firstValue];
            return firstValue;
        }
        second = first;
        secondValue = firstValue;
        first = row;
        firstValue = decodeWtf8(stringBytes(strings, row));
        return firstValue;
    };
}
/** Decode bounded sort runs once, then retain only their heads during a stable locale merge. */
export function sortPackedStringsByLocale(strings, order = Uint32Array.from({ length: strings.offsets.length - 1 }, (_, row) => row), runSize = 8192) {
    return runHostStepsSync(sortPackedStringsByLocaleSteps(strings, order, runSize, new HostSliceClock(Infinity)));
}
/** Host steps for `sortPackedStringsByLocale`. The merge is stable, so every run size gives the
 * same order as one stable sort; callers in host slices use smaller runs.
 */
export function* sortPackedStringsByLocaleSteps(strings, order = Uint32Array.from({ length: strings.offsets.length - 1 }, (_, row) => row), runSize = 8192, clock = new HostSliceClock()) {
    snapshotCheck(Number.isInteger(runSize) && runSize > 0, "sort.locale", "Invalid sort run size");
    const rows = order.slice(), boundaries = [0];
    for (let start = 0; start < rows.length;) {
        let end = start, bytes = 0;
        while (end < rows.length && end - start < Math.min(runSize, 8192)) {
            const row = rows[end], length = strings.offsets[row + 1] - strings.offsets[row];
            if (end > start && bytes + length > 4 * 1024 ** 2)
                break;
            bytes += length;
            end++;
        }
        const values = Array.from(rows.subarray(start, end), (row) => decodeWtf8(stringBytes(strings, row)));
        const local = Uint32Array.from({ length: end - start }, (_, row) => row);
        local.sort((a, b) => values[a].localeCompare(values[b]));
        const sorted = Uint32Array.from(local, (row) => rows[start + row]);
        rows.set(sorted, start);
        boundaries.push(end);
        start = end;
        if (clock.expired())
            yield;
    }
    const runCount = boundaries.length - 1, cursors = Uint32Array.from(boundaries.slice(0, -1)), ends = Uint32Array.from(boundaries.slice(1)), keys = Array.from(cursors, (cursor) => decodeWtf8(stringBytes(strings, rows[cursor]))), heap = Uint32Array.from({ length: runCount }, (_, run) => run);
    let size = runCount;
    const before = (a, b) => {
        const compared = keys[a].localeCompare(keys[b]);
        return compared < 0 || (compared === 0 && a < b);
    };
    const down = (position) => {
        const value = heap[position];
        for (;;) {
            let child = position * 2 + 1;
            if (child >= size)
                break;
            if (child + 1 < size && before(heap[child + 1], heap[child]))
                child++;
            if (!before(heap[child], value))
                break;
            heap[position] = heap[child];
            position = child;
        }
        heap[position] = value;
    };
    for (let position = (size >>> 1) - 1; position >= 0; position--)
        down(position);
    const result = new Uint32Array(rows.length);
    for (let position = 0; position < result.length; position++) {
        const run = heap[0], cursor = cursors[run];
        result[position] = rows[cursor];
        cursors[run] = cursor + 1;
        if (cursor + 1 < ends[run])
            keys[run] = decodeWtf8(stringBytes(strings, rows[cursor + 1]));
        else
            heap[0] = heap[--size];
        if (size)
            down(0);
        if (clock.step())
            yield;
    }
    return result;
}
export function compareBytes(a, b) {
    return Buffer.compare(a, b);
}
/** Native range comparison avoids allocating two Buffer views for every sorted probe. */
export function comparePacked(a, ai, b, bi) {
    return a.bytes.compare(b.bytes, b.offsets[bi], b.offsets[bi + 1], a.offsets[ai], a.offsets[ai + 1]);
}
export function comparePackedKey(a, id, key) {
    return a.bytes.compare(key, 0, key.length, a.offsets[id], a.offsets[id + 1]);
}
/** MSD byte radix sort: IDs, histogram and scratch live outside V8's heap. */
export function sortBytes(strings, selected) {
    const order = selected ?? Uint32Array.from({ length: strings.offsets.length - 1 }, (_, i) => i);
    const scratch = new Uint32Array(order.length);
    const view = new DataView(strings.bytes.buffer, strings.bytes.byteOffset, strings.bytes.byteLength);
    const stack = [[0, order.length, 0]];
    const counts = new Uint32Array(257), starts = new Uint32Array(257);
    while (stack.length) {
        let [begin, end, depth] = stack.pop();
        if (end - begin < 2)
            continue;
        for (;;) {
            counts.fill(0);
            for (let row = begin; row < end; row++) {
                const id = order[row], position = strings.offsets[id] + depth;
                counts[position < strings.offsets[id + 1] ? strings.bytes[position] + 1 : 0]++;
            }
            let populated = 0, only = 0;
            for (let key = 0; key < 257; key++)
                if (counts[key]) {
                    populated++;
                    only = key;
                }
            if (populated === 1 && only !== 0) {
                depth++;
                // Long synthetic/source prefixes otherwise rescan the full partition per byte.
                const first = order[begin];
                while (strings.offsets[first] + depth + 4 <= strings.offsets[first + 1]) {
                    const word = view.getUint32(strings.offsets[first] + depth, true);
                    let same = true;
                    for (let row = begin + 1; row < end; row++) {
                        const id = order[row], position = strings.offsets[id] + depth;
                        if (position + 4 > strings.offsets[id + 1] ||
                            view.getUint32(position, true) !== word) {
                            same = false;
                            break;
                        }
                    }
                    if (!same)
                        break;
                    depth += 4;
                }
                continue;
            }
            if (populated === 1)
                break;
            let next = begin;
            for (let key = 0; key < 257; key++) {
                starts[key] = next;
                next += counts[key];
            }
            const cursors = starts.slice();
            for (let row = begin; row < end; row++) {
                const id = order[row], position = strings.offsets[id] + depth;
                const key = position < strings.offsets[id + 1] ? strings.bytes[position] + 1 : 0;
                scratch[cursors[key]] = id;
                cursors[key]++;
            }
            order.set(scratch.subarray(begin, end), begin);
            for (let key = 1; key < 257; key++)
                if (counts[key] > 1)
                    stack.push([starts[key], starts[key] + counts[key], depth + 1]);
            break;
        }
    }
    return order;
}
/** Typed byte arena and offsets. Only a bounded input block holds JavaScript strings. */
export class StringArena {
    bytes;
    offsets;
    size = 0;
    count = 0;
    owned;
    constructor(byteCapacity = 256 * 1024, stringCapacity = 4095, owned = false) {
        snapshotCheck(Number.isSafeInteger(byteCapacity) &&
            byteCapacity >= 0 &&
            byteCapacity <= 16 * 1024 ** 3 &&
            Number.isSafeInteger(stringCapacity) &&
            stringCapacity >= 0 &&
            stringCapacity < absentId, "strings", "Invalid arena capacity");
        this.owned = owned;
        this.bytes = (this.owned ? Buffer.allocUnsafeSlow : Buffer.allocUnsafe)(Math.max(1, byteCapacity));
        this.offsets =
            byteCapacity >= 0xffffffff
                ? new Float64Array(stringCapacity + 1)
                : new Uint32Array(stringCapacity + 1);
    }
    add(value) {
        this.reserve(value.length);
        this.bytes.set(value, this.size);
        this.size += value.length;
    }
    /** Adds the WTF-8 bytes of `value` without allocating a buffer per well-formed string. */
    addString(value) {
        if (!value.isWellFormed())
            return this.add(encodeWtf8(value));
        // UTF-8 of a well-formed string is its WTF-8 encoding.
        this.reserve(Buffer.byteLength(value, "utf8"));
        this.size += this.bytes.write(value, this.size, "utf8");
    }
    /** Starts a value of `length` bytes at the current size, growing the arena when needed. */
    reserve(length) {
        snapshotCheck(length <= 1024 ** 2 && this.size + length <= 16 * 1024 ** 3, "strings", "String arena exceeds the 16 GiB byte cap");
        if (this.size + length > this.bytes.length) {
            const next = (this.owned ? Buffer.allocUnsafeSlow : Buffer.allocUnsafe)(Math.min(16 * 1024 ** 3, Math.max(this.size + length, this.bytes.length * 2)));
            next.set(this.bytes.subarray(0, this.size));
            this.bytes = next;
        }
        if (this.count + 1 >= this.offsets.length) {
            const next = this.offsets instanceof Uint32Array
                ? new Uint32Array(this.offsets.length * 2)
                : new Float64Array(this.offsets.length * 2);
            next.set(this.offsets);
            this.offsets = next;
        }
        if (this.size + length >= 0xffffffff && this.offsets instanceof Uint32Array)
            this.offsets = Float64Array.from(this.offsets);
        this.offsets[this.count++] = this.size;
    }
    finish() {
        this.offsets[this.count] = this.size;
        return {
            bytes: this.bytes.subarray(0, this.size),
            offsets: this.offsets.subarray(0, this.count + 1)
        };
    }
}
function put(bytes, position, value) {
    while (value >= 128) {
        bytes[position++] = (value & 127) | 128;
        value >>>= 7;
    }
    bytes[position++] = value;
    return position;
}
function get(bytes, cursor) {
    let value = 0, shift = 0;
    for (;;) {
        snapshotCheck(cursor.position < bytes.length && shift <= 28, "front", "Invalid varint");
        const byte = bytes[cursor.position++];
        value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) {
            snapshotCheck(value <= 0xffffffff, "front", "Varint overflow");
            return value;
        }
        shift += 7;
    }
}
function nibble(byte) {
    if (byte >= 48 && byte <= 57)
        return byte - 48;
    if (byte >= 65 && byte <= 70)
        return byte - 55;
    if (byte >= 97 && byte <= 102)
        return byte - 87;
    return -1;
}
/** Tag 0: non-GUID front suffix; tags 1/2: 16 GUID bytes, optional case bitmap. */
export function encodeA64(values) {
    snapshotCheck(values.length > 0 && values.length <= 64, "front", "Invalid block count");
    const bytes = Buffer.allocUnsafe(values.reduce((n, value) => n + value.length + 12, 5));
    let position = put(bytes, 0, values.length), previous = Buffer.alloc(0);
    for (const value of values) {
        let guid = value.length === 32, mask = 0;
        for (let i = 0; guid && i < 32; i++) {
            guid = nibble(value[i]) >= 0;
            if (value[i] >= 65 && value[i] <= 70)
                mask = (mask | (1 << i)) >>> 0;
        }
        bytes[position++] = guid ? (mask ? 2 : 1) : 0;
        if (guid) {
            for (let i = 0; i < 32; i += 2)
                bytes[position++] = (nibble(value[i]) << 4) | nibble(value[i + 1]);
            if (mask) {
                bytes.writeUInt32LE(mask, position);
                position += 4;
            }
        }
        else {
            let prefix = 0;
            while (prefix < previous.length &&
                prefix < value.length &&
                previous[prefix] === value[prefix])
                prefix++;
            position = put(bytes, position, prefix);
            position = put(bytes, position, value.length - prefix);
            position += value.copy(bytes, position, prefix);
        }
        previous = value;
    }
    return bytes.subarray(0, position);
}
/** One scratch buffer per block; callers can scan without allocating a string per key. */
export function a64Cursor(bytes) {
    const cursor = { position: 0 }, count = get(bytes, cursor);
    let scratch = Buffer.allocUnsafe(Math.max(32, Math.min(bytes.length, 4096)));
    snapshotCheck(count > 0 && count <= 64, "front", "Invalid block count");
    let row = 0, length = 0;
    return {
        count,
        next() {
            if (row === count)
                return undefined;
            snapshotCheck(cursor.position < bytes.length, "front", "Missing value tag");
            const tag = bytes[cursor.position++];
            snapshotCheck(tag <= 2, "front", "Invalid value tag");
            if (tag) {
                const end = cursor.position + 16 + (tag === 2 ? 4 : 0);
                snapshotCheck(end <= bytes.length, "front", "Truncated GUID");
                const mask = tag === 2 ? bytes.readUInt32LE(cursor.position + 16) : 0;
                for (let i = 0; i < 32; i++) {
                    const value = bytes[cursor.position + (i >>> 1)];
                    const digit = i & 1 ? value & 15 : value >>> 4;
                    snapshotCheck(!(mask & (1 << i)) || digit >= 10, "front", "Invalid GUID case mask");
                    scratch[i] = digit < 10 ? digit + 48 : digit + (mask & (1 << i) ? 55 : 87);
                }
                cursor.position = end;
                length = 32;
            }
            else {
                const prefix = get(bytes, cursor), suffix = get(bytes, cursor);
                snapshotCheck(prefix <= length &&
                    prefix + suffix <= 1024 ** 2 &&
                    cursor.position + suffix <= bytes.length, "front", "Invalid front-code bounds");
                if (prefix + suffix > scratch.length) {
                    const next = Buffer.allocUnsafe(Math.max(prefix + suffix, scratch.length * 2));
                    scratch.copy(next, 0, 0, prefix);
                    scratch = next;
                }
                bytes.copy(scratch, prefix, cursor.position, cursor.position + suffix);
                cursor.position += suffix;
                length = prefix + suffix;
            }
            row++;
            if (row === count)
                snapshotCheck(cursor.position === bytes.length, "front", "Trailing block bytes");
            const value = scratch.subarray(0, length);
            snapshotCheck(isUtf8(value) || isWtf8(value), "front", "Invalid or non-canonical WTF-8");
            return value;
        }
    };
}
export function decodeA64(bytes) {
    const cursor = a64Cursor(bytes), values = [];
    for (let value = cursor.next(); value; value = cursor.next())
        values.push(Buffer.from(value));
    return values;
}
/** Decode directly into a caller's contiguous arena; validate UTF-8 once per block and its boundaries. */
export function decodeA64Into(bytes, output, first) {
    const cursor = { position: 0 }, count = get(bytes, cursor);
    snapshotCheck(count > 0 && count <= 64 && first + count < output.offsets.length, "front", "Invalid output block count");
    let position = output.offsets[first], previous = position, length = 0;
    const begin = position;
    for (let row = 0; row < count; row++) {
        snapshotCheck(cursor.position < bytes.length, "front", "Missing value tag");
        const tag = bytes[cursor.position++];
        snapshotCheck(tag <= 2, "front", "Invalid value tag");
        if (tag) {
            const end = cursor.position + 16 + (tag === 2 ? 4 : 0);
            snapshotCheck(end <= bytes.length && position + 32 <= output.bytes.length, "front", "Truncated GUID or output");
            const mask = tag === 2 ? bytes.readUInt32LE(cursor.position + 16) : 0;
            for (let i = 0; i < 32; i++) {
                const value = bytes[cursor.position + (i >>> 1)], digit = i & 1 ? value & 15 : value >>> 4;
                snapshotCheck(!(mask & (1 << i)) || digit >= 10, "front", "Invalid GUID case mask");
                output.bytes[position + i] =
                    digit < 10 ? digit + 48 : digit + (mask & (1 << i) ? 55 : 87);
            }
            cursor.position = end;
            length = 32;
        }
        else {
            const prefix = get(bytes, cursor), suffix = get(bytes, cursor);
            snapshotCheck(prefix <= length &&
                prefix + suffix <= 1024 ** 2 &&
                cursor.position + suffix <= bytes.length &&
                position + prefix + suffix <= output.bytes.length, "front", "Invalid front-code bounds");
            output.bytes.copy(output.bytes, position, previous, previous + prefix);
            bytes.copy(output.bytes, position + prefix, cursor.position, cursor.position + suffix);
            cursor.position += suffix;
            length = prefix + suffix;
        }
        // A continuation byte cannot start an entry, even if adjacent invalid entries form valid UTF-8 together.
        snapshotCheck(!length || (output.bytes[position] & 0xc0) !== 0x80, "front", "Invalid UTF-8 boundary");
        previous = position;
        position += length;
        output.offsets[first + row + 1] = position;
        const value = output.bytes.subarray(previous, position);
        if (hasWtf8Surrogate(value))
            snapshotCheck(isWtf8(value), "front", "Invalid or non-canonical WTF-8");
    }
    snapshotCheck(cursor.position === bytes.length &&
        (isUtf8(output.bytes.subarray(begin, position)) ||
            Array.from({ length: count }, (_, row) => row).every((row) => isWtf8(output.bytes.subarray(output.offsets[first + row], output.offsets[first + row + 1])))), "front", "Trailing bytes or invalid UTF-8");
    return count;
}
