import { describe, expect, test } from "vitest";
import { CAMERA_FRAME_HEADER_BYTES, CameraFrameDecoder } from "./index.js";

function frame(sequence: bigint, payload = Buffer.from([1, 2, 3, 4])): Buffer {
	const header = Buffer.alloc(CAMERA_FRAME_HEADER_BYTES);
	header.write("USCF");
	header.writeUInt16LE(1, 4);
	header.writeUInt16LE(CAMERA_FRAME_HEADER_BYTES, 6);
	header.writeUInt32LE(1, 12);
	header.writeUInt32LE(1, 16);
	header.writeUInt32LE(4, 20);
	header.writeUInt32LE(payload.length, 24);
	header.writeUInt32LE(3, 28);
	header.writeBigUInt64LE(sequence, 32);
	return Buffer.concat([header, payload]);
}

describe("CameraFrameDecoder", () => {
	test("decodes fragmented frames without losing binary payloads", () => {
		const decoder = new CameraFrameDecoder();
		const encoded = frame(42n);
		expect(decoder.push(encoded.subarray(0, 51)).frames).toHaveLength(0);
		const decoded = decoder.push(encoded.subarray(51));
		expect(decoded.frames[0]?.sequence).toBe(42n);
		expect(decoded.frames[0]?.pixels).toEqual(Uint8Array.from([1, 2, 3, 4]));
	});

	test("resynchronizes after malformed bytes", () => {
		const decoder = new CameraFrameDecoder();
		const decoded = decoder.push(Buffer.concat([Buffer.from("garbage"), frame(7n)]));
		expect(decoded.malformed).toBe(1);
		expect(decoded.frames[0]?.sequence).toBe(7n);
	});

	test("decodes consecutive frames across small transport chunks", () => {
		const decoder = new CameraFrameDecoder();
		const encoded = Buffer.concat([frame(8n), frame(9n)]);
		const sequences: bigint[] = [];
		for (let offset = 0; offset < encoded.length; offset += 7) {
			for (const decoded of decoder.push(encoded.subarray(offset, offset + 7)).frames) {
				sequences.push(decoded.sequence);
			}
		}
		expect(sequences).toEqual([8n, 9n]);
	});
});
