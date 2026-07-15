import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
	CAMERA_FRAME_HEADER_BYTES,
	CameraFeed,
	CameraFeedError,
	CameraFrameDecoder,
	cameraFeedLayer,
	type CameraFeedShape
} from "./index.js";

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

const scopes: Scope.Closeable[] = [];

afterEach(async () => {
	await Promise.all(
		scopes
			.splice(0)
			.map((scope) => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))))
	);
});

function pipeName(): string {
	return `\\\\.\\pipe\\ue-shed-cameras-test-${randomUUID()}`;
}

async function acquireFeed(
	name: string,
	capacity = 8
): Promise<{ readonly feed: CameraFeedShape; readonly scope: Scope.Closeable }> {
	const scope = await Effect.runPromise(Scope.make());
	scopes.push(scope);
	const context = await Effect.runPromise(
		Layer.buildWithScope(cameraFeedLayer({ capacity, pipeName: name }), scope)
	);
	return { feed: Context.get(context, CameraFeed), scope };
}

async function connectToFeed(name: string): Promise<Socket> {
	const socket = connect(name);
	await once(socket, "connect");
	return socket;
}

function collectFrames(
	feed: CameraFeedShape,
	count: number,
	started: Deferred.Deferred<void>
): Promise<ReadonlyArray<bigint>> {
	return Effect.runPromise(
		feed.frames.pipe(
			Stream.onStart(Deferred.succeed(started, undefined)),
			Stream.take(count),
			Stream.map((value) => value.sequence),
			Stream.runCollect
		)
	);
}

async function waitForFrames(feed: CameraFeedShape, expected: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await Effect.runPromise(feed.metrics)).framesReceived >= expected) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Camera feed did not receive ${expected} frames.`);
}

async function waitForDeliveryReplacement(feed: CameraFeedShape): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await Effect.runPromise(feed.metrics)).deliveryReplacements > 0) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Camera feed did not report a delivery replacement.");
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

describe("CameraFeed", () => {
	test("fails acquisition when the named pipe is already owned", async () => {
		const name = pipeName();
		await acquireFeed(name);
		const secondScope = await Effect.runPromise(Scope.make());
		scopes.push(secondScope);
		await expect(
			Effect.runPromise(
				Layer.buildWithScope(cameraFeedLayer({ pipeName: name }), secondScope)
			)
		).rejects.toBeInstanceOf(CameraFeedError);
	});

	test("broadcasts fragmented frames to multiple stream subscribers", async () => {
		const name = pipeName();
		const { feed } = await acquireFeed(name);
		const firstStarted = await Effect.runPromise(Deferred.make<void>());
		const secondStarted = await Effect.runPromise(Deferred.make<void>());
		const first = collectFrames(feed, 1, firstStarted);
		const second = collectFrames(feed, 1, secondStarted);
		await Promise.all([
			Effect.runPromise(Deferred.await(firstStarted)),
			Effect.runPromise(Deferred.await(secondStarted))
		]);
		const socket = await connectToFeed(name);
		const encoded = frame(42n);
		socket.write(encoded.subarray(0, 51));
		socket.write(encoded.subarray(51));
		await expect(Promise.all([first, second])).resolves.toEqual([[42n], [42n]]);
		socket.destroy();
	});

	test("keeps the latest frame when a subscriber falls behind", async () => {
		const name = pipeName();
		const { feed } = await acquireFeed(name, 1);
		const started = await Effect.runPromise(Deferred.make<void>());
		const firstSeen = await Effect.runPromise(Deferred.make<void>());
		const release = await Effect.runPromise(Deferred.make<void>());
		const received = Effect.runPromise(
			feed.frames.pipe(
				Stream.onStart(Deferred.succeed(started, undefined)),
				Stream.mapEffect((value) =>
					value.sequence === 1n
						? Deferred.succeed(firstSeen, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.as(value.sequence)
							)
						: Effect.succeed(value.sequence)
				),
				Stream.take(2),
				Stream.runCollect
			)
		);
		await Effect.runPromise(Deferred.await(started));
		const socket = await connectToFeed(name);
		socket.write(frame(1n));
		await Effect.runPromise(Deferred.await(firstSeen));
		socket.write(Buffer.concat([frame(2n), frame(3n)]));
		await waitForFrames(feed, 3);
		await waitForDeliveryReplacement(feed);
		await Effect.runPromise(Deferred.succeed(release, undefined));
		await expect(received).resolves.toEqual([1n, 3n]);
		await expect(Effect.runPromise(feed.metrics)).resolves.toMatchObject({
			deliveryReplacements: 1,
			framesReceived: 3
		});
		socket.destroy();
	});

	test("interruption closes connected sockets and the server deterministically", async () => {
		const name = pipeName();
		const acquired = await Effect.runPromise(Deferred.make<CameraFeedShape>());
		const owner = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(cameraFeedLayer({ pipeName: name }));
					yield* Deferred.succeed(acquired, Context.get(context, CameraFeed));
					yield* Effect.never;
				})
			)
		);
		await Effect.runPromise(Deferred.await(acquired));
		const socket = await connectToFeed(name);
		const closed = once(socket, "close");
		await Effect.runPromise(Fiber.interrupt(owner));
		await closed;
		const replacement = await acquireFeed(name);
		await Effect.runPromise(Scope.close(replacement.scope, Exit.succeed(undefined)));
	});
});
