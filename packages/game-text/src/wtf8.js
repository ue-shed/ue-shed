/// <reference lib="es2024.string" />
/** Canonical WTF-8 preserves JavaScript's UTF-16 code units, including lone surrogates. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function encodeWtf8(value) {
    if (value.isWellFormed())
        return encoder.encode(value);
    const bytes = new Uint8Array(value.length * 3);
    let position = 0;
    for (let i = 0; i < value.length; i++) {
        let point = value.charCodeAt(i);
        if (point >= 0xd800 && point <= 0xdbff && i + 1 < value.length) {
            const trail = value.charCodeAt(i + 1);
            if (trail >= 0xdc00 && trail <= 0xdfff) {
                point = 0x10000 + ((point - 0xd800) << 10) + trail - 0xdc00;
                i++;
            }
        }
        if (point < 0x80)
            bytes[position++] = point;
        else if (point < 0x800) {
            bytes[position++] = 0xc0 | (point >>> 6);
            bytes[position++] = 0x80 | (point & 63);
        }
        else if (point < 0x10000) {
            bytes[position++] = 0xe0 | (point >>> 12);
            bytes[position++] = 0x80 | ((point >>> 6) & 63);
            bytes[position++] = 0x80 | (point & 63);
        }
        else {
            bytes[position++] = 0xf0 | (point >>> 18);
            bytes[position++] = 0x80 | ((point >>> 12) & 63);
            bytes[position++] = 0x80 | ((point >>> 6) & 63);
            bytes[position++] = 0x80 | (point & 63);
        }
    }
    return bytes.subarray(0, position);
}
/** The common path uses the platform's fatal UTF-8 decoder. */
export function hasWtf8Surrogate(bytes) {
    for (let i = bytes.indexOf(0xed); i >= 0; i = bytes.indexOf(0xed, i + 1))
        if (bytes[i + 1] >= 0xa0 && bytes[i + 1] <= 0xbf)
            return true;
    return false;
}
export function decodeWtf8(bytes) {
    if (!hasWtf8Surrogate(bytes))
        return decoder.decode(bytes);
    const chunks = [];
    let units = [], previousLead = false;
    for (let i = 0; i < bytes.length;) {
        const first = bytes[i++];
        let point, count, minimum;
        if (first < 0x80) {
            point = first;
            count = 0;
            minimum = 0;
        }
        else if (first >= 0xc2 && first <= 0xdf) {
            point = first & 31;
            count = 1;
            minimum = 0x80;
        }
        else if (first >= 0xe0 && first <= 0xef) {
            point = first & 15;
            count = 2;
            minimum = 0x800;
        }
        else if (first >= 0xf0 && first <= 0xf4) {
            point = first & 7;
            count = 3;
            minimum = 0x10000;
        }
        else
            throw new RangeError("Invalid WTF-8 leading byte");
        if (i + count > bytes.length)
            throw new RangeError("Truncated WTF-8 sequence");
        for (let n = 0; n < count; n++) {
            const next = bytes[i++];
            if ((next & 0xc0) !== 0x80)
                throw new RangeError("Invalid WTF-8 continuation byte");
            point = (point << 6) | (next & 63);
        }
        if (point < minimum || point > 0x10ffff)
            throw new RangeError("Invalid WTF-8 code point");
        if (previousLead && point >= 0xdc00 && point <= 0xdfff)
            throw new RangeError("Non-canonical WTF-8 surrogate pair");
        previousLead = point >= 0xd800 && point <= 0xdbff;
        if (point >= 0x10000) {
            point -= 0x10000;
            units.push(0xd800 + (point >>> 10), 0xdc00 + (point & 1023));
        }
        else
            units.push(point);
        if (units.length >= 4096) {
            chunks.push(String.fromCharCode(...units));
            units = [];
        }
    }
    chunks.push(String.fromCharCode(...units));
    return chunks.join("");
}
export function isWtf8(bytes) {
    try {
        decodeWtf8(bytes);
        return true;
    }
    catch {
        return false;
    }
}
