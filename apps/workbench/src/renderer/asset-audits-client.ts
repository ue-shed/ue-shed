import {
	decodeTextureAuditQueryRunResult,
	decodeTextureAuditRecordResult,
	decodeTextureAuditSearchResult,
	type TextureAuditQueryRunResult,
	type TextureAuditRecordResult,
	type TextureAuditSearchRequest,
	type TextureAuditSearchResult,
	decodeTexturePreviewResult,
	type TexturePreviewResult
} from "@ue-shed/asset-audits/browser";
import {
	TextureAuditClient,
	TextureAuditClientError,
	decodeTextureAuditLaunchResult,
	type TextureAuditClientShape,
	type TextureAuditLaunchResult
} from "@ue-shed/extension-asset-audits";
import { WorkbenchTaskProgress } from "../main/project-workspace-contract.js";
import { Effect, Schema } from "effect";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

function request<A>(args: {
	readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
	readonly invoke: () => Promise<unknown>;
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

export const assetAuditsClient: TextureAuditClientShape = TextureAuditClient.of({
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
	launchUnreal: Effect.fn("TextureAuditClient.launchUnreal")(
		(): Effect.Effect<TextureAuditLaunchResult, TextureAuditClientError> =>
			request({
				decode: decodeTextureAuditLaunchResult,
				invoke: () => window.ueShed.fixture.launch(),
				operation: "fixture.launch"
			})
	)
});
