import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	CameraBridgeRequest,
	CameraBridgeResponse,
	makeCameraAuthoringBridge,
	readyCameraBridge
} from "./camera-authoring-bridge.js";
import { CameraArrangementId } from "./camera-arrangement.js";

const decode = Schema.decodeUnknownSync(CameraBridgeResponse);
const legacyFailure = Schema.Struct({
	version: Schema.Literal(1),
	status: Schema.Literals(["busy", "stale", "unavailable", "invalid", "detached"]),
	message: Schema.String
});

describe("camera bridge failure codes", () => {
	it.each([undefined, "setup_host_replaced"])(
		"opts in on the wire and accepts a plugin returning cause %s",
		async (code) => {
			const response = {
				version: 1,
				status: "stale",
				message: "The setup host no longer owns this connection.",
				...(code === undefined ? undefined : { code })
			};
			const bridge = makeCameraAuthoringBridge(
				{
					request: (request) => {
						const wire = Schema.decodeUnknownSync(
							Schema.fromJsonString(CameraBridgeRequest)
						)(request.parameters.RequestJson, { onExcessProperty: "error" });
						expect(wire.codedFailures).toBe(true);
						return Effect.succeed(response);
					}
				},
				"http://localhost:30010"
			);
			const error = await Effect.runPromise(
				bridge
					.call({
						version: 1,
						operation: "setup_release",
						hostId: CameraArrangementId.make("host-test")
					})
					.pipe(Effect.flatMap(readyCameraBridge), Effect.flip)
			);
			expect(error.code).toBe("stale");
			expect(error.cause).toBe(code);
		}
	);

	it("allows a caller to request failures that an older strict decoder accepts", async () => {
		const response = { version: 1, status: "busy", message: "Detach the active camera first." };
		const bridge = makeCameraAuthoringBridge(
			{
				request: (request) => {
					const wire = Schema.decodeUnknownSync(
						Schema.fromJsonString(CameraBridgeRequest)
					)(request.parameters.RequestJson);
					expect(wire.codedFailures).toBe(false);
					return Effect.succeed(response);
				}
			},
			"http://localhost:30010"
		);
		const result = await Effect.runPromise(
			bridge.call({
				version: 1,
				operation: "setup_release",
				hostId: CameraArrangementId.make("host-test"),
				codedFailures: false
			})
		);
		expect(
			Schema.decodeUnknownSync(legacyFailure)(result, { onExcessProperty: "error" })
		).toEqual(response);
		expect(() =>
			Schema.decodeUnknownSync(legacyFailure)(
				{ ...response, code: "camera_attached" },
				{ onExcessProperty: "error" }
			)
		).toThrow();
	});

	it("keeps the bridge's specific cause beside the coarse status", async () => {
		const response = decode({
			version: 1,
			status: "stale",
			message: "The editor project or map differs from the requested scope.",
			code: "scope_mismatch"
		});
		await expect(Effect.runPromise(readyCameraBridge(response))).rejects.toMatchObject({
			code: "stale",
			cause: "scope_mismatch"
		});
	});

	it("reads an older bridge's failure without a code", async () => {
		const response = decode({
			version: 1,
			status: "busy",
			message: "Detach the active camera first."
		});
		const error = await Effect.runPromise(Effect.flip(readyCameraBridge(response)));
		expect(error.code).toBe("busy");
		expect(error.cause).toBeUndefined();
	});

	it("rejects a code that is not a bounded snake-case cause", () => {
		expect(() =>
			decode({ version: 1, status: "invalid", message: "x", code: "Not a code" })
		).toThrow();
	});
});
