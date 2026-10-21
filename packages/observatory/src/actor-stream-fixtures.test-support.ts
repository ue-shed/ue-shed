import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ACTOR_STREAM_FLAG_RESET,
	ACTOR_STREAM_HEADER_BYTES,
	ACTOR_STREAM_MAX_RECORDS,
	encodeActorStreamPacket,
	type ActorStreamRecord
} from "./actor-stream-protocol.js";

export const sessionId = "0123456789abcdef0123456789abcdef";
export const fixtureDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../protocol/contracts/observatory/v1/fixtures"
);

export const twoRecords: ReadonlyArray<ActorStreamRecord> = [
	{
		flags: 0,
		location: { x: 10, y: -20, z: 30 },
		rotation: { pitch: 1.5, roll: 0.25, yaw: 90 },
		streamIndex: 0
	},
	{
		flags: 0,
		location: { x: 100, y: 200, z: 0 },
		rotation: { pitch: 0, roll: 0, yaw: 180 },
		streamIndex: 3
	}
];

export function validPacket(args?: {
	readonly flags?: number;
	readonly records?: ReadonlyArray<ActorStreamRecord>;
	readonly sequence?: bigint;
}): Buffer {
	return encodeActorStreamPacket({
		catalogRevision: 7n,
		flags: args?.flags ?? 0,
		producerMonotonicMs: 1234.5,
		producerReplacements: 2,
		records: args?.records ?? twoRecords,
		samplingDurationMicros: 42,
		sequence: args?.sequence ?? 9n,
		sessionId,
		worldSeconds: 56.25
	});
}

export function actorStreamFixtures(): ReadonlyMap<string, Buffer> {
	const fixtures = new Map<string, Buffer>();
	const valid = validPacket();
	fixtures.set("two-records.bin", valid);
	fixtures.set(
		"fragmented-concat.bin",
		Buffer.concat([validPacket({ sequence: 1n }), validPacket({ sequence: 2n })])
	);
	fixtures.set("heartbeat.bin", validPacket({ records: [], sequence: 3n }));
	fixtures.set(
		"reset.bin",
		validPacket({ flags: ACTOR_STREAM_FLAG_RESET, records: [], sequence: 4n })
	);
	fixtures.set(
		"bad-magic-then-valid.bin",
		Buffer.concat([Buffer.from("XXXX"), validPacket({ sequence: 5n })])
	);
	fixtures.set(
		"unsupported-version.bin",
		encodeActorStreamPacket({
			catalogRevision: 1n,
			records: [],
			sequence: 1n,
			sessionId,
			version: 2
		})
	);
	fixtures.set(
		"oversized-record-count.bin",
		encodeActorStreamPacket({
			catalogRevision: 1n,
			corrupt: { recordCount: ACTOR_STREAM_MAX_RECORDS + 1 },
			records: [],
			sequence: 1n,
			sessionId
		}).subarray(0, ACTOR_STREAM_HEADER_BYTES)
	);
	fixtures.set(
		"mismatched-payload-length.bin",
		encodeActorStreamPacket({
			catalogRevision: 1n,
			corrupt: { payloadLength: 24 },
			records: twoRecords.slice(0, 1),
			sequence: 1n,
			sessionId
		})
	);
	fixtures.set("truncated.bin", valid.subarray(0, ACTOR_STREAM_HEADER_BYTES - 8));
	return fixtures;
}
