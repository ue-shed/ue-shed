import {
	CatalogRevision,
	ObservationSessionId,
	PacketSequence,
	StreamActorIndex,
	type WorldTransformBatch
} from "./world-observation.js";

export const ACTOR_STREAM_MAGIC = new Uint8Array([0x55, 0x53, 0x4f, 0x54]); // USOT
export const ACTOR_STREAM_VERSION = 1;
export const ACTOR_STREAM_HEADER_BYTES = 96;
export const ACTOR_STREAM_RECORD_BYTES = 48;
export const ACTOR_STREAM_MAX_RECORDS = 16_384;
export const ACTOR_STREAM_MAX_PAYLOAD_BYTES = ACTOR_STREAM_MAX_RECORDS * ACTOR_STREAM_RECORD_BYTES;
/** Maximum undecoded bytes retained by the incremental decoder before discarding. */
export const ACTOR_STREAM_MAX_BUFFERED_BYTES =
	ACTOR_STREAM_HEADER_BYTES + ACTOR_STREAM_MAX_PAYLOAD_BYTES + 64 * 1024;
export const ACTOR_STREAM_FLAG_RESET = 0x0001;

export interface ActorStreamRecord {
	readonly flags: number;
	readonly location: { readonly x: number; readonly y: number; readonly z: number };
	readonly rotation: { readonly pitch: number; readonly roll: number; readonly yaw: number };
	readonly streamIndex: number;
}

export interface ActorStreamPacket {
	readonly actorsChanged: number;
	readonly actorsSampled: number;
	readonly catalogRevision: bigint;
	/** Host time spent decoding this complete packet after framing and limit validation. */
	readonly decodeDurationMs: number;
	readonly flags: number;
	readonly producerMonotonicMs: number;
	readonly producerReplacements: number;
	readonly records: ReadonlyArray<ActorStreamRecord>;
	readonly reset: boolean;
	readonly samplingDurationMicros: number;
	readonly sequence: bigint;
	readonly sessionId: string;
	readonly worldSeconds: number;
}

export interface EncodeActorStreamPacketInput {
	readonly actorsChanged?: number;
	readonly actorsSampled?: number;
	readonly catalogRevision: bigint;
	readonly flags?: number;
	readonly producerMonotonicMs?: number;
	readonly producerReplacements?: number;
	readonly records?: ReadonlyArray<ActorStreamRecord>;
	readonly samplingDurationMicros?: number;
	readonly sequence: bigint;
	readonly sessionId: string;
	readonly version?: number;
	readonly worldSeconds?: number;
	/** Test-only overrides that intentionally break the contract. */
	readonly corrupt?: {
		readonly headerBytes?: number;
		readonly magic?: string;
		readonly payloadLength?: number;
		readonly recordBytes?: number;
		readonly recordCount?: number;
		readonly reserved20?: number;
	};
}

function sessionIdBytes(sessionId: string): Buffer {
	const normalized = sessionId.replace(/-/g, "").toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(normalized)) {
		throw new Error(`Observation session ID must be 16 bytes hex, got ${sessionId}`);
	}
	return Buffer.from(normalized, "hex");
}

function bytesToSessionId(buffer: Buffer, offset: number): string {
	return buffer.subarray(offset, offset + 16).toString("hex");
}

/** Test/benchmark encoder. Production Unreal owns the on-wire producer. */
export function encodeActorStreamPacket(input: EncodeActorStreamPacketInput): Buffer {
	const records = input.records ?? [];
	const recordCount = input.corrupt?.recordCount ?? records.length;
	const payloadLength = input.corrupt?.payloadLength ?? recordCount * ACTOR_STREAM_RECORD_BYTES;
	const headerBytes = input.corrupt?.headerBytes ?? ACTOR_STREAM_HEADER_BYTES;
	const recordBytes = input.corrupt?.recordBytes ?? ACTOR_STREAM_RECORD_BYTES;
	const version = input.version ?? ACTOR_STREAM_VERSION;
	const flags = input.flags ?? 0;
	const header = Buffer.alloc(ACTOR_STREAM_HEADER_BYTES);
	header.write(input.corrupt?.magic ?? "USOT", 0, 4, "ascii");
	header.writeUInt16LE(version, 4);
	header.writeUInt16LE(headerBytes, 6);
	header.writeUInt16LE(recordBytes, 8);
	header.writeUInt16LE(flags, 10);
	header.writeUInt32LE(recordCount >>> 0, 12);
	header.writeUInt32LE(payloadLength >>> 0, 16);
	header.writeUInt32LE(input.corrupt?.reserved20 ?? 0, 20);
	header.writeBigUInt64LE(input.sequence, 24);
	header.writeDoubleLE(input.worldSeconds ?? 0, 32);
	header.writeDoubleLE(input.producerMonotonicMs ?? 0, 40);
	sessionIdBytes(input.sessionId).copy(header, 48);
	header.writeBigUInt64LE(input.catalogRevision, 64);
	header.writeUInt32LE(input.actorsSampled ?? records.length, 72);
	header.writeUInt32LE(input.actorsChanged ?? records.length, 76);
	header.writeUInt32LE(input.producerReplacements ?? 0, 80);
	header.writeUInt32LE(input.samplingDurationMicros ?? 0, 84);
	header.writeBigUInt64LE(0n, 88);

	const payload = Buffer.alloc(Math.max(0, records.length) * ACTOR_STREAM_RECORD_BYTES);
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record === undefined) continue;
		const offset = index * ACTOR_STREAM_RECORD_BYTES;
		payload.writeUInt32LE(record.streamIndex >>> 0, offset);
		payload.writeUInt32LE(record.flags >>> 0, offset + 4);
		payload.writeDoubleLE(record.location.x, offset + 8);
		payload.writeDoubleLE(record.location.y, offset + 16);
		payload.writeDoubleLE(record.location.z, offset + 24);
		payload.writeFloatLE(record.rotation.roll, offset + 32);
		payload.writeFloatLE(record.rotation.pitch, offset + 36);
		payload.writeFloatLE(record.rotation.yaw, offset + 40);
		payload.writeUInt32LE(0, offset + 44);
	}

	if (payloadLength === payload.length) return Buffer.concat([header, payload]);
	if (payloadLength < payload.length) {
		return Buffer.concat([header, payload.subarray(0, payloadLength)]);
	}
	return Buffer.concat([header, payload, Buffer.alloc(payloadLength - payload.length)]);
}

function decodeRecord(buffer: Buffer, offset: number): ActorStreamRecord {
	return {
		flags: buffer.readUInt32LE(offset + 4),
		location: {
			x: buffer.readDoubleLE(offset + 8),
			y: buffer.readDoubleLE(offset + 16),
			z: buffer.readDoubleLE(offset + 24)
		},
		rotation: {
			pitch: buffer.readFloatLE(offset + 36),
			roll: buffer.readFloatLE(offset + 32),
			yaw: buffer.readFloatLE(offset + 40)
		},
		streamIndex: buffer.readUInt32LE(offset)
	};
}

function decodePacket(
	header: Buffer,
	payload: Buffer
): Omit<ActorStreamPacket, "decodeDurationMs"> {
	const flags = header.readUInt16LE(10);
	const recordCount = header.readUInt32LE(12);
	const records: ActorStreamRecord[] = [];
	for (let index = 0; index < recordCount; index += 1) {
		records.push(decodeRecord(payload, index * ACTOR_STREAM_RECORD_BYTES));
	}
	return {
		actorsChanged: header.readUInt32LE(76),
		actorsSampled: header.readUInt32LE(72),
		catalogRevision: header.readBigUInt64LE(64),
		flags,
		producerMonotonicMs: header.readDoubleLE(40),
		producerReplacements: header.readUInt32LE(80),
		records,
		reset: (flags & ACTOR_STREAM_FLAG_RESET) !== 0,
		samplingDurationMicros: header.readUInt32LE(84),
		sequence: header.readBigUInt64LE(24),
		sessionId: bytesToSessionId(header, 48),
		worldSeconds: header.readDoubleLE(32)
	};
}

function hasFiniteValues(packet: Omit<ActorStreamPacket, "decodeDurationMs">): boolean {
	if (!Number.isFinite(packet.producerMonotonicMs) || !Number.isFinite(packet.worldSeconds)) {
		return false;
	}
	return packet.records.every(
		(record) =>
			Number.isFinite(record.location.x) &&
			Number.isFinite(record.location.y) &&
			Number.isFinite(record.location.z) &&
			Number.isFinite(record.rotation.pitch) &&
			Number.isFinite(record.rotation.roll) &&
			Number.isFinite(record.rotation.yaw)
	);
}

export class ActorStreamDecoder {
	private readonly chunks: Buffer[] = [];
	private bufferedBytes = 0;
	private headOffset = 0;
	private malformedCount = 0;

	readonly metrics = () => ({
		bufferedBytes: this.bufferedBytes,
		malformed: this.malformedCount
	});

	private discard(byteCount: number): void {
		let remaining = byteCount;
		while (remaining > 0 && this.chunks.length > 0) {
			const head = this.chunks[0];
			if (!head) return;
			const available = head.length - this.headOffset;
			const consumed = Math.min(available, remaining);
			this.headOffset += consumed;
			this.bufferedBytes -= consumed;
			remaining -= consumed;
			if (this.headOffset === head.length) {
				this.chunks.shift();
				this.headOffset = 0;
			}
		}
	}

	private read(byteCount: number): Buffer | undefined {
		if (this.bufferedBytes < byteCount) return undefined;
		const head = this.chunks[0];
		if (head && head.length - this.headOffset >= byteCount) {
			const result = head.subarray(this.headOffset, this.headOffset + byteCount);
			this.discard(byteCount);
			return result;
		}
		const result = Buffer.allocUnsafe(byteCount);
		let written = 0;
		while (written < byteCount) {
			const chunk = this.chunks[0];
			if (!chunk) return undefined;
			const copied = Math.min(chunk.length - this.headOffset, byteCount - written);
			chunk.copy(result, written, this.headOffset, this.headOffset + copied);
			this.discard(copied);
			written += copied;
		}
		return result;
	}

	private peek(byteCount: number): Buffer | undefined {
		if (this.bufferedBytes < byteCount) return undefined;
		const head = this.chunks[0];
		if (head && head.length - this.headOffset >= byteCount) {
			return head.subarray(this.headOffset, this.headOffset + byteCount);
		}
		const result = Buffer.allocUnsafe(byteCount);
		let written = 0;
		for (const chunk of this.chunks) {
			const start = chunk === head ? this.headOffset : 0;
			const copied = Math.min(chunk.length - start, byteCount - written);
			chunk.copy(result, written, start, start + copied);
			written += copied;
			if (written === byteCount) return result;
		}
		return undefined;
	}

	private startsWithMagic(): boolean {
		if (this.bufferedBytes < ACTOR_STREAM_MAGIC.length) return false;
		const head = this.chunks[0];
		if (head && head.length - this.headOffset >= ACTOR_STREAM_MAGIC.length) {
			const slice = head.subarray(
				this.headOffset,
				this.headOffset + ACTOR_STREAM_MAGIC.length
			);
			for (let index = 0; index < ACTOR_STREAM_MAGIC.length; index += 1) {
				if (slice[index] !== ACTOR_STREAM_MAGIC[index]) return false;
			}
			return true;
		}
		let offset = 0;
		for (const chunk of this.chunks) {
			const start = chunk === head ? this.headOffset : 0;
			for (
				let index = start;
				index < chunk.length && offset < ACTOR_STREAM_MAGIC.length;
				index += 1
			) {
				if (chunk[index] !== ACTOR_STREAM_MAGIC[offset]) return false;
				offset += 1;
			}
			if (offset === ACTOR_STREAM_MAGIC.length) return true;
		}
		return false;
	}

	private enforceBufferCap(): void {
		while (this.bufferedBytes > ACTOR_STREAM_MAX_BUFFERED_BYTES) {
			this.discard(1);
			this.malformedCount += 1;
		}
	}

	push(chunk: Uint8Array) {
		if (chunk.byteLength > 0) {
			this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			this.bufferedBytes += chunk.byteLength;
			this.enforceBufferCap();
		}
		const packets: ActorStreamPacket[] = [];
		let malformed = 0;
		while (this.bufferedBytes >= ACTOR_STREAM_HEADER_BYTES) {
			if (!this.startsWithMagic()) {
				do {
					this.discard(1);
				} while (
					this.bufferedBytes >= ACTOR_STREAM_MAGIC.length &&
					!this.startsWithMagic()
				);
				malformed += 1;
				this.malformedCount += 1;
				continue;
			}
			const header = this.peek(ACTOR_STREAM_HEADER_BYTES);
			if (!header) break;
			const version = header.readUInt16LE(4);
			const headerBytes = header.readUInt16LE(6);
			const recordBytes = header.readUInt16LE(8);
			const recordCount = header.readUInt32LE(12);
			const payloadBytes = header.readUInt32LE(16);
			const reserved20 = header.readUInt32LE(20);
			const valid =
				version === ACTOR_STREAM_VERSION &&
				headerBytes === ACTOR_STREAM_HEADER_BYTES &&
				recordBytes === ACTOR_STREAM_RECORD_BYTES &&
				recordCount <= ACTOR_STREAM_MAX_RECORDS &&
				payloadBytes === recordCount * ACTOR_STREAM_RECORD_BYTES &&
				payloadBytes <= ACTOR_STREAM_MAX_PAYLOAD_BYTES &&
				reserved20 === 0;
			if (!valid) {
				this.discard(4);
				malformed += 1;
				this.malformedCount += 1;
				continue;
			}
			if (this.bufferedBytes < headerBytes + payloadBytes) break;
			const decodeStarted = performance.now();
			this.discard(headerBytes);
			const payload = payloadBytes === 0 ? Buffer.alloc(0) : this.read(payloadBytes);
			if (payloadBytes > 0 && !payload) break;
			const packet = decodePacket(header, payload ?? Buffer.alloc(0));
			if (!hasFiniteValues(packet)) {
				malformed += 1;
				this.malformedCount += 1;
				continue;
			}
			packets.push({
				...packet,
				decodeDurationMs: performance.now() - decodeStarted
			});
		}
		return { malformed, packets };
	}
}

export function actorStreamPacketToTransformBatch(packet: ActorStreamPacket): WorldTransformBatch {
	// Fixed-layout and finite-value checks run in ActorStreamDecoder. Avoiding Schema.make here
	// keeps the hot transform path allocation-light without trusting unvalidated pipe input.
	return {
		actorsChanged: packet.actorsChanged,
		actorsSampled: packet.actorsSampled,
		producerMonotonicMs: packet.producerMonotonicMs,
		producerReplacements: packet.producerReplacements,
		revision: CatalogRevision.make(packet.catalogRevision),
		sequence: PacketSequence.make(packet.sequence),
		sessionId: ObservationSessionId.make(packet.sessionId),
		transforms: packet.records.map((record) => ({
			streamIndex: StreamActorIndex.make(record.streamIndex),
			transform: {
				location: record.location,
				rotation: {
					x: record.rotation.roll,
					y: record.rotation.pitch,
					z: record.rotation.yaw
				}
			}
		})),
		worldSeconds: packet.worldSeconds
	} satisfies WorldTransformBatch;
}
