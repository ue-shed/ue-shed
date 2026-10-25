/**
 * The Game Text engine's binary frames. Every message in both directions is a 12-byte
 * little-endian header (body length, kind, flags, two reserved bytes, the host's request ID) and
 * its body. `crates/game-text-index/src/session.rs` has the same numbers.
 */
export const FrameKind = {
	/** Host: a JSON `EngineRequest`. */
	request: 1,
	/** Host: stop the request; no body. */
	cancel: 2,
	/** Host: JSON `{ frames }`, the row frames it consumed. */
	credit: 3,
	/** Engine: one JSON part of an answer that isn't rows. */
	part: 16,
	/** Engine: a column batch. */
	batch: 17,
	/** Engine: UTF-8 rows a sink encoded for the stream. */
	text: 18,
	/** Engine: JSON progress. */
	progress: 19,
	/** Engine: JSON `EngineEnd`; the request finished. */
	end: 20,
	/** Engine: JSON `EngineFailure`; the request failed. */
	error: 21,
	/** Engine: JSON `EngineEnd`; the request stopped when cancelled. */
	cancelled: 22
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export const FRAME_HEADER_BYTES = 12;
/** The largest body a frame carries, in either direction. */
export const MAX_FRAME_BODY_BYTES = 8 * 1024 * 1024;
/** `flags` bit 0: the request's last frame. */
export const LAST_FRAME = 1;

export interface EngineFrame {
	readonly kind: number;
	readonly flags: number;
	readonly request: number;
	/** The body in its own buffer, so typed-array views over it are aligned. */
	readonly body: ArrayBuffer;
}

/** A frame the engine sent outside the format: an engine defect, which ends the session. */
export class MalformedFrame extends Error {
	override readonly name = "MalformedFrame";
}

export function encodeFrame(
	kind: FrameKind,
	request: number,
	body: Uint8Array = new Uint8Array(0)
): Uint8Array {
	const frame = new Uint8Array(FRAME_HEADER_BYTES + body.byteLength);
	const header = new DataView(frame.buffer);
	header.setUint32(0, body.byteLength, true);
	header.setUint8(4, kind);
	header.setUint32(8, request, true);
	frame.set(body, FRAME_HEADER_BYTES);
	return frame;
}

/**
 * Splits the engine's output into frames. Chunks gather in one growable buffer, and each body is
 * copied out once, into its own `ArrayBuffer`.
 */
export class FrameDecoder {
	private buffer = new Uint8Array(64 * 1024);
	private start = 0;
	private end = 0;

	/** Whether a frame is partly read. */
	get partial(): boolean {
		return this.end > this.start;
	}

	push(chunk: Uint8Array): EngineFrame[] {
		this.reserve(chunk.byteLength);
		this.buffer.set(chunk, this.end);
		this.end += chunk.byteLength;
		const frames: EngineFrame[] = [];
		const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
		while (this.end - this.start >= FRAME_HEADER_BYTES) {
			const length = view.getUint32(this.start, true);
			if (length > MAX_FRAME_BODY_BYTES)
				throw new MalformedFrame("A Game Text engine frame exceeds 8 MiB.");
			if (view.getUint16(this.start + 6, true) !== 0)
				throw new MalformedFrame("A Game Text engine frame's reserved bytes are set.");
			const bodyStart = this.start + FRAME_HEADER_BYTES;
			if (this.end - bodyStart < length) break;
			frames.push({
				kind: view.getUint8(this.start + 4),
				flags: view.getUint8(this.start + 5),
				request: view.getUint32(this.start + 8, true),
				body: this.buffer.slice(bodyStart, bodyStart + length).buffer
			});
			this.start = bodyStart + length;
		}
		if (this.start === this.end) this.start = this.end = 0;
		return frames;
	}

	/** Room for `bytes` more: move the unread bytes to the front, then grow. */
	private reserve(bytes: number): void {
		if (this.end + bytes <= this.buffer.byteLength) return;
		const unread = this.end - this.start;
		let size = this.buffer.byteLength;
		while (size < unread + bytes) size *= 2;
		if (size === this.buffer.byteLength) this.buffer.copyWithin(0, this.start, this.end);
		else {
			const next = new Uint8Array(size);
			next.set(this.buffer.subarray(this.start, this.end));
			this.buffer = next;
		}
		this.start = 0;
		this.end = unread;
	}
}
