import {
	decodeCompanionCapabilityManifest,
	ErrorCauseFields,
	ErrorGuidanceFields,
	type CompanionCapabilityManifest
} from "@ue-shed/protocol";
import { RemoteControlClient, type RemoteControlClientError } from "@ue-shed/unreal-connection";
import { type Brand, Effect, Schema } from "effect";
import { decodeTexturePreviewResult, type TexturePreviewResult } from "./schema.js";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const previewCapability = "asset-audits.texture-preview.v1";

export class LiveTexturePreviewError extends Schema.TaggedError<
	LiveTexturePreviewError,
	Brand.Brand<"packages/asset-audits/src/live/LiveTexturePreviewError">
>()("LiveTexturePreviewError", {
	endpoint: Schema.String,
	operation: Schema.Literals(["manifest", "preview"]),
	status: Schema.optional(Schema.Number),
	...ErrorGuidanceFields,
	...ErrorCauseFields
}) {}

export interface LiveTexturePreviewOptions {
	readonly endpoint: string;
	readonly objectPath: string;
	readonly maxDimension?: number;
}

function unavailable(options: {
	readonly objectPath: string;
	readonly reason: "capability_missing";
	readonly message: string;
}): TexturePreviewResult {
	return {
		contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
		status: "unavailable",
		objectPath: options.objectPath,
		reason: options.reason,
		message: options.message,
		retrySafe: false
	};
}

function liveError(
	operation: "manifest" | "preview",
	error: RemoteControlClientError
): LiveTexturePreviewError {
	return new LiveTexturePreviewError({
		endpoint: error.endpoint,
		message: error.message,
		operation,
		recovery: error.recovery,
		retrySafe: error.retrySafe,
		nextStep: error.nextStep,
		...(error.status === undefined ? undefined : { status: error.status }),
		cause: error
	});
}

function remoteCall(options: {
	readonly endpoint: string;
	readonly objectPath: string;
	readonly functionName: string;
	readonly operation: "manifest" | "preview";
	readonly parameters: Schema.JsonObject;
}): Effect.Effect<unknown, LiveTexturePreviewError, RemoteControlClient> {
	const endpoint = options.endpoint.replace(/\/+$/, "");
	return Effect.flatMap(RemoteControlClient, (client) =>
		client
			.request({
				endpoint,
				functionName: options.functionName,
				idempotent: options.operation === "manifest",
				objectPath: options.objectPath,
				operation: `asset_audits.live_${options.operation}`,
				parameters: options.parameters
			})
			.pipe(Effect.mapError((error) => liveError(options.operation, error)))
	).pipe(
		Effect.withSpan(`asset_audits.live_${options.operation}`, {
			attributes: { "unreal.endpoint": endpoint }
		})
	);
}

function readManifest(
	endpoint: string
): Effect.Effect<CompanionCapabilityManifest, LiveTexturePreviewError, RemoteControlClient> {
	return remoteCall({
		endpoint,
		objectPath: coreObjectPath,
		functionName: "GetCapabilityManifest",
		operation: "manifest",
		parameters: {}
	}).pipe(
		Effect.flatMap((value) =>
			decodeCompanionCapabilityManifest(value).pipe(
				Effect.mapError(
					(cause) =>
						new LiveTexturePreviewError({
							endpoint,
							operation: "manifest",
							message: `The editor at ${endpoint} returned a capability manifest that does not match the companion contract.`,
							recovery: "Install a UEShedCore plugin that matches this host.",
							retrySafe: false,
							nextStep: "fix_input",
							cause
						})
				)
			)
		)
	);
}

export function readLiveTexturePreview(
	options: LiveTexturePreviewOptions
): Effect.Effect<TexturePreviewResult, LiveTexturePreviewError, RemoteControlClient> {
	return readManifest(options.endpoint).pipe(
		Effect.flatMap((manifest) => {
			if (
				!manifest.capabilities.includes(previewCapability) ||
				!manifest.assetAuditsObjectPath
			) {
				return Effect.succeed(
					unavailable({
						objectPath: options.objectPath,
						reason: "capability_missing",
						message: "The running Unreal process does not advertise texture previews."
					})
				);
			}
			return remoteCall({
				endpoint: options.endpoint,
				objectPath: manifest.assetAuditsObjectPath,
				functionName: "GetTexturePreview",
				operation: "preview",
				parameters: {
					TextureObjectPath: options.objectPath,
					MaxDimension: options.maxDimension ?? 384
				}
			}).pipe(
				Effect.flatMap((value) =>
					decodeTexturePreviewResult(value).pipe(
						Effect.mapError(
							(cause) =>
								new LiveTexturePreviewError({
									endpoint: options.endpoint,
									operation: "preview",
									message: `The editor at ${options.endpoint} returned a texture preview for ${options.objectPath} that does not match the preview contract.`,
									recovery:
										"Install UEShedCore and Asset Audits plugins that match this host.",
									retrySafe: false,
									nextStep: "fix_input",
									cause
								})
						)
					)
				)
			);
		})
	);
}
