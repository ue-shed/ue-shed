import { Schema } from "effect";
import { GAME_TEXT_INDEX_PHASE_LABELS, GameTextIndexPhase } from "./index-progress.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Step = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * What the workspace is doing, as a raw code; hosts word it with
 * `GAME_TEXT_WORKSPACE_PHASE_LABELS`. A running index phase is reported by its own code; an
 * index that is `ready` or `failed` is reported as `idle`, or `scanning` while a scan still runs.
 */
export const GameTextWorkspacePhase = Schema.Literals([
	"idle",
	/** A scan runs between the phases it reports; no count. */
	"scanning",
	/** The host's project scan discovering packages; no count. */
	"project_enumerating",
	/** The host's project scan: packages indexed of packages found. */
	"project_scanning",
	...GameTextIndexPhase.pick([
		"inventory",
		"localization",
		"localization_publish",
		"packages",
		"package_text",
		"package_publish",
		"joining",
		"opening",
		"corpus",
		"localization_quality",
		"source_quality"
	]).literals
]);
export type GameTextWorkspacePhase = typeof GameTextWorkspacePhase.Type;

/** Each workspace phase in words, for hosts that show the workspace's progress. */
export const GAME_TEXT_WORKSPACE_PHASE_LABELS = {
	idle: "Idle",
	scanning: "Inspecting text-bearing packages",
	project_enumerating: "Discovering saved packages",
	project_scanning: "Indexing project",
	inventory: GAME_TEXT_INDEX_PHASE_LABELS.inventory,
	localization: GAME_TEXT_INDEX_PHASE_LABELS.localization,
	localization_publish: GAME_TEXT_INDEX_PHASE_LABELS.localization_publish,
	packages: GAME_TEXT_INDEX_PHASE_LABELS.packages,
	package_text: GAME_TEXT_INDEX_PHASE_LABELS.package_text,
	package_publish: GAME_TEXT_INDEX_PHASE_LABELS.package_publish,
	joining: GAME_TEXT_INDEX_PHASE_LABELS.joining,
	opening: GAME_TEXT_INDEX_PHASE_LABELS.opening,
	corpus: GAME_TEXT_INDEX_PHASE_LABELS.corpus,
	localization_quality: GAME_TEXT_INDEX_PHASE_LABELS.localization_quality,
	source_quality: GAME_TEXT_INDEX_PHASE_LABELS.source_quality
} as const satisfies Record<GameTextWorkspacePhase, string>;

/**
 * The workspace's latest progress: its phase, with that phase's counts (not a percentage of the
 * whole scan) and, during a quality scan, its findings so far.
 */
export const GameTextWorkspaceProgress = Schema.Struct({
	phase: GameTextWorkspacePhase,
	completed: Count,
	total: Count,
	/** Findings so far, during a quality scan; its last event has the scan's count. */
	findings: Schema.optionalKey(Count),
	/**
	 * The scan step running now, of `steps`: the host's project scan, then each Game Text scan
	 * phase in the order they start. A step a scan does not need is skipped, not renumbered.
	 */
	step: Schema.optionalKey(Step),
	steps: Schema.optionalKey(Step)
});
export type GameTextWorkspaceProgress = typeof GameTextWorkspaceProgress.Type;
