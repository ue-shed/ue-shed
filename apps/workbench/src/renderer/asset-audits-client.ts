import {
	decodeTextureAuditQueryRunResult,
	decodeTextureAuditRecordResult,
	decodeTextureAuditSearchResult,
	decodeTexturePreviewBatchResult,
	type TextureAuditQueryRunResult,
	type TextureAuditRecordResult,
	type TextureAuditSearchRequest,
	type TextureAuditSearchResult,
	type TexturePreviewBatchRequest,
	type TexturePreviewBatchResult,
	decodeTexturePreviewResult,
	type TexturePreviewResult
} from "@ue-shed/asset-audits/browser";
import { decodeEditorAssetLocateResult, type EditorAssetLocateResult } from "@ue-shed/protocol";
import {
	TextureAuditClient,
	TextureAuditClientError,
	decodeTextureAuditLaunchResult,
	type TextureAuditClientApi,
	type TextureAuditLaunchResult
} from "@ue-shed/extension-asset-audits/client";
import { WorkbenchTaskProgress } from "../main/project-workspace-contract.js";
import { Effect, Schema } from "effect";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

function request<A, HostValue, DecodeError>(args: {
	readonly decode: (value: HostValue) => Effect.Effect<A, DecodeError>;
	readonly invoke: () => Promise<HostValue>;
	readonly operation: string;
}): Effect.Effect<A, TextureAuditClientError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) =>
			new TextureAuditClientError({ cause, operation: args.operation, recovery })
	}).pipe(
		Effect.flatMap(args.decode),
		Effect.mapError(
			(cause) => new TextureAuditClientError({ cause, operation: args.operation, recovery })
		)
	);
}

export const assetAuditsClient: TextureAuditClientApi = TextureAuditClient.of({
	locateAsset: Effect.fn("TextureAuditClient.locateAsset")(
		(objectPath: string): Effect.Effect<EditorAssetLocateResult, TextureAuditClientError> =>
			request({
				decode: decodeEditorAssetLocateResult,
				invoke: () => window.ueShed.assetNavigation.locate(objectPath),
				operation: "assetNavigation.locate"
			})
	),
	loadConfiguredProject: Effect.fn("TextureAuditClient.loadConfiguredProject")(
		(): Effect.Effect<TextureAuditQueryRunResult, TextureAuditClientError> =>
			request({
				decode: decodeTextureAuditQueryRunResult,
				invoke: () => window.ueShed.assetAudits.refreshConfiguredProject(),
				operation: "assetAudits.loadConfiguredProject"
			})
	),
	chooseProjectAndScan: Effect.fn("TextureAuditClient.chooseProjectAndScan")(
		(): Effect.Effect<TextureAuditQueryRunResult, TextureAuditClientError> =>
			request({
				decode: decodeTextureAuditQueryRunResult,
				invoke: () => window.ueShed.assetAudits.chooseProjectAndRefresh(),
				operation: "assetAudits.chooseProjectAndScan"
			})
	),
	progress: Effect.fn("TextureAuditClient.progress")(() =>
		request({
			decode: Schema.decodeUnknownEffect(WorkbenchTaskProgress),
			invoke: () => window.ueShed.assetAudits.progress(),
			operation: "assetAudits.progress"
		})
	),
	search: Effect.fn("TextureAuditClient.search")(
		(
			input: TextureAuditSearchRequest
		): Effect.Effect<TextureAuditSearchResult, TextureAuditClientError> =>
			request({
				decode: decodeTextureAuditSearchResult,
				invoke: () => window.ueShed.assetAudits.search(input),
				operation: "assetAudits.search"
			})
	),
	record: Effect.fn("TextureAuditClient.record")(
		(objectPath: string): Effect.Effect<TextureAuditRecordResult, TextureAuditClientError> =>
			request({
				decode: decodeTextureAuditRecordResult,
				invoke: () => window.ueShed.assetAudits.record(objectPath),
				operation: "assetAudits.record"
			})
	),
	loadPreview: Effect.fn("TextureAuditClient.loadPreview")(
		(objectPath): Effect.Effect<TexturePreviewResult, TextureAuditClientError> =>
			request({
				decode: decodeTexturePreviewResult,
				invoke: () => window.ueShed.assetAudits.preview(objectPath),
				operation: "assetAudits.preview"
			})
	),
	loadOfflinePreview: Effect.fn("TextureAuditClient.loadOfflinePreview")(
		(objectPath): Effect.Effect<TexturePreviewResult, TextureAuditClientError> =>
			request({
				decode: decodeTexturePreviewResult,
				invoke: () => window.ueShed.assetAudits.previewOffline(objectPath),
				operation: "assetAudits.previewOffline"
			})
	),
	loadOfflinePreviews: Effect.fn("TextureAuditClient.loadOfflinePreviews")(
		(
			input: TexturePreviewBatchRequest
		): Effect.Effect<TexturePreviewBatchResult, TextureAuditClientError> =>
			request({
				decode: decodeTexturePreviewBatchResult,
				invoke: () => window.ueShed.assetAudits.previewOfflineBatch(input),
				operation: "assetAudits.previewOfflineBatch"
			})
	),
	launchUnreal: Effect.fn("TextureAuditClient.launchUnreal")(
		(): Effect.Effect<TextureAuditLaunchResult, TextureAuditClientError> =>
			request({
				decode: decodeTextureAuditLaunchResult,
				invoke: () => window.ueShed.fixture.launch(),
				operation: "fixture.launch"
			})
	)
});
