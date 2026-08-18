import { Context, Effect, Layer, Schema } from "effect";

export type AuthoringFilePickerChoice =
	| { readonly status: "cancelled" }
	| { readonly status: "selected"; readonly path: string };

export interface AuthoringFilePickerOptions {
	readonly extensions: readonly string[];
	readonly title: string;
}

export class AuthoringFilePickerError extends Schema.TaggedErrorClass<AuthoringFilePickerError>()(
	"AuthoringFilePickerError",
	{
		cause: Schema.Defect(),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

export interface AuthoringFilePickerApi {
	readonly chooseFile: (
		options: AuthoringFilePickerOptions
	) => Effect.Effect<AuthoringFilePickerChoice, AuthoringFilePickerError>;
}

export class AuthoringFilePicker extends Context.Service<
	AuthoringFilePicker,
	AuthoringFilePickerApi
>()("@ue-shed/host/AuthoringFilePicker") {}

export function authoringFilePickerLayer(
	service: AuthoringFilePickerApi
): Layer.Layer<AuthoringFilePicker> {
	return Layer.succeed(AuthoringFilePicker, AuthoringFilePicker.of(service));
}

export const AuthoringFilePickerCancelled = authoringFilePickerLayer({
	chooseFile: Effect.fn("AuthoringFilePicker.cancelled")(() =>
		Effect.succeed({ status: "cancelled" as const })
	)
});
