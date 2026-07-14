import {
	decodeCameraScheduleConfig,
	decodeCameraStatus,
	type CameraScheduleConfig,
	type CameraStatus
} from "@ue-shed/protocol";
import { Data, Effect, Schema } from "effect";
import { createServer, type Server, type Socket } from "node:net";

export const CAMERA_PIPE_NAME = "\\\\.\\pipe\\ue-shed-cameras-v1";
export const CAMERA_FRAME_HEADER_BYTES = 128;
const frameMagic = Buffer.from("USCF");
const maximumPayloadBytes = 16 * 1024 * 1024;

export interface CameraFrame {
	readonly cameraId: string;
	readonly cameraIndex: number;
	readonly captureMonotonicMs: number;
	readonly height: number;
	readonly pixels: Uint8Array;
	readonly producerId: string;
	readonly readbackDrops: number;
	readonly readbackLatencyMs: number;
	readonly receivedMonotonicMs: number;
	readonly sequence: bigint;
	readonly sessionId: string;
	readonly transportReplacements: number;
	readonly width: number;
	readonly worldSeconds: number;
}

export interface CameraFeedMetrics {
	readonly bytesReceived: number;
	readonly framesReceived: number;
	readonly malformedFrames: number;
	readonly receiverReplacements: number;
	readonly startedMonotonicMs: number;
}

export class CameraFeedError extends Data.TaggedError("CameraFeedError")<{
	readonly message: string;
	readonly operation: "listen" | "close";
	readonly pipeName: string;
	readonly retrySafe: boolean;
}> {}

function bytesToId(buffer: Buffer, offset: number): string {
	return buffer.subarray(offset, offset + 16).toString("hex");
}

export class CameraFrameDecoder {
	private readonly chunks: Buffer[] = [];
	private bufferedBytes = 0;
	private headOffset = 0;

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
		if (this.bufferedBytes < frameMagic.length) return false;
		const head = this.chunks[0];
		if (head && head.length - this.headOffset >= frameMagic.length) {
			return head
				.subarray(this.headOffset, this.headOffset + frameMagic.length)
				.equals(frameMagic);
		}
		let offset = 0;
		for (const chunk of this.chunks) {
			const start = chunk === head ? this.headOffset : 0;
			for (
				let index = start;
				index < chunk.length && offset < frameMagic.length;
				index += 1
			) {
				if (chunk[index] !== frameMagic[offset]) return false;
				offset += 1;
			}
			if (offset === frameMagic.length) return true;
		}
		return false;
	}

	push(chunk: Uint8Array): {
		readonly frames: ReadonlyArray<CameraFrame>;
		readonly malformed: number;
	} {
		if (chunk.byteLength > 0) {
			this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			this.bufferedBytes += chunk.byteLength;
		}
		const frames: Array<CameraFrame> = [];
		let malformed = 0;
		while (this.bufferedBytes >= CAMERA_FRAME_HEADER_BYTES) {
			if (!this.startsWithMagic()) {
				do {
					this.discard(1);
				} while (this.bufferedBytes >= frameMagic.length && !this.startsWithMagic());
				malformed += 1;
				continue;
			}
			const header = this.peek(CAMERA_FRAME_HEADER_BYTES);
			if (!header) break;
			const version = header.readUInt16LE(4);
			const headerBytes = header.readUInt16LE(6);
			const width = header.readUInt32LE(12);
			const height = header.readUInt32LE(16);
			const rowPitch = header.readUInt32LE(20);
			const payloadBytes = header.readUInt32LE(24);
			const valid =
				version === 1 &&
				headerBytes === CAMERA_FRAME_HEADER_BYTES &&
				width > 0 &&
				height > 0 &&
				rowPitch === width * 4 &&
				payloadBytes === rowPitch * height &&
				payloadBytes <= maximumPayloadBytes;
			if (!valid) {
				this.discard(4);
				malformed += 1;
				continue;
			}
			if (this.bufferedBytes < headerBytes + payloadBytes) break;
			this.discard(headerBytes);
			const pixels = this.read(payloadBytes);
			if (!pixels) break;
			frames.push({
				cameraId: bytesToId(header, 96),
				cameraIndex: header.readUInt32LE(28),
				captureMonotonicMs: header.readDoubleLE(48),
				height,
				pixels: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
				producerId: bytesToId(header, 64),
				readbackDrops: header.readUInt32LE(112),
				readbackLatencyMs: header.readDoubleLE(56),
				receivedMonotonicMs: performance.now(),
				sequence: header.readBigUInt64LE(32),
				sessionId: bytesToId(header, 80),
				transportReplacements: header.readUInt32LE(116),
				width,
				worldSeconds: header.readDoubleLE(40)
			});
		}
		return { frames, malformed };
	}
}

export interface CameraFeedServer {
	readonly close: () => Promise<void>;
	readonly getLatestFrames: () => ReadonlyMap<number, CameraFrame>;
	readonly getMetrics: () => CameraFeedMetrics;
	readonly subscribe: (listener: (frame: CameraFrame) => void) => () => void;
}

function listen(server: Server, pipeName: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (cause: Error) => {
			server.off("listening", onListening);
			reject(cause);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(pipeName);
	});
}

export function openCameraFeedServer(
	pipeName = CAMERA_PIPE_NAME
): Effect.Effect<CameraFeedServer, CameraFeedError> {
	return Effect.tryPromise({
		try: async () => {
			const latest = new Map<number, CameraFrame>();
			const listeners = new Set<(frame: CameraFrame) => void>();
			const sockets = new Set<Socket>();
			const startedMonotonicMs = performance.now();
			let bytesReceived = 0;
			let framesReceived = 0;
			let malformedFrames = 0;
			let receiverReplacements = 0;
			const server = createServer((socket) => {
				sockets.add(socket);
				const decoder = new CameraFrameDecoder();
				socket.on("data", (chunk) => {
					bytesReceived += chunk.byteLength;
					const decoded = decoder.push(chunk);
					malformedFrames += decoded.malformed;
					for (const frame of decoded.frames) {
						if (latest.has(frame.cameraIndex)) receiverReplacements += 1;
						latest.set(frame.cameraIndex, frame);
						framesReceived += 1;
						for (const listener of listeners) listener(frame);
					}
				});
				socket.once("close", () => sockets.delete(socket));
			});
			await listen(server, pipeName);
			return {
				close: () =>
					new Promise<void>((resolve, reject) => {
						for (const socket of sockets) socket.destroy();
						server.close((error) => (error ? reject(error) : resolve()));
					}),
				getLatestFrames: () => latest,
				getMetrics: () => ({
					bytesReceived,
					framesReceived,
					malformedFrames,
					receiverReplacements,
					startedMonotonicMs
				}),
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				}
			} satisfies CameraFeedServer;
		},
		catch: (cause) =>
			new CameraFeedError({
				message: String(cause),
				operation: "listen",
				pipeName,
				retrySafe: true
			})
	});
}

const RemoteResult = Schema.Struct({ ResultJson: Schema.String });
const decodeRemoteResult = Schema.decodeUnknownSync(RemoteResult);

async function cameraRemoteCall(endpoint: string, functionName: string, parameters: object) {
	const response = await fetch(`${endpoint.replace(/\/+$/, "")}/remote/object/call`, {
		body: JSON.stringify({
			functionName,
			generateTransaction: false,
			objectPath: "/Script/UEShedCameras.Default__UEShedCameraLibrary",
			parameters
		}),
		headers: { "content-type": "application/json" },
		method: "PUT"
	});
	if (!response.ok) throw new Error(`Remote Control returned HTTP ${response.status}`);
	return JSON.parse(decodeRemoteResult(await response.json()).ResultJson) as unknown;
}

export async function getCameraStatus(endpoint: string): Promise<CameraStatus> {
	return decodeCameraStatus(await cameraRemoteCall(endpoint, "GetStatus", {}));
}

export async function configureCameras(
	endpoint: string,
	config: CameraScheduleConfig
): Promise<CameraStatus> {
	const validConfig = decodeCameraScheduleConfig(config);
	return decodeCameraStatus(
		await cameraRemoteCall(endpoint, "Configure", { ConfigJson: JSON.stringify(validConfig) })
	);
}
