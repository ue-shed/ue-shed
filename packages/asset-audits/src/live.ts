import {
	decodeCompanionCapabilityManifest,
	type CompanionCapabilityManifest
} from "@ue-shed/protocol";
import { RemoteControlClient, type RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";
import { decodeTexturePreviewResult, type TexturePreviewResult } from "./schema.js";

const coreObjectPath = "/Script/UEShedCore.Default__UEShedCoreLibrary";
const previewCapability = "asset-audits.texture-preview.v1";

export class LiveTexturePreviewError extends Schema.TaggedErrorClass<LiveTexturePreviewError>()(
	"LiveTexturePreviewError",
	{
		endpoint: Schema.String,
		operation: Schema.Literals(["manifest", "preview"]),
		message: Schema.String,
		retrySafe: Schema.Boolean,
		status: Schema.optional(Schema.Number)
	}
) {}

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
		retrySafe: error.retrySafe,
		...(error.status === undefined ? {} : { status: error.status })
	});
}

function remoteCall(options: {
	readonly endpoint: string;
	readonly objectPath: string;
	readonly functionName: string;
	readonly operation: "manifest" | "preview";
	readonly parameters: Readonly<Record<string, unknown>>;
}): Effect.Effect<unknown, LiveTexturePreviewError, RemoteControlClient> {
	const endpoint = options.endpoint.replace(/\/+$/, "");
	return Effect.flatMap(RemoteControlClient, (client) =>
		client
			.request({
				endpoint,
				functionName: options.functionName,
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
							message: `Invalid Unreal capability manifest: ${String(cause)}`,
							retrySafe: false
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
									message: `Invalid texture preview result: ${String(cause)}`,
									retrySafe: false
								})
						)
					)
				)
			);
		})
	);
}
