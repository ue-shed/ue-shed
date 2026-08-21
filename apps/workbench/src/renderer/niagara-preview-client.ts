import {
	NiagaraPreviewClientError,
	decodeNiagaraPreviewFrameResult,
	decodeNiagaraPreviewRunResult,
	type NiagaraPreviewClientApi
} from "@ue-shed/extension-niagara-preview";
import { Effect } from "effect";

function request<A, HostValue, DecodeError>(args: {
	readonly decode: (value: HostValue) => Effect.Effect<A, DecodeError>;
	readonly invoke: () => Promise<HostValue>;
	readonly operation: string;
}): Effect.Effect<A, NiagaraPreviewClientError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) =>
			new NiagaraPreviewClientError({
				cause,
				operation: args.operation,
				recovery: "Restart Workbench and verify the selected project."
			})
	}).pipe(
		Effect.flatMap(args.decode),
		Effect.mapError(
			(cause) =>
				new NiagaraPreviewClientError({
					cause,
					operation: args.operation,
					recovery: "Update paired UE Shed packages and retry the preview."
				})
		)
	);
}

export const niagaraPreviewClient: NiagaraPreviewClientApi = {
	frame: (intent) =>
		request({
			decode: decodeNiagaraPreviewFrameResult,
			invoke: () => window.ueShed.niagaraPreview.frame(intent),
			operation: "niagaraPreview.frame"
		}),
	run: (intent) =>
		request({
			decode: decodeNiagaraPreviewRunResult,
			invoke: () => window.ueShed.niagaraPreview.run(intent),
			operation: "niagaraPreview.run"
		})
};
