import { Schema } from "effect";
import {
	decodeCorpusExpectations,
	CorpusExpectations,
	CorpusFinding,
	CorpusSourceKind
} from "./contract.js";

/** The plan's format. Like the contract, it imports no UE Shed package or check implementation. */
export interface PlannedCulture {
	translation: string;
	expectedSource: string;
	archiveSource: string;
	archiveMetadata: Record<string, string>;
	resourceTranslation: string;
	importPending: boolean;
	compilePending: boolean;
	po: string;
	poEntry: boolean;
	archive: boolean;
	state: string;
	facts: string[];
	unknownReasons: string[];
	problems: string[];
	findings: CorpusFinding[];
}
export interface PlannedText {
	case: string;
	instance: number;
	parameters: Record<string, typeof Schema.Json.Type>;
	kind: CorpusSourceKind;
	field: string;
	namespace: string;
	key: string;
	source: string;
	notes: string;
	mode: "text" | "invariant" | "reference" | "scaffold";
	table: string;
	tableKey: string;
	manifestSource: string;
	gathered: boolean;
	exists: boolean;
	compiledSource: string;
	previousSource: string;
	manifestMetadata: Record<string, string>;
	manifestPath: string;
	signals: string[];
	absent: string[];
	cultures: Record<string, PlannedCulture>;
}
export interface PlannedPackage {
	path: string;
	kind: string;
	folder: string;
	name: string;
	packageNamespace: string;
	persistentGuid: string;
	tableNamespace: string;
	texts: PlannedText[];
}
export interface CorpusPlan {
	format: "ue-shed-game-text-corpus-plan";
	version: 1;
	scenario: "main" | "collapse";
	phase: "initial" | "after";
	seed: number;
	lines: number;
	density: number;
	requestedLines: number;
	edits: {
		packages: string[];
		deletedPackages: string[];
		changedFiles: string[];
		operations: { kind: string; subject: string; value: string }[];
	};
	root: string;
	target: string;
	cultures: readonly string[];
	packages: PlannedPackage[];
	rules: object;
	/** Without a culture, a probe reads every culture. */
	probes: { case: string; kind: string; culture?: string; expected: typeof Schema.Json.Type }[];
	expectations: CorpusExpectations;
}

/** A probe's subject in comparisons: its kind and culture, `*` for every culture. */
export const probeSubject = (probe: CorpusPlan["probes"][number]) =>
	`probe:${probe.kind}:${probe.culture ?? "*"}`;
const PlannedCultureSchema = Schema.Struct({
	translation: Schema.String,
	expectedSource: Schema.String,
	archiveSource: Schema.String,
	archiveMetadata: Schema.Record(Schema.String, Schema.String),
	resourceTranslation: Schema.String,
	po: Schema.String,
	poEntry: Schema.Boolean,
	importPending: Schema.Boolean,
	compilePending: Schema.Boolean,
	archive: Schema.Boolean,
	state: Schema.String,
	facts: Schema.Array(Schema.String),
	unknownReasons: Schema.Array(Schema.String),
	problems: Schema.Array(Schema.String),
	findings: Schema.Array(CorpusFinding)
});
export const CorpusPlanSchema = Schema.Struct({
	format: Schema.Literal("ue-shed-game-text-corpus-plan"),
	version: Schema.Literal(1),
	scenario: Schema.Literals(["main", "collapse"]),
	phase: Schema.Literals(["initial", "after"]),
	seed: Schema.Int,
	lines: Schema.Int,
	density: Schema.Int,
	requestedLines: Schema.Int,
	edits: Schema.Struct({
		packages: Schema.Array(Schema.String),
		deletedPackages: Schema.Array(Schema.String),
		changedFiles: Schema.Array(Schema.String),
		operations: Schema.Array(
			Schema.Struct({ kind: Schema.String, subject: Schema.String, value: Schema.String })
		)
	}),
	root: Schema.String,
	target: Schema.String,
	cultures: Schema.Array(Schema.String),
	rules: Schema.Json,
	expectations: CorpusExpectations,
	probes: Schema.Array(
		Schema.Struct({
			case: Schema.String,
			kind: Schema.String,
			culture: Schema.optionalKey(Schema.String),
			expected: Schema.Json
		})
	),
	packages: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			kind: Schema.Literals(["stringTable", "dataTable", "blueprint", "widgetBlueprint"]),
			folder: Schema.String,
			name: Schema.String,
			packageNamespace: Schema.String,
			persistentGuid: Schema.String,
			tableNamespace: Schema.String,
			texts: Schema.Array(
				Schema.Struct({
					case: Schema.String,
					instance: Schema.Int,
					parameters: Schema.Record(Schema.String, Schema.Json),
					kind: CorpusSourceKind,
					field: Schema.String,
					namespace: Schema.String,
					key: Schema.String,
					source: Schema.String,
					notes: Schema.String,
					mode: Schema.Literals(["text", "invariant", "reference", "scaffold"]),
					table: Schema.String,
					tableKey: Schema.String,
					manifestSource: Schema.String,
					gathered: Schema.Boolean,
					exists: Schema.Boolean,
					compiledSource: Schema.String,
					signals: Schema.Array(Schema.String),
					absent: Schema.Array(Schema.String),
					previousSource: Schema.String,
					manifestMetadata: Schema.Record(Schema.String, Schema.String),
					manifestPath: Schema.String,
					cultures: Schema.Record(Schema.String, PlannedCultureSchema)
				})
			)
		})
	)
});
export function decodeCorpusPlan(contents: string) {
	const plan = Schema.decodeUnknownSync(Schema.fromJsonString(CorpusPlanSchema))(contents);
	if (plan.packages.reduce((total, item) => total + item.texts.length, 0) !== plan.lines)
		throw new Error("Plan line count differs from its placements.");
	decodeCorpusExpectations(JSON.stringify(plan.expectations));
	if (
		plan.expectations.lines !== plan.lines ||
		plan.expectations.seed !== plan.seed ||
		plan.expectations.root !== plan.root ||
		plan.expectations.subjects.length !== plan.lines * plan.cultures.length
	)
		throw new Error("Plan and expectations headers disagree.");
	return plan;
}
