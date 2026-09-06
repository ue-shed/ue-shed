import {
	NiagaraPreviewClientError,
	decodeNiagaraCatalogueResult,
	decodeNiagaraPreviewFrameResult,
	decodeNiagaraPreviewRunResult,
	type NiagaraPreviewClientApi
} from "@ue-shed/extension-niagara-preview/client";
import { Effect } from "effect";

/** Electron prefixes IPC rejections; keep only the actionable part for the operator-facing sentence. */
function transportMessage(cause: unknown): string {
	const raw = cause instanceof Error ? cause.message : String(cause);
	const match = raw.match(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]*)$/u);
	return (match?.[1] ?? raw).trim();
}

function clientError(
	label: string,
	operation: string,
	cause: unknown,
	recovery: string
): NiagaraPreviewClientError {
	const detail = transportMessage(cause);
	return new NiagaraPreviewClientError({
		cause,
		message: detail === "" ? `${label} failed.` : `${label} failed: ${detail}`,
		operation,
		recovery
	});
}

function request<A, HostValue, DecodeError>(args: {
	readonly decode: (value: HostValue) => Effect.Effect<A, DecodeError>;
	readonly invoke: () => Promise<HostValue>;
	readonly label: string;
	readonly operation: string;
}): Effect.Effect<A, NiagaraPreviewClientError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) =>
			clientError(
				args.label,
				args.operation,
				cause,
				"Restart Workbench and verify the selected project."
			)
	}).pipe(
		Effect.flatMap((value) =>
			args.decode(value).pipe(
				// Only decode failures reach this wrapper; transport failures are already typed.
				Effect.mapError((cause) =>
					clientError(
						args.label,
						args.operation,
						cause,
						"Update paired UE Shed packages and retry the preview."
					)
				)
			)
		)
	);
}

export const niagaraPreviewClient: NiagaraPreviewClientApi = {
	catalogue: () =>
		request({
			decode: decodeNiagaraCatalogueResult,
			invoke: () => window.ueShed.niagaraPreview.catalogue(),
			label: "The Niagara system catalogue request",
			operation: "niagaraPreview.catalogue"
		}),
	frame: (intent) =>
		request({
			decode: decodeNiagaraPreviewFrameResult,
			invoke: () => window.ueShed.niagaraPreview.frame(intent),
			label: "The frame read request",
			operation: "niagaraPreview.frame"
		}),
	run: (intent) =>
		request({
			decode: decodeNiagaraPreviewRunResult,
			invoke: () => window.ueShed.niagaraPreview.run(intent),
			label: "The preview capture request",
			operation: "niagaraPreview.run"
		})
};
