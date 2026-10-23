import { Schema } from "effect";
import { GameTextIndexConfiguration } from "./game-text-index.js";

const Reader = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Identity = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const Payload = Schema.String.check(Schema.isMaxLength(512 * 1024));
/** Native read-only snapshots are scoped to their owning process session. */
export const GameTextEnginePreviousRequest = Schema.Union([
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
	...(["close", "summary", "corpus_fingerprint", "corpus_report_header"] as const).map((action) =>
		Schema.Struct({ action: Schema.Literal(action), reader: Reader })
	),
	...(["search", "focus", "localization_detail"] as const).map((action) =>
		Schema.Struct({ action: Schema.Literal(action), reader: Reader, payload: Payload })
	)
]);
const FindingRows = Schema.Array(
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0xffffffff))
).check(Schema.isMaxLength(5000));
/** Additive findings actions, requiring uasset-io minor 20. */
export const GameTextFindingsRequest = Schema.Union([
	Schema.Struct({
		action: Schema.Literal("findings_evaluate"),
		reader: Reader,
		/** The v4 rule document's JSON text; the request frame bounds its size. */
		rules: Schema.NonEmptyString,
		collationLocale: Schema.NonEmptyString.check(Schema.isMaxLength(128))
	}),
	Schema.Struct({
		action: Schema.Literal("findings_lines"),
		reader: Reader,
		key: Identity,
		rows: FindingRows
	}),
	Schema.Struct({
		action: Schema.Literal("findings_units"),
		reader: Reader,
		key: Identity,
		units: FindingRows
	})
]);
/** Native snapshot reads and persisted finding evaluation share one process scope. */
export const GameTextEngineRequest = Schema.Union([
	GameTextEnginePreviousRequest,
	GameTextFindingsRequest
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
		"corpus_report_header",
		"corpus_fingerprint",
		"aggregate",
		"rows",
		"localization_detail",
		"localization_export",
		"localization_focus_export",
		"localization_corpus",
		"findings_evaluate",
		"findings_lines",
		"findings_units"
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
	),
	/** `capabilities` reports the engine's build and contract for the host's one handshake. */
	contract: Schema.optionalKey(
		Schema.Struct({ buildId: Schema.String, contractHash: Schema.String })
	)
}).annotate({ identifier: "GameTextEngineOutcome" });
export type GameTextEngineOutcome = typeof GameTextEngineOutcome.Type;
