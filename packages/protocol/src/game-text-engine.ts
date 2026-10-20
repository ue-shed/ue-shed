import { Schema } from "effect";
import { GameTextIndexConfiguration } from "./game-text-index.js";

const Reader = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Identity = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const Payload = Schema.String.check(Schema.isMaxLength(512 * 1024));
/** Native read-only snapshots are scoped to their owning process session. */
export const GameTextEngineRequest = Schema.Union([
	Schema.Struct({ action: Schema.Literal("capabilities") }),
	Schema.Struct({
		action: Schema.Literal("open"),
		configuration: GameTextIndexConfiguration,
		expectedGeneration: Identity,
		expectedJoined: Identity,
		policy: Schema.Struct({
			audienceRules: Schema.Array(Identity).check(Schema.isMaxLength(255))
		})
	}),
	Schema.Struct({
		action: Schema.Literals(["corpus", "corpus_header", "localization_corpus"]),
		reader: Reader,
		output: Schema.NonEmptyString.check(Schema.isMaxLength(32767))
	}),
	Schema.Struct({
		action: Schema.Literal("rows"),
		reader: Reader,
		payload: Payload,
		output: Schema.NonEmptyString.check(Schema.isMaxLength(32767))
	}),
	Schema.Struct({
		action: Schema.Literals([
			"export",
			"aggregate",
			"localization_export",
			"localization_focus_export"
		]),
		reader: Reader,
		payload: Payload,
		output: Schema.NonEmptyString.check(Schema.isMaxLength(32767))
	}),
	...(["close", "summary", "corpus_fingerprint"] as const).map((action) =>
		Schema.Struct({ action: Schema.Literal(action), reader: Reader })
	),
	...(
		[
			"search",
			"focus",
			"localization_focus",
			"localization_page",
			"localization_detail"
		] as const
	).map((action) =>
		Schema.Struct({ action: Schema.Literal(action), reader: Reader, payload: Payload })
	)
]).annotate({ identifier: "GameTextEngineRequest" });
export type GameTextEngineRequest = typeof GameTextEngineRequest.Type;

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Domain results are bounded JSON text so lone UTF-16 units survive the native wire boundary. */
export const GameTextEngineOutcome = Schema.Struct({
	action: Schema.Literals([
		"capabilities",
		"open",
		"close",
		"summary",
		"search",
		"focus",
		"export",
		"corpus",
		"corpus_header",
		"corpus_fingerprint",
		"aggregate",
		"rows",
		"localization_focus",
		"localization_detail",
		"localization_export",
		"localization_focus_export",
		"localization_corpus",
		"localization_page"
	]),
	capabilities: Schema.Array(Schema.Literal("game_text_engine_v1")),
	reader: Schema.NullOr(Reader),
	generation: Schema.NullOr(Identity),
	joinedKey: Schema.NullOr(Identity),
	payload: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16 * 1024 * 1024))),
	io: Schema.Struct({
		opens: Natural,
		sectionLoads: Natural,
		storedBytes: Natural,
		rawBytes: Natural,
		fullVerifies: Natural,
		indexBytes: Natural,
		writtenBytes: Natural
	}),
	stageSeconds: Schema.Record(
		Schema.String,
		Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
	)
}).annotate({ identifier: "GameTextEngineOutcome" });
export type GameTextEngineOutcome = typeof GameTextEngineOutcome.Type;
