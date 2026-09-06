import { Schema } from "effect";

/** Generation is null for a direct scan that did not use a persistent Project Index. */
export const InvestigationSource = Schema.Struct({
	projectRoot: Schema.NonEmptyString,
	generation: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	authority: Schema.Literal("project_files")
});
export interface InvestigationSource extends Schema.Schema.Type<typeof InvestigationSource> {}

export const InvestigationFormat = Schema.Literals(["json", "csv"]);
export type InvestigationFormat = Schema.Schema.Type<typeof InvestigationFormat>;
export class InvestigationError extends Schema.TaggedErrorClass<InvestigationError>()(
	"InvestigationError",
	{
		message: Schema.String,
		recovery: Schema.String
	}
) {}
export const InvestigationFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	message: Schema.String,
	recovery: Schema.String
});
export const InvestigationCancelled = Schema.Struct({ status: Schema.Literal("cancelled") });
export const InvestigationFileResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("saved"),
		path: Schema.String,
		rowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		replayCommand: Schema.optionalKey(Schema.String)
	}),
	InvestigationCancelled,
	InvestigationFailure
]);
export type InvestigationFileResult = Schema.Schema.Type<typeof InvestigationFileResult>;

/** RFC 4180 quoting; text cells cannot become spreadsheet formulas when opened interactively. */
const isTextCell = Schema.is(Schema.String);

export function investigationCsv(
	rows: Iterable<readonly (string | number | boolean | null | undefined)[]>
): string {
	return (
		[...rows]
			.map((row) =>
				row
					.map((cell) => {
						let value = cell == null ? "" : String(cell);
						if (isTextCell(cell) && /^[\s]*[=+@-]/u.test(value)) value = "'" + value;
						return '"' + value.replaceAll('"', '""') + '"';
					})
					.join(",")
			)
			.join("\r\n") + "\r\n"
	);
}

/** PowerShell single-quoted arguments preserve spaces, apostrophes and shell metacharacters. */
export function investigationReplayCommand(projectRoot: string, presetPath: string): string {
	const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
	return `pnpm ue-shed investigations run ${quote(projectRoot)} --preset ${quote(presetPath)} --format json`;
}

/** A metadata row keeps provenance and coverage even when no records match. */
export function investigationTable<Metadata extends object>(
	metadata: Metadata,
	columns: readonly string[],
	rows: Iterable<readonly (string | number | boolean | null | undefined)[]>
): string {
	return investigationCsv(
		(function* () {
			yield ["record_type", "metadata_json", ...columns];
			yield ["metadata", JSON.stringify(metadata), ...columns.map(() => "")];
			for (const row of rows) yield ["record", "", ...row];
		})()
	);
}
