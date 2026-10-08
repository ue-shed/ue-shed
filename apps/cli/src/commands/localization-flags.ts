import { LocalizationState } from "@ue-shed/game-text/browser";
import { Option } from "effect";
import { Flag } from "effect/unstable/cli";

export function localizationFlags() {
	return {
		culture: Flag.string("culture").pipe(Flag.optional),
		state: Flag.choice("state", LocalizationState.literals).pipe(Flag.optional),
		limit: Flag.integer("limit").pipe(
			Flag.filter(
				(value) => value >= 1 && value <= 50,
				() => "--limit must be between 1 and 50"
			),
			Flag.withDefault(50)
		)
	};
}

export function optionalLocalizationFlags(
	culture: Option.Option<string>,
	state: Option.Option<typeof LocalizationState.Type>
) {
	return {
		...(Option.isSome(culture) ? { culture: culture.value } : undefined),
		...(Option.isSome(state) ? { state: state.value } : undefined)
	};
}
