import { ErrorGuidanceFields } from "@ue-shed/protocol";
import { Context, Effect, Layer, Schema } from "effect";

export type AuthoringFilePickerChoice =
	| { readonly status: "cancelled" }
	| { readonly status: "selected"; readonly path: string };

export interface AuthoringFilePickerOptions {
	readonly extensions: readonly string[];
	readonly title: string;
}

/**
 * The host file picker failed. The original cause and recovery guidance distinguish a picker
 * failure from an ordinary user cancellation.
 */
export class AuthoringFilePickerError extends Schema.TaggedError<AuthoringFilePickerError>()(
	"AuthoringFilePickerError",
	{
		cause: Schema.Defect(),
		...ErrorGuidanceFields
	}
) {}

export interface AuthoringFilePickerApi {
	readonly chooseFile: (
		options: AuthoringFilePickerOptions
	) => Effect.Effect<AuthoringFilePickerChoice, AuthoringFilePickerError>;
}

/**
 * Optional host file-selection port used by explicit choose-table actions. A headless host
 * can provide AuthoringFilePickerCancelled; ordinary scans do not need a picker.
 */
export class AuthoringFilePicker extends Context.Service<
	AuthoringFilePicker,
	AuthoringFilePickerApi
>()("@ue-shed/host/AuthoringFilePicker") {}

export function authoringFilePickerLayer(
	service: AuthoringFilePickerApi
): Layer.Layer<AuthoringFilePicker> {
	return Layer.succeed(AuthoringFilePicker, AuthoringFilePicker.of(service));
}

/**
 * Headless picker implementation that always returns a cancelled choice. Cancellation is a
 * successful value, so it leaves the current project and table selection unchanged.
 */
export const AuthoringFilePickerCancelled = authoringFilePickerLayer({
	chooseFile: Effect.fn("AuthoringFilePicker.cancelled")(() =>
		Effect.succeed({ status: "cancelled" as const })
	)
});
