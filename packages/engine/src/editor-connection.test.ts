import { createServer, type ServerResponse } from "node:http";
import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect, it as httpIt } from "vitest";
import {
	makeRemoteControlClient,
	makeRemoteControlClientTestLayer
} from "@ue-shed/unreal-connection";
import { EditorConnection, EditorConnectionLive } from "./editor-connection.js";

const manifest = {
	capabilities: ["editor.play-session.v1"],
	producerKind: "unreal_editor" as const,
	projectName: "Fixture",
	schemaVersion: 1 as const
};

async function withEditorHttp(
	respond: (response: ServerResponse, count: number) => void,
	run: (endpoint: string, requests: () => number) => Promise<void>
): Promise<void> {
	let requests = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => respond(response, ++requests));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!(address instanceof Object))
			throw new Error("The fixture TCP server did not expose its address.");
		await run(`http://127.0.0.1:${address.port}`, () => requests);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve()))
		);
	}
}

function readiness(endpoint: string) {
	const client = makeRemoteControlClient({ defaultTimeout: "1 second" });
	return Effect.flatMap(EditorConnection, (connection) =>
		connection.waitUntilReady({ endpoint, pollInterval: "1 millis", timeout: "1 second" })
	).pipe(
		Effect.provide(
			EditorConnectionLive.pipe(
				Layer.provide(makeRemoteControlClientTestLayer(client.request))
			)
		)
	);
}

for (const scenario of [
	{
		name: "HTTP refusal",
		status: 400,
		body: JSON.stringify({ message: "refused" }),
		nextStep: "fix_input",
		recovery: "editor rejected"
	},
	{
		name: "malformed envelope",
		status: 200,
		body: "{}",
		nextStep: "escalate",
		recovery: "malformed response"
	},
	{
		name: "malformed outer JSON",
		status: 200,
		body: "{invalid JSON",
		nextStep: "escalate",
		recovery: "malformed response"
	}
]) {
	httpIt(`does not poll after a permanent ${scenario.name}`, async () => {
		await withEditorHttp(
			(response) => {
				response.statusCode = scenario.status;
				response.setHeader("content-type", "application/json");
				response.end(scenario.body);
			},
			async (endpoint, requests) => {
				const error = await Effect.runPromise(Effect.flip(readiness(endpoint)));
				expect(error.code).toBe("transport_failure");
				expect(error.retrySafe).toBe(true);
				expect(error.nextStep).toBe(scenario.nextStep);
				expect(error.recovery).toContain(scenario.recovery);
				expect(requests()).toBe(1);
			}
		);
	});
}

httpIt("polls transient HTTP failures until the editor is ready", async () => {
	await withEditorHttp(
		(response, count) => {
			response.statusCode = count === 1 ? 503 : 200;
			response.setHeader("content-type", "application/json");
			response.end(
				count === 1
					? JSON.stringify({ message: "starting" })
					: JSON.stringify({ ResultJson: JSON.stringify(manifest) })
			);
		},
		async (endpoint, requests) => {
			expect(await Effect.runPromise(readiness(endpoint))).toEqual(manifest);
			expect(requests()).toBe(2);
		}
	);
});

it.effect("connects to a matching editor through the capability manifest", () =>
	Effect.gen(function* () {
		const connection = yield* EditorConnection;
		expect(
			yield* connection.connect({
				endpoint: "http://127.0.0.1:30001/",
				expectedProjectName: "Fixture"
			})
		).toEqual(manifest);
	}).pipe(
		Effect.provide(
			EditorConnectionLive.pipe(
				Layer.provide(makeRemoteControlClientTestLayer(() => Effect.succeed(manifest)))
			)
		)
	)
);

it.effect("rejects a reachable editor for another project", () =>
	Effect.gen(function* () {
		const connection = yield* EditorConnection;
		const error = yield* Effect.flip(
			connection.connect({
				endpoint: "http://127.0.0.1:30001",
				expectedProjectName: "AnotherProject"
			})
		);
		expect(error.code).toBe("project_mismatch");
	}).pipe(
		Effect.provide(
			EditorConnectionLive.pipe(
				Layer.provide(makeRemoteControlClientTestLayer(() => Effect.succeed(manifest)))
			)
		)
	)
);

it.effect("does not retry a non-retryable readiness mismatch", () =>
	Effect.gen(function* () {
		const requests = yield* Ref.make(0);
		const layer = EditorConnectionLive.pipe(
			Layer.provide(
				makeRemoteControlClientTestLayer(() =>
					Ref.updateAndGet(requests, (count) => count + 1).pipe(Effect.as(manifest))
				)
			)
		);
		const error = yield* Effect.flip(
			Effect.flatMap(EditorConnection, (connection) =>
				connection.waitUntilReady({
					endpoint: "http://127.0.0.1:30001",
					expectedProjectName: "AnotherProject",
					pollInterval: "1 millis",
					timeout: "1 second"
				})
			).pipe(Effect.provide(layer))
		);
		expect(error.code).toBe("project_mismatch");
		expect(yield* Ref.get(requests)).toBe(1);
	})
);
