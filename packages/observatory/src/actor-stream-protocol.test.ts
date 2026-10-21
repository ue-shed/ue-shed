import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ACTOR_STREAM_HEADER_BYTES,
	ACTOR_STREAM_MAX_BUFFERED_BYTES,
	ACTOR_STREAM_MAX_RECORDS,
	ACTOR_STREAM_RECORD_BYTES,
	ActorStreamDecoder,
	actorStreamPacketToTransformBatch,
	encodeActorStreamPacket
} from "./actor-stream-protocol.js";

import {
	actorStreamFixtures,
	fixtureDir,
	sessionId,
	twoRecords,
	validPacket
} from "./actor-stream-fixtures.test-support.js";

describe("actor stream protocol fixtures", () => {
	it("matches the checked-in contract bytes without rewriting them", () => {
		for (const [name, bytes] of actorStreamFixtures()) {
			expect(bytes, name).toEqual(readFileSync(join(fixtureDir, name)));
		}
	});

	it("round-trips a valid two-record packet", () => {
		const bytes = readFileSync(join(fixtureDir, "two-records.bin"));
		const decoder = new ActorStreamDecoder();
		const { malformed, packets } = decoder.push(bytes);
		expect(malformed).toBe(0);
		expect(packets).toHaveLength(1);
		const packet = packets[0];
		expect(packet).toMatchObject({
			actorsChanged: 2,
			actorsSampled: 2,
			catalogRevision: 7n,
			producerReplacements: 2,
			reset: false,
			sequence: 9n,
			sessionId,
			worldSeconds: 56.25
		});
		expect(packet?.records).toEqual(twoRecords);
	});

	it("decodes fragmented concatenated packets", () => {
		const bytes = readFileSync(join(fixtureDir, "fragmented-concat.bin"));
		const decoder = new ActorStreamDecoder();
		const first = decoder.push(bytes.subarray(0, 40));
		expect(first.packets).toHaveLength(0);
		const second = decoder.push(bytes.subarray(40, 120));
		expect(second.packets.length).toBeGreaterThanOrEqual(0);
		const rest = decoder.push(bytes.subarray(120));
		const packets = [...second.packets, ...rest.packets];
		expect(packets.map((packet) => packet.sequence)).toEqual([1n, 2n]);
	});

	it("accepts heartbeat and reset packets", () => {
		const decoder = new ActorStreamDecoder();
		expect(
			decoder.push(readFileSync(join(fixtureDir, "heartbeat.bin"))).packets[0]
		).toMatchObject({
			records: [],
			reset: false,
			sequence: 3n
		});
		expect(decoder.push(readFileSync(join(fixtureDir, "reset.bin"))).packets[0]).toMatchObject({
			records: [],
			reset: true,
			sequence: 4n
		});
	});

	it("resynchronizes after bad magic onto a valid packet", () => {
		const decoder = new ActorStreamDecoder();
		const { malformed, packets } = decoder.push(
			readFileSync(join(fixtureDir, "bad-magic-then-valid.bin"))
		);
		expect(malformed).toBeGreaterThan(0);
		expect(packets).toHaveLength(1);
		expect(packets[0]?.sequence).toBe(5n);
	});

	it("rejects unsupported version, oversized counts, and mismatched payload length", () => {
		const oversized = readFileSync(join(fixtureDir, "oversized-record-count.bin"));
		expect(oversized.readUInt32LE(12)).toBe(ACTOR_STREAM_MAX_RECORDS + 1);
		expect(oversized.readUInt32LE(16)).toBe(
			(ACTOR_STREAM_MAX_RECORDS + 1) * ACTOR_STREAM_RECORD_BYTES
		);
		const decoder = new ActorStreamDecoder();
		for (const name of [
			"unsupported-version.bin",
			"oversized-record-count.bin",
			"mismatched-payload-length.bin"
		] as const) {
			const { malformed, packets } = decoder.push(readFileSync(join(fixtureDir, name)));
			expect(packets).toHaveLength(0);
			expect(malformed).toBeGreaterThan(0);
		}
	});

	it("waits on truncated input without allocating a payload", () => {
		const decoder = new ActorStreamDecoder();
		const { malformed, packets } = decoder.push(
			readFileSync(join(fixtureDir, "truncated.bin"))
		);
		expect(packets).toHaveLength(0);
		expect(malformed).toBe(0);
		expect(decoder.metrics().bufferedBytes).toBe(ACTOR_STREAM_HEADER_BYTES - 8);
	});

	it("rejects non-finite transform values before they reach the observation store", () => {
		const decoder = new ActorStreamDecoder();
		const { malformed, packets } = decoder.push(
			validPacket({
				records: [
					{
						...twoRecords[0]!,
						rotation: { ...twoRecords[0]!.rotation, pitch: Number.NaN }
					}
				]
			})
		);
		expect(packets).toHaveLength(0);
		expect(malformed).toBe(1);
	});
});

describe("actor stream decoder limits", () => {
	it("caps record count and payload before reading records", () => {
		const decoder = new ActorStreamDecoder();
		const oversized = encodeActorStreamPacket({
			catalogRevision: 1n,
			corrupt: {
				recordCount: ACTOR_STREAM_MAX_RECORDS + 1
			},
			records: [],
			sequence: 1n,
			sessionId
		});
		const { malformed, packets } = decoder.push(oversized);
		expect(packets).toHaveLength(0);
		expect(malformed).toBeGreaterThan(0);
	});

	it("bounds undecoded buffered bytes", () => {
		const decoder = new ActorStreamDecoder();
		const noise = Buffer.alloc(ACTOR_STREAM_MAX_BUFFERED_BYTES + 64, 0xab);
		decoder.push(noise);
		expect(decoder.metrics().bufferedBytes).toBeLessThanOrEqual(
			ACTOR_STREAM_MAX_BUFFERED_BYTES
		);
		expect(decoder.metrics().malformed).toBeGreaterThan(0);
	});

	it("maps decoded packets into transform batches without metadata strings", () => {
		const decoder = new ActorStreamDecoder();
		const packet = decoder.push(validPacket()).packets[0];
		expect(packet).toBeDefined();
		if (packet === undefined) return;
		const batch = actorStreamPacketToTransformBatch(packet);
		expect(batch.sessionId).toBe(sessionId);
		expect(batch.revision).toBe(7n);
		expect(batch.transforms[1]?.transform.rotation).toEqual({ x: 0, y: 0, z: 180 });
	});
});
