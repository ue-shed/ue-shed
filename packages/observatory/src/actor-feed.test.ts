import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import {
	type RemoteControlClientApi,
	type RemoteControlRequest,
	RemoteControlClientError
} from "@ue-shed/unreal-connection";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
	ACTOR_STREAM_FLAG_RESET,
	ActorFeed,
	ActorFeedError,
	ActorObservationRecoveryExhaustedError,
	actorFeedLayer,
	encodeActorStreamPacket,
	observeActorFeed,
	StreamActorIndex,
	type ActorFeedApi,
	type ActorObservationDiagnostic,
	type WorldObservationState
} from "./index.js";

const scopes: Scope.Closeable[] = [];

afterEach(async () => {
	await Promise.all(
		scopes
			.splice(0)
			.map((scope) => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))))
	);
});

function pipeName(): string {
	return `\\\\.\\pipe\\ue-shed-observatory-test-${randomUUID()}`;
}

async function acquireFeed(
	name: string,
	capacity = 8,
	maxMalformedPackets = 128
): Promise<{ readonly feed: ActorFeedApi; readonly scope: Scope.Closeable }> {
	const scope = await Effect.runPromise(Scope.make());
	scopes.push(scope);
	const context = await Effect.runPromise(
		Layer.buildWithScope(
			actorFeedLayer({ capacity, maxMalformedPackets, pipeName: name }),
			scope
		)
	);
	return { feed: Context.get(context, ActorFeed), scope };
}

async function connectToFeed(name: string): Promise<Socket> {
	const socket = connect(name);
	await once(socket, "connect");
	return socket;
}

function packet(args: {
	readonly sequence: bigint;
	readonly sessionId?: string;
	readonly catalogRevision?: bigint;
	readonly reset?: boolean;
	readonly records?: ReadonlyArray<{
		readonly streamIndex: number;
		readonly x: number;
		readonly y: number;
	}>;
}): Buffer {
	const records = (args.records ?? [{ streamIndex: 0, x: 1, y: 2 }]).map((record) => ({
		flags: 0,
		location: { x: record.x, y: record.y, z: 0 },
		rotation: { pitch: 0, roll: 0, yaw: 0 },
		streamIndex: record.streamIndex
	}));
	return encodeActorStreamPacket({
		catalogRevision: args.catalogRevision ?? 1n,
		flags: args.reset ? ACTOR_STREAM_FLAG_RESET : 0,
		records: args.reset ? [] : records,
		sequence: args.sequence,
		sessionId: args.sessionId ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		worldSeconds: Number(args.sequence)
	});
}

function collectSequences(
	feed: ActorFeedApi,
	count: number,
	started: Deferred.Deferred<void>
): Promise<ReadonlyArray<bigint>> {
	return Effect.runPromise(
		feed.packets.pipe(
			Stream.onStart(Deferred.succeed(started, undefined)),
			Stream.take(count),
			Stream.map((value) => value.sequence),
			Stream.runCollect
		)
	);
}

async function waitForPackets(feed: ActorFeedApi, expected: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await Effect.runPromise(feed.metrics)).packetsReceived >= expected) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Actor feed did not receive ${expected} packets.`);
}

async function waitForDeliveryReplacement(feed: ActorFeedApi): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await Effect.runPromise(feed.metrics)).deliveryReplacements > 0) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Actor feed did not report a delivery replacement.");
}

async function waitForMalformed(feed: ActorFeedApi, expected: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await Effect.runPromise(feed.metrics)).malformedPackets >= expected) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Actor feed did not report ${expected} malformed packets.`);
}

function wireActor(streamIndex: number, id: string, x: number, y: number) {
	return {
		bounds: { center: { x, y, z: 0 }, extent: { x: 10, y: 10, z: 10 } },
		className: "FixtureMover",
		displayName: id,
		id,
		location: { x, y, z: 0 },
		path: `/Game/Fixture.${id}`,
		rotation: { x: 0, y: 0, z: 0 },
		streamIndex
	};
}

function readyStart(args: {
	readonly pipeName: string;
	readonly sessionId: string;
	readonly catalogRevision?: string;
	readonly actors?: ReadonlyArray<ReturnType<typeof wireActor>>;
}) {
	return {
		status: "ready" as const,
		capability: "stream" as const,
		cadenceHz: 30,
		catalog: {
			actors: args.actors ?? [wireActor(0, "mover-0", 0, 0)],
			capturedAt: "2026-07-21T00:00:00.000Z",
			mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
			worldKind: "pie" as const,
			worldSeconds: 1
		},
		catalogRevision: args.catalogRevision ?? "1",
		limits: { maxActors: 16_384, maxCadenceHz: 60 },
		pipeName: args.pipeName,
		sessionId: args.sessionId
	};
}

function snapshotResponse() {
	return {
		status: "ready" as const,
		snapshot: {
			actors: [
				{
					bounds: { center: { x: 0, y: 0, z: 0 }, extent: { x: 10, y: 10, z: 10 } },
					className: "FixtureMover",
					displayName: "mover-0",
					id: "mover-0",
					location: { x: 3, y: 4, z: 0 },
					path: "/Game/Fixture.mover-0",
					rotation: { x: 0, y: 0, z: 0 }
				}
			],
			capturedAt: "2026-07-21T00:00:00.000Z",
			mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
			sequence: 1,
			worldKind: "pie" as const,
			worldSeconds: 2
		}
	};
}

interface RemoteFixture {
	readonly remote: RemoteControlClientApi;
	readonly stops: { count: number };
}

function makeRemote(options: {
	readonly onStart?: (request: RemoteControlRequest) => Schema.Json;
	readonly onStop?: () => void;
	readonly onSnapshot?: () => Schema.Json;
}): RemoteFixture {
	const stops = { count: 0 };
	return {
		stops,
		remote: {
			request: (request) => {
				if (request.functionName === "StartActorObservation") {
					return Effect.succeed(
						options.onStart?.(request) ??
							readyStart({
								pipeName: pipeName(),
								sessionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
							})
					);
				}
				if (request.functionName === "StopActorObservation") {
					stops.count += 1;
					options.onStop?.();
					return Effect.succeed({ status: "stopped" });
				}
				if (request.functionName === "GetActorSnapshot") {
					return Effect.succeed(options.onSnapshot?.() ?? snapshotResponse());
				}
				return Effect.fail(
					new RemoteControlClientError({
						endpoint: request.endpoint,
						functionName: request.functionName,
						message: `Unexpected function ${request.functionName}`,
						operation: request.operation ?? request.functionName,
						retrySafe: false
					})
				);
			}
		}
	};
}

async function takeStates(
	stream: Stream.Stream<WorldObservationState, unknown>,
	count: number
): Promise<ReadonlyArray<WorldObservationState>> {
	return Effect.runPromise(stream.pipe(Stream.take(count), Stream.runCollect));
}

describe("ActorFeed", () => {
	test("fails acquisition when the named pipe is already owned", async () => {
		const name = pipeName();
		await acquireFeed(name);
		const secondScope = await Effect.runPromise(Scope.make());
		scopes.push(secondScope);
		await expect(
			Effect.runPromise(Layer.buildWithScope(actorFeedLayer({ pipeName: name }), secondScope))
		).rejects.toBeInstanceOf(ActorFeedError);
	});

	test("broadcasts fragmented packets to multiple stream subscribers", async () => {
		const name = pipeName();
		const { feed } = await acquireFeed(name);
		const firstStarted = await Effect.runPromise(Deferred.make<void>());
		const secondStarted = await Effect.runPromise(Deferred.make<void>());
		const first = collectSequences(feed, 1, firstStarted);
		const second = collectSequences(feed, 1, secondStarted);
		await Promise.all([
			Effect.runPromise(Deferred.await(firstStarted)),
			Effect.runPromise(Deferred.await(secondStarted))
		]);
		const socket = await connectToFeed(name);
		const encoded = packet({ sequence: 42n });
		socket.write(encoded.subarray(0, 40));
		socket.write(encoded.subarray(40));
		await expect(Promise.all([first, second])).resolves.toEqual([[42n], [42n]]);
		socket.destroy();
	});

	test("keeps the latest packet when a subscriber falls behind", async () => {
		const name = pipeName();
		const { feed } = await acquireFeed(name, 1);
		const started = await Effect.runPromise(Deferred.make<void>());
		const firstSeen = await Effect.runPromise(Deferred.make<void>());
		const release = await Effect.runPromise(Deferred.make<void>());
		const received = Effect.runPromise(
			feed.packets.pipe(
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
		socket.write(packet({ sequence: 1n }));
		await Effect.runPromise(Deferred.await(firstSeen));
		socket.write(Buffer.concat([packet({ sequence: 2n }), packet({ sequence: 3n })]));
		await waitForPackets(feed, 3);
		await waitForDeliveryReplacement(feed);
		await Effect.runPromise(Deferred.succeed(release, undefined));
		await expect(received).resolves.toEqual([1n, 3n]);
		await expect(Effect.runPromise(feed.metrics)).resolves.toMatchObject({
			deliveryReplacements: 1,
			packetsReceived: 3
		});
		socket.destroy();
	});

	test("interruption closes connected sockets and the server deterministically", async () => {
		const name = pipeName();
		const acquired = await Effect.runPromise(Deferred.make<ActorFeedApi>());
		const owner = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(actorFeedLayer({ pipeName: name }));
					yield* Deferred.succeed(acquired, Context.get(context, ActorFeed));
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

	test("drops the socket at the decode limit and resynchronizes on a fresh connection", async () => {
		const name = pipeName();
		const { feed } = await acquireFeed(name, 8, 1);
		const socket = await connectToFeed(name);
		const closed = once(socket, "close");
		socket.write(Buffer.alloc(96, 0xab));
		await waitForMalformed(feed, 1);
		await closed;
		await expect(Effect.runPromise(feed.metrics)).resolves.toMatchObject({
			decodeLimitDrops: 1,
			malformedPackets: 1
		});

		const recovery = await connectToFeed(name);
		const started = await Effect.runPromise(Deferred.make<void>());
		const sequences = collectSequences(feed, 1, started);
		await Effect.runPromise(Deferred.await(started));
		recovery.write(Buffer.concat([Buffer.from("xx"), packet({ sequence: 9n })]));
		await expect(sequences).resolves.toEqual([9n]);
		recovery.destroy();
	});
});

describe("observeActorFeed", () => {
	test("enters polling_fallback when StartActorObservation reports not_supported", async () => {
		const { remote, stops } = makeRemote({
			onStart: () => ({
				status: "not_supported",
				message: "Named pipes unavailable.",
				recovery: "Use bounded snapshot polling."
			})
		});
		const states = await takeStates(
			observeActorFeed(remote, "http://127.0.0.1:30010", { cadenceHz: 30 }),
			3
		);
		expect(states.some((state) => state.status === "unavailable")).toBe(true);
		const fallback = states.find((state) => state.status === "polling_fallback");
		expect(fallback).toMatchObject({
			status: "polling_fallback",
			cadenceHz: 10
		});
		expect(stops.count).toBeGreaterThanOrEqual(1);
	});

	test("streams live transforms for a negotiated session and calls Stop on interrupt", async () => {
		const name = pipeName();
		const sessionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const { remote, stops } = makeRemote({
			onStart: () =>
				readyStart({
					pipeName: name,
					sessionId,
					actors: [wireActor(0, "mover-0", 10, 20)]
				})
		});

		const states: WorldObservationState[] = [];
		const diagnostics: ActorObservationDiagnostic[] = [];
		const catalogReady = await Effect.runPromise(Deferred.make<void>());
		const transformed = await Effect.runPromise(Deferred.make<void>());
		const fiber = Effect.runFork(
			observeActorFeed(remote, "http://127.0.0.1:30010", {
				cadenceHz: 30,
				onDiagnostic: (diagnostic) =>
					Effect.sync(() => {
						diagnostics.push(diagnostic);
					}),
				pipeName: name
			}).pipe(
				Stream.tap((state) =>
					Effect.sync(() => {
						states.push(state);
					}).pipe(
						Effect.andThen(
							state.status === "live" && state.sample.lastSequence === 0n
								? Deferred.succeed(catalogReady, undefined).pipe(Effect.ignore)
								: Effect.void
						),
						Effect.andThen(
							state.status === "live" && state.sample.lastSequence >= 1n
								? Deferred.succeed(transformed, undefined).pipe(Effect.ignore)
								: Effect.void
						)
					)
				),
				Stream.runDrain
			)
		);

		await Effect.runPromise(Deferred.await(catalogReady));
		const socket = await connectToFeed(name);
		socket.write(
			packet({
				sequence: 1n,
				sessionId,
				records: [{ streamIndex: 0, x: 42, y: -7 }]
			})
		);
		await Effect.runPromise(Deferred.await(transformed));
		const live = [...states].reverse().find((state) => state.status === "live");
		expect(live?.status).toBe("live");
		if (live?.status === "live") {
			expect(live.sample.transforms.get(StreamActorIndex.make(0))?.location).toEqual({
				x: 42,
				y: -7,
				z: 0
			});
		}
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			actorsChanged: 1,
			actorsSampled: 1,
			missingSequences: 0,
			sequence: 1n
		});
		socket.destroy();
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(stops.count).toBeGreaterThanOrEqual(1);
	});

	test("reacquires a catalog after a reset packet without mixing sessions", async () => {
		const name = pipeName();
		const sessionA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const sessionB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		let starts = 0;
		const { remote } = makeRemote({
			onStart: () => {
				starts += 1;
				return starts === 1
					? readyStart({ pipeName: name, sessionId: sessionA, catalogRevision: "1" })
					: readyStart({
							pipeName: name,
							sessionId: sessionB,
							catalogRevision: "2",
							actors: [wireActor(0, "mover-0", 100, 200)]
						});
			}
		});

		const firstLive = await Effect.runPromise(Deferred.make<void>());
		const secondLive = await Effect.runPromise(
			Deferred.make<Extract<WorldObservationState, { status: "live" }>>()
		);
		const fiber = Effect.runFork(
			observeActorFeed(remote, "http://127.0.0.1:30010", {
				cadenceHz: 30,
				pipeName: name
			}).pipe(
				Stream.tap((state) =>
					Effect.gen(function* () {
						if (
							state.status === "live" &&
							state.sample.catalog.sessionId === sessionA
						) {
							yield* Deferred.succeed(firstLive, undefined).pipe(Effect.ignore);
						}
						if (
							state.status === "live" &&
							state.sample.catalog.sessionId === sessionB
						) {
							yield* Deferred.succeed(secondLive, state).pipe(Effect.ignore);
						}
					})
				),
				Stream.runDrain
			)
		);

		await Effect.runPromise(Deferred.await(firstLive));
		const socket = await connectToFeed(name);
		socket.write(packet({ sequence: 1n, sessionId: sessionA, reset: true }));
		const reacquired = await Effect.runPromise(Deferred.await(secondLive));
		expect(reacquired.sample.catalog.sessionId).toBe(sessionB);
		expect(starts).toBe(2);
		socket.destroy();
		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	test("fails the stream when recovery attempts are exhausted instead of emitting empty", async () => {
		const { remote } = makeRemote({
			onStart: () => ({
				status: "failed",
				message: "Editor refused observation.",
				recovery: "Retry later."
			})
		});
		await expect(
			Effect.runPromise(
				observeActorFeed(remote, "http://127.0.0.1:30010", {
					cadenceHz: 30,
					maxRecoveryAttempts: 0
				}).pipe(Stream.runCollect)
			)
		).rejects.toBeInstanceOf(ActorObservationRecoveryExhaustedError);
	});
});
