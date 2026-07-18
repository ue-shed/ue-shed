import {
	decodeCameraScheduleConfig,
	decodeCameraStatus,
	type CameraScheduleConfig,
	type CameraStatus
} from "@ue-shed/protocol";
import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, PubSub, Schema, Scope, Stream } from "effect";
import { createServer, type Server, type Socket } from "node:net";

export * from "./review-capture.js";
export * from "./review-authoring-live.js";
export * from "./review-framing.js";
export * from "./review-live.js";
export * from "./review-repository.js";
export * from "./review-schema.js";
export * from "./review-session-policy.js";

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
	readonly deliveryReplacements: number;
	readonly framesReceived: number;
	readonly malformedFrames: number;
	readonly receiverReplacements: number;
	readonly startedMonotonicMs: number;
	readonly transportErrors: number;
}

export class CameraFeedError extends Schema.TaggedErrorClass<CameraFeedError>()("CameraFeedError", {
	message: Schema.String,
	operation: Schema.Literal("listen"),
	pipeName: Schema.String,
	retrySafe: Schema.Boolean
}) {}

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

export interface CameraFeedShape {
	readonly frames: Stream.Stream<CameraFrame>;
	readonly latestFrames: Effect.Effect<ReadonlyMap<number, CameraFrame>>;
	readonly metrics: Effect.Effect<CameraFeedMetrics>;
}

export class CameraFeed extends Context.Service<CameraFeed, CameraFeedShape>()(
	"@ue-shed/cameras/CameraFeed"
) {}

export interface CameraFeedOptions {
	readonly capacity?: number;
	readonly pipeName?: string;
}

interface AcquiredCameraFeed {
	readonly feed: CameraFeedShape;
	readonly pubsub: PubSub.PubSub<CameraFrame>;
	readonly server: Server;
	readonly sockets: Set<Socket>;
}

function listen(server: Server, pipeName: string): Effect.Effect<void, CameraFeedError> {
	return Effect.tryPromise({
		try: (signal) =>
			new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					server.off("error", onError);
					server.off("listening", onListening);
					signal.removeEventListener("abort", onAbort);
				};
				const onAbort = () => {
					cleanup();
					try {
						server.close();
					} catch {
						// The server may not have started listening yet.
					}
					reject(signal.reason);
				};
				const onError = (cause: Error) => {
					cleanup();
					reject(cause);
				};
				const onListening = () => {
					cleanup();
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				signal.addEventListener("abort", onAbort, { once: true });
				server.listen(pipeName);
			}),
		catch: (cause) =>
			new CameraFeedError({
				message: String(cause),
				operation: "listen",
				pipeName,
				retrySafe: true
			})
	});
}

function closeCameraFeed(resource: AcquiredCameraFeed): Effect.Effect<void> {
	return Effect.gen(function* () {
		for (const socket of resource.sockets) socket.destroy();
		yield* Effect.callback<void>((resume) => {
			if (!resource.server.listening) {
				resume(Effect.void);
				return;
			}
			resource.server.close(() => resume(Effect.void));
		});
		yield* PubSub.shutdown(resource.pubsub);
	});
}

function acquireCameraFeed(
	options: CameraFeedOptions
): Effect.Effect<AcquiredCameraFeed, CameraFeedError, Scope.Scope> {
	const pipeName = options.pipeName ?? CAMERA_PIPE_NAME;
	const capacity = options.capacity ?? 8;
	if (!Number.isInteger(capacity) || capacity <= 0) {
		return Effect.fail(
			new CameraFeedError({
				message: `Camera feed capacity must be a positive integer, received ${capacity}.`,
				operation: "listen",
				pipeName,
				retrySafe: false
			})
		);
	}
	return Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const pubsub = yield* PubSub.sliding<CameraFrame>(capacity);
		const latest = new Map<number, CameraFrame>();
		const sockets = new Set<Socket>();
		const startedMonotonicMs = performance.now();
		let bytesReceived = 0;
		let deliveryReplacements = 0;
		let framesReceived = 0;
		let malformedFrames = 0;
		let receiverReplacements = 0;
		let transportErrors = 0;
		const server = createServer((socket) => {
			sockets.add(socket);
			const decoder = new CameraFrameDecoder();
			socket.on("error", () => {
				transportErrors += 1;
			});
			socket.on("data", (chunk) => {
				bytesReceived += chunk.byteLength;
				const decoded = decoder.push(chunk);
				malformedFrames += decoded.malformed;
				for (const frame of decoded.frames) {
					if (latest.has(frame.cameraIndex)) receiverReplacements += 1;
					latest.set(frame.cameraIndex, frame);
					framesReceived += 1;
					Effect.runFork(
						Effect.forkIn(
							Effect.gen(function* () {
								if ((yield* PubSub.size(pubsub)) >= capacity) {
									deliveryReplacements += 1;
								}
								yield* PubSub.publish(pubsub, frame);
							}),
							scope
						)
					);
				}
			});
			socket.once("close", () => sockets.delete(socket));
		});
		yield* listen(server, pipeName);
		server.on("error", () => {
			transportErrors += 1;
		});
		return {
			feed: {
				frames: Stream.fromPubSub(pubsub),
				latestFrames: Effect.sync(() => new Map(latest)),
				metrics: Effect.sync(() => ({
					bytesReceived,
					deliveryReplacements,
					framesReceived,
					malformedFrames,
					receiverReplacements,
					startedMonotonicMs,
					transportErrors
				}))
			},
			pubsub,
			server,
			sockets
		} satisfies AcquiredCameraFeed;
	});
}

export function cameraFeedLayer(
	options: CameraFeedOptions = {}
): Layer.Layer<CameraFeed, CameraFeedError> {
	return Layer.effect(
		CameraFeed,
		Effect.acquireRelease(acquireCameraFeed(options), closeCameraFeed).pipe(
			Effect.map((resource) => resource.feed)
		)
	);
}

export const CameraFeedLive = cameraFeedLayer();

export function makeCameraFeedTestLayer(
	feed: Partial<CameraFeedShape> = {}
): Layer.Layer<CameraFeed> {
	return Layer.succeed(CameraFeed, {
		frames: feed.frames ?? Stream.empty,
		latestFrames: feed.latestFrames ?? Effect.succeed(new Map()),
		metrics:
			feed.metrics ??
			Effect.succeed({
				bytesReceived: 0,
				deliveryReplacements: 0,
				framesReceived: 0,
				malformedFrames: 0,
				receiverReplacements: 0,
				startedMonotonicMs: 0,
				transportErrors: 0
			})
	});
}

export class CameraControlError extends Schema.TaggedErrorClass<CameraControlError>()(
	"CameraControlError",
	{
		endpoint: Schema.String,
		message: Schema.String,
		operation: Schema.Literals(["configure", "status"]),
		retrySafe: Schema.Boolean,
		status: Schema.optional(Schema.Number)
	}
) {}

function cameraControlError(
	endpoint: string,
	operation: "configure" | "status",
	cause: RemoteControlClientError | unknown
): CameraControlError {
	if (cause instanceof RemoteControlClientError) {
		return new CameraControlError({
			endpoint: cause.endpoint,
			message: cause.message,
			operation,
			retrySafe: cause.retrySafe,
			...(cause.status === undefined ? {} : { status: cause.status })
		});
	}
	return new CameraControlError({
		endpoint,
		message: `Invalid camera ${operation} response: ${String(cause)}`,
		operation,
		retrySafe: false
	});
}

const cameraRemoteCall = Effect.fn("CameraControl.remoteCall")(function* (
	endpoint: string,
	functionName: string,
	operation: "configure" | "status",
	parameters: Readonly<Record<string, unknown>>
) {
	const client = yield* RemoteControlClient;
	return yield* client
		.request({
			endpoint,
			functionName,
			objectPath: "/Script/UEShedCameras.Default__UEShedCameraLibrary",
			operation: `camera.control.${operation}`,
			parameters
		})
		.pipe(Effect.mapError((error) => cameraControlError(endpoint, operation, error)));
});

export function getCameraStatus(
	endpoint: string
): Effect.Effect<CameraStatus, CameraControlError, RemoteControlClient> {
	return cameraRemoteCall(endpoint, "GetStatus", "status", {}).pipe(
		Effect.flatMap(decodeCameraStatus),
		Effect.mapError((error) => cameraControlError(endpoint, "status", error))
	);
}

export function configureCameras(
	endpoint: string,
	config: CameraScheduleConfig
): Effect.Effect<CameraStatus, CameraControlError, RemoteControlClient> {
	return decodeCameraScheduleConfig(config).pipe(
		Effect.mapError((error) => cameraControlError(endpoint, "configure", error)),
		Effect.flatMap((validConfig) =>
			cameraRemoteCall(endpoint, "Configure", "configure", {
				ConfigJson: JSON.stringify(validConfig)
			})
		),
		Effect.flatMap(decodeCameraStatus),
		Effect.mapError((error) => cameraControlError(endpoint, "configure", error))
	);
}
