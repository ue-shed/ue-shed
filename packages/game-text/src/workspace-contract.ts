import { Schema, type Effect, type Stream } from "effect";
import { InvestigationFileResult, InvestigationFormat } from "@ue-shed/unreal-assets/investigation";
import { GameTextRuleDocument } from "./game-text-rules.js";
import { GameTextInvestigationPresetResult, GameTextInvestigationQuery } from "./investigation.js";
import { LocalizationEditRequest, LocalizationEditResult } from "./localization-edits.js";
import { LocalizationLinesFileResult } from "./localization-export.js";
import { LocalizationReviewRequest, LocalizationReviewResult } from "./localization-review.js";
import { LocalizationSelection } from "./localization-schema.js";
import {
	LocalizationFocusRequest,
	LocalizationFocusResult,
	LocalizationTargetResult,
	LocalizationTargetsResult
} from "./localization-view.js";
import {
	WorkspaceChangesResult,
	WorkspaceQualityFocusRequest,
	WorkspaceQualityFocusResult,
	WorkspaceQualityRequest,
	WorkspaceQualityResult,
	WorkspaceReportFileRequest,
	WorkspaceReportFileResult,
	WorkspaceReportRequest,
	WorkspaceReportResult
} from "./localization-workspace.js";
import {
	TextQualityFocusRequest,
	TextQualityFocusResult,
	TextQualityQueryRunResult,
	TextQualityRuleUpdateResult,
	TextQualitySearchRequest,
	TextQualitySearchResult
} from "./quality-query.js";
import { RelatedLinesRequest, RelatedLinesResult } from "./related-lines.js";
import {
	TextCorpusFocusRequest,
	TextCorpusFocusResult,
	TextCorpusQueryRunResult,
	TextCorpusRowsResult,
	TextCorpusSearchRequest,
	TextCorpusSearchResult
} from "./schema.js";
import { GameTextWorkspaceProgress } from "./workspace-progress.js";

/** The parameter of a workspace method that takes none. */
export const GameTextWorkspaceNoParams = Schema.Struct({});

/** `configuredRefresh`: `refresh: false` opens the committed index without scanning. */
export const GameTextWorkspaceRefreshRequest = Schema.Struct({
	refresh: Schema.optionalKey(Schema.Boolean)
});
export type GameTextWorkspaceRefreshRequest = typeof GameTextWorkspaceRefreshRequest.Type;

/** `createStarterRules`: `loadExisting` loads the existing rules file instead of writing one. */
export const GameTextStarterRulesRequest = Schema.Struct({ loadExisting: Schema.Boolean });
export type GameTextStarterRulesRequest = typeof GameTextStarterRulesRequest.Type;

/** `investigationExport`: the query to export, and the file format. */
export const GameTextInvestigationExportRequest = Schema.Struct({
	query: GameTextInvestigationQuery,
	format: InvestigationFormat
});
export type GameTextInvestigationExportRequest = typeof GameTextInvestigationExportRequest.Type;

/**
 * One workspace method a host serves: its one parameter, and either its success or, for a
 * method that streams, each event. `error` is present only for a method with typed errors.
 */
export type GameTextWorkspaceContractEntry =
	| {
			readonly params: Schema.Top;
			readonly success: Schema.Top;
			readonly error?: Schema.Top;
	  }
	| {
			readonly params: Schema.Top;
			readonly events: Schema.Top;
			readonly error?: Schema.Top;
	  };

type EntryParameters<Entry extends GameTextWorkspaceContractEntry> =
	keyof Entry["params"]["Type"] extends never ? [] : [params: Entry["params"]["Type"]];
type EntryError<Entry extends GameTextWorkspaceContractEntry> = Entry extends {
	readonly error: Schema.Top;
}
	? Entry["error"]["Type"]
	: never;

/**
 * The workspace method an entry describes: no parameter when its params schema has no fields,
 * else the one parameter; an Effect of its success, or a Stream of its events.
 */
export type GameTextWorkspaceContractMethod<Entry extends GameTextWorkspaceContractEntry> =
	Entry extends { readonly success: Schema.Top }
		? (
				...params: EntryParameters<Entry>
			) => Effect.Effect<Entry["success"]["Type"], EntryError<Entry>>
		: Entry extends { readonly events: Schema.Top }
			? (
					...params: EntryParameters<Entry>
				) => Stream.Stream<Entry["events"]["Type"], EntryError<Entry>>
			: never;

/**
 * The browser-safe contract of the Game Text workspace, keyed by `GameTextWorkspaceApi` method
 * name: each method's params, success or events, and error schemas. It names no channels; each
 * host maps names to its own transport and serves an entry by calling the method with the
 * decoded params. `GameTextWorkspaceApi` must match it method for method, or the workspace does
 * not compile.
 *
 * Host-only methods are left out, because they run inside the host's own process:
 * - `operationStateTarget`, `operationTarget`, `operationBusyReason`, `beginOperation`,
 *   `endOperation` and `refreshAfterOperation` admit and refresh around the host's Unreal
 *   localization operations, and `localizationBeforeGather` runs before its gather; the first two
 *   also return a `LocalizationTarget` with its file paths.
 * - `configuredScan` returns the whole corpus; serve `configuredRefresh` instead.
 */
export const GameTextWorkspaceContract = {
	localizationQualitySearch: { params: WorkspaceQualityRequest, success: WorkspaceQualityResult },
	localizationQualityFocus: {
		params: WorkspaceQualityFocusRequest,
		success: WorkspaceQualityFocusResult
	},
	localizationChanges: { params: WorkspaceQualityRequest, success: WorkspaceChangesResult },
	localizationEdits: { params: LocalizationEditRequest, success: LocalizationEditResult },
	localizationReview: { params: LocalizationReviewRequest, success: LocalizationReviewResult },
	localizationReport: { params: WorkspaceReportRequest, success: WorkspaceReportResult },
	localizationReportFile: {
		params: WorkspaceReportFileRequest,
		success: WorkspaceReportFileResult
	},
	localizationLinesFile: {
		params: TextCorpusSearchRequest,
		success: LocalizationLinesFileResult
	},
	localizationTargets: { params: GameTextWorkspaceNoParams, success: LocalizationTargetsResult },
	localizationTarget: {
		params: LocalizationSelection.fields.target,
		success: LocalizationTargetResult
	},
	localizationFocus: { params: LocalizationFocusRequest, success: LocalizationFocusResult },
	related: { params: RelatedLinesRequest, success: RelatedLinesResult },
	investigationExport: {
		params: GameTextInvestigationExportRequest,
		success: InvestigationFileResult
	},
	investigationSave: { params: GameTextInvestigationQuery, success: InvestigationFileResult },
	investigationOpen: {
		params: GameTextWorkspaceNoParams,
		success: GameTextInvestigationPresetResult
	},
	configuredRefresh: {
		params: GameTextWorkspaceRefreshRequest,
		success: TextCorpusQueryRunResult
	},
	progress: { params: GameTextWorkspaceNoParams, success: GameTextWorkspaceProgress },
	/** The current progress, then each change to it: a host serves it as a subscription. */
	progressChanges: { params: GameTextWorkspaceNoParams, events: GameTextWorkspaceProgress },
	focus: { params: TextCorpusFocusRequest, success: TextCorpusFocusResult },
	search: { params: TextCorpusSearchRequest, success: TextCorpusSearchResult },
	searchRows: { params: TextCorpusSearchRequest, success: TextCorpusRowsResult },
	chooseQualityRules: { params: GameTextWorkspaceNoParams, success: TextQualityQueryRunResult },
	reloadQualityRules: { params: GameTextWorkspaceNoParams, success: TextQualityQueryRunResult },
	createStarterRules: {
		params: GameTextStarterRulesRequest,
		success: TextQualityQueryRunResult
	},
	previewQualityRules: { params: GameTextRuleDocument, success: TextQualityRuleUpdateResult },
	saveQualityRules: { params: GameTextRuleDocument, success: TextQualityRuleUpdateResult },
	qualityFocus: { params: TextQualityFocusRequest, success: TextQualityFocusResult },
	qualitySearch: { params: TextQualitySearchRequest, success: TextQualitySearchResult }
} as const satisfies Record<string, GameTextWorkspaceContractEntry>;
export type GameTextWorkspaceContract = typeof GameTextWorkspaceContract;

/** The `GameTextWorkspaceApi` methods the contract leaves out; see `GameTextWorkspaceContract`. */
export type GameTextWorkspaceHostOnlyMethod =
	| "operationStateTarget"
	| "operationTarget"
	| "operationBusyReason"
	| "beginOperation"
	| "endOperation"
	| "refreshAfterOperation"
	| "localizationBeforeGather"
	| "configuredScan";

/** A workspace method the contract describes. */
export type GameTextWorkspaceContractName = keyof GameTextWorkspaceContract;

/** The workspace methods the contract describes, with the signatures its entries give them. */
export type GameTextWorkspaceContractApi = {
	readonly [Name in GameTextWorkspaceContractName]: GameTextWorkspaceContractMethod<
		GameTextWorkspaceContract[Name]
	>;
};

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Served<Api> = Omit<Api, GameTextWorkspaceHostOnlyMethod>;
/**
 * The methods where a workspace API and the contract differ, `never` when they match: a method
 * other than a host-only one with no entry, an entry with no method, or a signature that is not
 * exactly its entry's.
 */
export type GameTextWorkspaceContractMismatch<Api> = {
	[Name in keyof Served<Api> | GameTextWorkspaceContractName]: Name extends keyof Served<Api> &
		GameTextWorkspaceContractName
		? Exact<Served<Api>[Name], GameTextWorkspaceContractApi[Name]> extends true
			? never
			: Name
		: Name;
}[keyof Served<Api> | GameTextWorkspaceContractName];
