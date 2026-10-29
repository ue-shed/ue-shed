import { GameTextIndexQuery } from "./index-query-native.js";
import { randomUUID, createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
	Cause,
	Deferred,
	Exit,
	Fiber,
	Context,
	Effect,
	Layer,
	Schema,
	Semaphore,
	RcMap,
	Stream,
	Struct,
	Scope,
	Option,
	Result
} from "effect";
import { LocalizationImportSession } from "./localization-import-session.js";
import {
	readLocalizationReview,
	emptyLocalizationReviewFile,
	defaultLocalizationReviewPath,
	LocalizationFileAccessLive,
	LocalizationFileAccess,
	localizationError,
	type LocalizationError,
	LocalizationEvidence,
	LocalizationTarget,
	sourceGatherSteps
} from "@ue-shed/localization";
import {
	SharedIndex,
	sharedIndexNodeLayer,
	type SharedIndexOptions,
	type SharedIndexManifest,
	sharedIndexDirectory
} from "./shared-index.js";
import { GameTextIndexBuilder, type GameTextIndexBuildSessionRequest } from "./index-builder.js";
import {
	type GameTextIndexProgress,
	GameTextIndexProgressReporter,
	progressHost,
	reachesProgressHost
} from "./index-progress.js";
import {
	GameTextIndexError,
	isGameTextIndexError,
	GameTextIndexSource,
	GameTextIndexRefreshRequest,
	type GameTextCodeSource,
	type GameTextIndexRefreshResult,
	type IndexFailure
} from "./index-contract.js";
import { codeLayerName, PACKAGE_TEXT_FORMAT } from "./package-text-layer.js";
import { packageTextAudienceRules } from "./package-text-native.js";
import { TEXT_AUDIENCE_POLICY_KEY } from "./text-audience.js";
import { isSnapshotStoreError } from "./snapshot-store.js";
import { isSnapshotFormatError } from "./snapshot-format.js";
import {
	indexedLocalizationLinesRequest,
	readIndexedLocalizationEvidence
} from "./index-context.js";
import {
	indexedLocalizationCheckReport,
	prepareLocalizationCheck
} from "./localization-check-report.js";
import type { TextCorpusReportHeader } from "./corpus-summary.js";
import { acceptReview } from "./native-findings.js";
import {
	queriedLocalizationQualityWorkspace,
	type QueriedLocalizationQuality
} from "./localization-workspace.js";
import { queriedTextQualityQuery } from "./quality-query.js";
import { enabledLocalizationChecks } from "./localization-checks.js";
import { localizationRuleId } from "./localization-check-catalogue.js";
import { localizationPolicyRules } from "./localization-policy.js";
import { customRulesOf, localizationRulesOf, sourceRulesOf } from "./game-text-rules.js";
import { effectiveRuleDocument, enabledRuleDocument } from "./rules/effective.js";
import type { RuleDocumentV4 } from "./rules/schema.js";
import type { GameTextContract } from "@ue-shed/protocol";
import { openJoinedTarget, readJoinedTarget } from "./joined-target-reader.js";
import type { importLocalizationTarget } from "./localization-import.js";
import type { refreshPackageTextLayer } from "./package-text-layer.js";
import type { RefreshJoinedTarget, JoinedTargetInput } from "./joined-target.js";
import type { LocalizationReviewSnapshot } from "@ue-shed/localization";
import type { GameTextProjectView } from "./project-index-view.js";
import { encodeWtf8 } from "./wtf8.js";
import { coldHalfBudget } from "./cold-task-pool.js";
import { withHostSlices } from "./host-slices.js";
import { mountPackageTextEvent } from "./package-object-path.js";
import {
	observeGameTextImport,
	checkRetainedImportObservations
} from "./index-import-observation.js";

/**
 * Project-only refresh options shared with the full index request. A saved package inventory
 * can be supplied by the host; changedFiles distinguishes full refresh from reuse.
 */
export const GameTextProjectRefreshRequest = Schema.Struct(
	Struct.pick(GameTextIndexRefreshRequest.fields, [
		"projectRoot",
		"changedFiles",
		"savedPackages"
	])
);
export type GameTextProjectRefreshRequest = typeof GameTextProjectRefreshRequest.Type;
/**
 * Target selection and evidence-refresh options. requireManifest controls whether missing
 * gathered text fails preparation; changedFiles preserves the same full-refresh versus reuse
 * semantics as project refresh.
 */
export const GameTextTargetImportRequest = Schema.Struct(
	Struct.pick(GameTextIndexRefreshRequest.fields, [
		"targetName",
		"requireManifest",
		"changedFiles",
		"code"
	])
);
export type GameTextTargetImportRequest = typeof GameTextTargetImportRequest.Type;
/**
 * Explicit key-change choices and review-error tolerance for building a target. These policy
 * choices affect the derived join without changing authored assets or the selected project.
 */
export const GameTextTargetBuildRequest = Schema.Struct(
	Struct.pick(GameTextIndexRefreshRequest.fields, ["keyChangePairs", "tolerateReviewErrors"])
);
export type GameTextTargetBuildRequest = typeof GameTextTargetBuildRequest.Type;

type Packages = Effect.Success<ReturnType<typeof refreshPackageTextLayer>>;
type Imported = Effect.Success<ReturnType<typeof importLocalizationTarget>>;
type Join = Effect.Success<ReturnType<RefreshJoinedTarget>>;
type MutableFileErrors = {
	-readonly [K in keyof NonNullable<JoinedTargetInput["fileErrors"]>]: NonNullable<
		JoinedTargetInput["fileErrors"]
	>[K];
};
type MutableFileProvenances = {
	-readonly [K in keyof NonNullable<JoinedTargetInput["fileProvenances"]>]: NonNullable<
		JoinedTargetInput["fileProvenances"]
	>[K];
};
type MutableFileDiagnostics = {
	-readonly [K in keyof NonNullable<JoinedTargetInput["fileDiagnostics"]>]: NonNullable<
		JoinedTargetInput["fileDiagnostics"]
	>[K];
};
/** A verified package revision. It owns no reader or writer lease and can be reused by targets. */
export interface GameTextProject {
	readonly projectRoot: string;
	readonly cacheRoot: string;
}
/**
 * Verified package revision reusable across localization targets. Its generation and package
 * key establish dependency identity; the value itself holds no reader pin or writer lease.
 */
export interface GameTextProjectIndex extends GameTextProject {
	readonly generation: string;
	readonly packageKey: string;
	readonly packages: Packages;
	readonly changedFiles?: readonly string[];
}
/**
 * Prepared localization inputs tied to a project revision and target view. File keys establish
 * which retained evidence a later build consumes; importing does not publish a query model.
 */
export interface GameTextTargetImport {
	readonly project: GameTextProject;
	readonly view: GameTextProjectView;
	readonly imported: Imported;
	/** Current layer and observation dependencies, including failed and incrementally reused files. */
	readonly fileKeys: Readonly<Record<string, string | undefined>>;
	readonly fileErrors: NonNullable<JoinedTargetInput["fileErrors"]>;
	readonly fileProvenances: NonNullable<JoinedTargetInput["fileProvenances"]>;
	readonly fileDiagnostics: NonNullable<JoinedTargetInput["fileDiagnostics"]>;
	/** What the import did with the target's code layer; absent when it had none to touch. */
	readonly code?: GameTextContract.CodeLayerOutcome | undefined;
}
/**
 * Built target and its exact project/input identities, before opening readers. A queryRevision
 * is opaque and comparable only within the same project, cache and backend.
 */
export interface GameTextTargetIndex {
	readonly project: GameTextProjectIndex;
	readonly imported: Imported;
	readonly view: GameTextProjectView;
	readonly join: Join;
	readonly review: LocalizationReviewSnapshot;
	readonly generation: string;
	/** Opaque identity for comparing this validated target with an already opened model. */
	readonly queryRevision?: string | undefined;
	readonly fileKeys: GameTextTargetImport["fileKeys"];
}
/**
 * Opened target model with its validated project inventory attached. Queries and quality
 * operations refer to that immutable revision and require the model's owning scope to remain
 * open.
 */
export interface GameTextIndexModel extends GameTextIndexRefreshResult {
	readonly project: GameTextProjectIndex;
}

/**
 * The latest event of each quality evaluation running for a progress host, least recent first,
 * with the reporter it reports through. Every model opened for one host shares it, so an
 * evaluation that ends leaves the others shown.
 */
const runningEvaluations = new WeakMap<
	(progress: GameTextIndexProgress) => void,
	Map<
		symbol,
		{
			readonly progress: GameTextIndexProgress;
			readonly reporter: (progress: GameTextIndexProgress) => void;
		}
	>
>();

/** Models opened by this process, numbering each model's revision. */
let openedModels = 0;
const queryRevisionFor = (project: GameTextProject, generation: string, joinedKey: string) =>
	JSON.stringify([project.cacheRoot, project.projectRoot, generation, joinedKey]);

const failure = (
	operation: string,
	message: string,
	recovery: string,
	cause?: unknown,
	guidance: Pick<GameTextIndexError, "nextStep" | "retrySafe"> = {
		nextStep: operation === "request" || operation === "project" ? "fix_input" : "escalate",
		retrySafe: false
	}
) =>
	new GameTextIndexError({
		...guidance,
		code: "index_failed",
		operation,
		message,
		recovery,
		...(cause === undefined ? undefined : { cause })
	});
const stale = (operation: string) =>
	failure(
		operation,
		"The Game Text index inputs changed between steps.",
		"Refresh the project index and prepare the selected target again.",
		undefined,
		{ nextStep: "reconcile", retrySafe: true }
	);
const manifestIndexFailure = (cause: LocalizationError) =>
	new GameTextIndexError({
		code: "index_failed",
		operation: "manifest",
		message: cause.message,
		recovery: cause.recovery,
		nextStep: cause.nextStep,
		retrySafe: cause.retrySafe,
		cause,
		localizationError: cause
	});
const packageKey = (manifest: SharedIndexManifest) =>
	createHash("sha256")
		.update(
			encodeWtf8(
				JSON.stringify(
					Object.entries(manifest.active)
						.filter(([name]) => name.startsWith("package-text."))
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				)
			)
		)
		.digest("hex");
const configurationFor = (
	cacheRoot: string,
	projectRoot: string,
	targetName?: string
): SharedIndexOptions => ({
	cacheRoot,
	projectKey: projectRoot,
	targetKey: targetName ?? "SavedText",
	projectView:
		targetName === undefined ? { kind: "source" } : { kind: "localization", target: targetName }
});
const checkProject = (project: GameTextProjectIndex, manifest: SharedIndexManifest) =>
	project.generation === manifest.generation && project.packageKey === packageKey(manifest)
		? Effect.void
		: Effect.fail(stale("project"));
const normalizeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.mapError((cause) =>
			isGameTextIndexError(cause) ||
			isSnapshotStoreError(cause) ||
			isSnapshotFormatError(cause)
				? cause
				: failure(
						"index",
						"The Game Text index operation failed.",
						"Refresh the Game Text index and retry.",
						cause
					)
		)
	);
const savedTarget = Schema.decodeUnknownSync(LocalizationTarget)({
	name: "SavedText",
	source: "config_only",
	nativeCulture: null,
	cultures: [],
	configs: [],
	outputPaths: {
		manifest: null,
		archives: {},
		portableObjects: {},
		resources: {},
		locmeta: null,
		wordCount: null,
		conflicts: null
	},
	poFormat: "Unreal",
	collapseMode: "IdenticalTextIdAndSource"
});

/** Work shared with a concurrent producer inside one coordinated prepare. */
export interface ConcurrentPrepareOptions {
	/** This branch's share of one cold memory budget. */
	readonly memoryBudgetBytes?: number;
	/** Awaited by the package branch after its read, before it publishes. */
	readonly publishGate?: Effect.Effect<void, never, never>;
	/** Run by the package branch once it has planned its refresh. */
	readonly planned?: Effect.Effect<void, never, never>;
	/** Awaited by the localization branch before its first native command. */
	readonly planGate?: Effect.Effect<void, never, never>;
}

/** How the index steps place their work. */
export type GameTextIndexStepsOptions = Record<string, never>;

/**
 * Constructs the independently usable step port in the caller's Effect scope. Its service
 * requirements supply policy-neutral evidence and the selected builder; it does not own project
 * selection.
 */
export const makeGameTextIndexSteps = (
	cacheRoot: string,
	_options: GameTextIndexStepsOptions = {}
) =>
	Effect.gen(function* () {
		const source = yield* GameTextIndexSource;
		const evidence = yield* LocalizationEvidence;
		const builder = yield* GameTextIndexBuilder;
		const queries = yield* GameTextIndexQuery;
		const writers = yield* RcMap.make({
			lookup: (_project: string) => Semaphore.make(1),
			capacity: 8
		});
		const withSession = <A, E, R>(
			configuration: SharedIndexOptions,
			effect: Effect.Effect<A, E, R>,
			files?: readonly string[],
			sourceOnly = false
		) => {
			const request: GameTextIndexBuildSessionRequest = { configuration };
			if (files !== undefined) Object.assign(request, { files });
			return Effect.scoped(
				Effect.gen(function* () {
					const active = yield* Effect.serviceOption(LocalizationImportSession);
					if (
						Option.isSome(active) &&
						sharedIndexDirectory(active.value.configuration) ===
							sharedIndexDirectory(configuration) &&
						(sourceOnly ||
							JSON.stringify(active.value.configuration.projectView) ===
								JSON.stringify(configuration.projectView))
					) {
						return yield* effect.pipe(
							Effect.provideService(SharedIndex, active.value.index),
							Effect.provideService(LocalizationImportSession, active.value)
						);
					}
					const writer = yield* RcMap.get(
						writers,
						sharedIndexDirectory(configuration)
					).pipe(
						Effect.mapError((cause) =>
							failure(
								"writer",
								"Too many project writers are active.",
								"Wait for a project operation to finish and retry.",
								cause
							)
						)
					);
					return yield* writer.withPermit(builder.withSession(request, effect));
				})
			).pipe(normalizeFailure);
		};

		const openProject = Effect.fn("GameTextIndex.openProject")(function* (input: {
			readonly projectRoot: string;
		}) {
			const request = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ projectRoot: GameTextIndexRefreshRequest.fields.projectRoot })
			)(input).pipe(
				Effect.mapError((cause) =>
					failure(
						"request",
						"The Game Text index request is invalid.",
						"Choose a project.",
						cause
					)
				)
			);
			const projectRoot = yield* Effect.tryPromise({
				try: () => realpath(request.projectRoot),
				catch: (cause) =>
					failure(
						"project",
						"The project directory could not be resolved.",
						"Choose an accessible Unreal project directory.",
						cause
					)
			});
			return { projectRoot, cacheRoot } satisfies GameTextProject;
		});

		const refreshProject = Effect.fn("GameTextIndex.refreshProject")(function* (
			input: GameTextProjectRefreshRequest,
			concurrent?: ConcurrentPrepareOptions
		) {
			const reportProgress = yield* GameTextIndexProgressReporter;
			const request = yield* Schema.decodeUnknownEffect(GameTextProjectRefreshRequest)(
				input
			).pipe(
				Effect.mapError((cause) =>
					failure(
						"request",
						"The Game Text index request is invalid.",
						"Choose a project.",
						cause
					)
				)
			);
			const { projectRoot } = yield* openProject(request);
			return yield* withSession(
				configurationFor(cacheRoot, projectRoot),
				Effect.gen(function* () {
					const index = yield* SharedIndex;
					reportProgress({ phase: "inventory", completed: 0, total: 0 });
					// The native writer plans from the Catalog; otherwise the inventory is read here.
					const catalog =
						request.savedPackages === false || !source.catalog || !builder.plansPackages
							? undefined
							: yield* source.catalog({ ...request, projectRoot });
					// Without a Catalog the writer doesn't plan, so its other commands needn't wait.
					if (!catalog && concurrent?.planned) yield* concurrent.planned;
					const inventory =
						request.savedPackages === false || catalog
							? []
							: yield* source.inventory({ ...request, projectRoot });
					const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
					const retainedPackages =
						request.savedPackages === false &&
						Object.keys((yield* index.inspect()).active).some((name) =>
							name.startsWith("package-text.")
						);
					const packageRequest = {
						...(catalog ? { catalog } : { inventory }),
						// Stored records carry Unreal's object paths, as the in-memory corpus does.
						read: (paths, signatures) =>
							source
								.read(
									projectRoot,
									paths.map(
										(path) =>
											byPath.get(path) ?? {
												path,
												signature: signatures.get(path)!
											}
									)
								)
								.pipe(
									Stream.map((event) => mountPackageTextEvent(projectRoot, event))
								)
					} satisfies Parameters<typeof refreshPackageTextLayer>[0];
					if (request.changedFiles !== undefined)
						Object.assign(packageRequest, { changedFiles: request.changedFiles });
					if (concurrent?.memoryBudgetBytes !== undefined)
						Object.assign(packageRequest, {
							memoryBudgetBytes: concurrent.memoryBudgetBytes
						});
					if (concurrent?.publishGate !== undefined)
						Object.assign(packageRequest, { publishGate: concurrent.publishGate });
					if (concurrent?.planned !== undefined)
						Object.assign(packageRequest, { planned: concurrent.planned });
					const stage = source.stage;
					if (stage)
						Object.assign(packageRequest, {
							stage: {
								projectRoot,
								read: (
									paths: readonly string[],
									directory: string,
									groups: readonly number[],
									snapshots: import("./package-text-native.js").PackageTextSnapshots
								) =>
									stage(
										projectRoot,
										paths.map((path) => byPath.get(path)!),
										{ directory, groups, snapshots }
									)
							}
						});
					const packages = retainedPackages
						? {
								readPackages: 0,
								reusedPackages: 0,
								changedShards: 0,
								removedShards: 0,
								published: false,
								profile: (yield* index.writer()).metrics()
							}
						: yield* Effect.scoped(builder.refreshPackageTextLayer(packageRequest));
					const manifest = yield* index.inspect();
					const result: GameTextProjectIndex = {
						projectRoot,
						cacheRoot,
						packages,
						generation: manifest.generation,
						packageKey: packageKey(manifest)
					};
					if (request.changedFiles !== undefined)
						Object.assign(result, { changedFiles: request.changedFiles });
					return result;
				}),
				undefined,
				true
			);
		});

		const checkRequiredManifest = Effect.fn("GameTextIndex.checkRequiredManifest")(function* (
			project: GameTextProject,
			request: GameTextTargetImportRequest
		) {
			if (request.requireManifest && request.targetName !== undefined) {
				// Validate required authored evidence before acquiring a native writer/process.
				// The importer still validates current bytes; this presence check is not a cache hit.
				const discovery = yield* evidence
					.discover({ projectRoot: project.projectRoot })
					.pipe(Effect.mapError(manifestIndexFailure));
				const target = discovery.targets.find((item) => item.name === request.targetName);
				if (!target)
					return yield* Effect.fail(
						manifestIndexFailure(localizationError("target_not_found"))
					);
				const path = target.outputPaths.manifest;
				const present =
					path !== null &&
					path !== undefined &&
					(yield* Effect.flatMap(LocalizationFileAccess, (files) =>
						files.presence(project.projectRoot, path)
					).pipe(
						Effect.provide(LocalizationFileAccessLive),
						Effect.mapError(manifestIndexFailure)
					));
				if (!present)
					return yield* Effect.fail(
						manifestIndexFailure(localizationError("file_missing"))
					);
			}
		});

		const importTarget = Effect.fn("GameTextIndex.importTarget")(function* (
			project: GameTextProject,
			input: GameTextTargetImportRequest = {},
			concurrent?: ConcurrentPrepareOptions
		) {
			const request = yield* Schema.decodeUnknownEffect(GameTextTargetImportRequest)(
				input
			).pipe(
				Effect.mapError((cause) =>
					failure(
						"request",
						"The Game Text index request is invalid.",
						"Choose a localization target.",
						cause
					)
				)
			);
			if (project.cacheRoot !== cacheRoot) return yield* Effect.fail(stale("project"));
			yield* checkRequiredManifest(project, request);
			if (concurrent?.planGate) yield* concurrent.planGate;
			return yield* withSession(
				configurationFor(cacheRoot, project.projectRoot, request.targetName),
				Effect.gen(function* () {
					const index = yield* SharedIndex;
					let fileErrors: MutableFileErrors = {};
					let fileProvenances: MutableFileProvenances = {};
					let fileDiagnostics: MutableFileDiagnostics = {};
					if (
						request.changedFiles !== undefined &&
						(yield* index.inspect()).active.joined
					) {
						const previous = yield* Effect.scoped(
							Effect.gen(function* () {
								return yield* readJoinedTarget(yield* index.open(), true);
							})
						);
						yield* checkRetainedImportObservations(previous.meta, request.changedFiles);
						fileErrors = { ...previous.meta.input.fileErrors };
						fileProvenances = { ...previous.meta.input.fileProvenances };
						fileDiagnostics = { ...previous.meta.input.fileDiagnostics };
					}
					const imported =
						request.targetName === undefined
							? {
									target: savedTarget,
									files: [],
									diagnostics: [],
									profile: null
								}
							: yield* Effect.scoped(
									builder.importLocalizationTarget({
										projectRoot: project.projectRoot,
										cacheRoot,
										targetName: request.targetName,
										projectScoped: true,
										...(concurrent?.memoryBudgetBytes === undefined
											? undefined
											: {
													memoryBudgetBytes: concurrent.memoryBudgetBytes
												})
									})
								).pipe(Effect.provideService(LocalizationEvidence, evidence));
					const manifestFailure = imported.diagnostics.find(
						(item) => item.relativePath === imported.target.outputPaths.manifest
					);
					if (request.requireManifest && manifestFailure)
						return yield* Effect.fail(manifestIndexFailure(manifestFailure.error));
					for (const file of imported.files) {
						delete fileErrors[file.relativePath];
						delete fileDiagnostics[file.relativePath];
						fileProvenances[file.relativePath] = file.provenance;
					}
					for (const diagnostic of imported.diagnostics)
						if (diagnostic.relativePath) {
							fileErrors[diagnostic.relativePath] = diagnostic.error.code;
							fileDiagnostics[diagnostic.relativePath] = diagnostic.error;
							delete fileProvenances[diagnostic.relativePath];
						}
					const fileKeys = yield* observeGameTextImport({
						imported,
						fileErrors,
						fileProvenances,
						fileDiagnostics
					});
					const code =
						request.targetName === undefined
							? undefined
							: yield* publishTargetCode(project, imported.target, request.code);
					return {
						...(code === undefined ? undefined : { code }),
						project,
						view:
							request.targetName === undefined
								? { kind: "source" }
								: { kind: "localization", target: request.targetName },
						imported,
						fileKeys,
						fileErrors,
						fileProvenances,
						fileDiagnostics
					} satisfies GameTextTargetImport;
				}),
				request.changedFiles
			);
		});

		/**
		 * Scans the target's code in the reader and publishes its code layer when it changed, or
		 * removes the layer when the host names no engine or the target reads no code.
		 */
		const publishTargetCode = Effect.fn("GameTextIndex.publishTargetCode")(function* (
			project: GameTextProject,
			target: LocalizationTarget,
			source: GameTextCodeSource | undefined
		) {
			const index = yield* SharedIndex;
			const writer = yield* index.writer();
			if (!writer.publishCode) return undefined;
			const steps = sourceGatherSteps(target);
			const scan =
				source === undefined || steps.length === 0
					? undefined
					: {
							projectRoot: project.projectRoot,
							engineRoot: source.engineRoot ?? null,
							engine: source.engine,
							targets: [{ name: target.name, steps }],
							cacheRoot,
							refreshEngineWrappers: source.refreshEngineWrappers === true
						};
			if (scan === undefined && !(yield* index.inspect()).active[codeLayerName(target.name)])
				return undefined;
			const outcome = yield* writer.publishCode({
				target: target.name,
				format: PACKAGE_TEXT_FORMAT,
				policyJson: TEXT_AUDIENCE_POLICY_KEY,
				rules: packageTextAudienceRules(),
				...(scan === undefined ? undefined : { scan })
			});
			yield* Effect.annotateCurrentSpan({
				"code.places": outcome.places,
				"code.leftOut": outcome.leftOut,
				"code.files": outcome.files,
				"code.published": outcome.published,
				"code.diagnostics": outcome.diagnosticCount,
				...(outcome.profile === undefined
					? undefined
					: {
							"code.engineWrappersMicros": outcome.profile.engineWrappersMicros,
							"code.projectWrappersMicros": outcome.profile.projectWrappersMicros,
							"code.listMicros": outcome.profile.listMicros,
							"code.scanMicros": outcome.profile.scanMicros
						})
			});
			return outcome;
		});

		const buildTarget = Effect.fn("GameTextIndex.buildTarget")(function* (
			project: GameTextProjectIndex,
			target: GameTextTargetImport,
			input: GameTextTargetBuildRequest = {}
		): Effect.fn.Return<GameTextTargetIndex, IndexFailure> {
			const request = yield* Schema.decodeUnknownEffect(GameTextTargetBuildRequest)(
				input
			).pipe(
				Effect.mapError((cause) =>
					failure(
						"request",
						"The Game Text index request is invalid.",
						"Check the target build options.",
						cause
					)
				)
			);
			const { imported } = target;
			if (
				project.cacheRoot !== cacheRoot ||
				project.projectRoot !== target.project.projectRoot
			)
				return yield* Effect.fail(stale("project"));
			return yield* withSession(
				configurationFor(
					cacheRoot,
					project.projectRoot,
					target.view.kind === "source" ? undefined : target.view.target
				),
				Effect.gen(function* () {
					const reportProgress = yield* GameTextIndexProgressReporter;
					const index = yield* SharedIndex;
					const manifest = yield* index.inspect();
					yield* checkProject(project, manifest);
					if (
						Object.entries(target.fileKeys).some(
							([path, key]) => manifest.active[path] !== key
						)
					)
						return yield* Effect.fail(stale("localization"));
					const review = yield* readLocalizationReview({
						projectRoot: project.projectRoot,
						target: imported.target.name
					}).pipe(
						Effect.provide(LocalizationFileAccessLive),
						Effect.catch((cause) =>
							request.tolerateReviewErrors
								? Effect.succeed({
										file: emptyLocalizationReviewFile(imported.target.name),
										relativePath: defaultLocalizationReviewPath(
											imported.target.name
										),
										contentHash: null
									})
								: Effect.fail(cause)
						)
					);
					const joinInput: JoinedTargetInput = {
						force: Boolean(manifest.active["joined.invalidated"]),
						projectRoot: project.projectRoot,
						target: imported.target,
						fileErrors: target.fileErrors,
						fileProvenances: target.fileProvenances,
						fileDiagnostics: target.fileDiagnostics
					};
					if (request.keyChangePairs !== undefined)
						Object.assign(joinInput, { keyChangePairs: request.keyChangePairs });
					if (review.contentHash !== null)
						Object.assign(joinInput, { review: review.file });
					reportProgress({ phase: "joining", completed: 0, total: 0 });
					const join = yield* Effect.scoped(builder.refreshJoinedTarget(joinInput));
					if ((yield* index.inspect()).active["joined.invalidated"])
						yield* (yield* index.writer()).publishBatch([], ["joined.invalidated"]);
					const generation = (yield* index.inspect()).generation;
					return {
						project,
						view: target.view,
						imported,
						fileKeys: target.fileKeys,
						join,
						review,
						generation,
						queryRevision: queryRevisionFor(project, generation, join.key)
					} satisfies GameTextTargetIndex;
				})
			);
		});

		/** Prepare all source inputs and the target under one coordinated writer lease. */
		const prepareTarget = Effect.fn("GameTextIndex.prepareTarget")(function* (
			request: GameTextIndexRefreshRequest,
			options: { readonly fallbackToSource?: boolean } = {}
		): Effect.fn.Return<GameTextTargetIndex, IndexFailure> {
			const selected = yield* openProject(request);
			const prepare = (input: GameTextIndexRefreshRequest) =>
				Effect.gen(function* () {
					const checked = yield* checkRequiredManifest(selected, input).pipe(
						Effect.result
					);
					if (Result.isFailure(checked))
						return { kind: "import-failed" as const, cause: checked.failure };
					return yield* withSession(
						configurationFor(cacheRoot, selected.projectRoot, input.targetName),
						Effect.gen(function* () {
							// The two branches read disjoint inputs and publish disjoint
							// layers into the one leased writer; native commands stay
							// serialized by the writer's own lane. The package branch
							// publishes only after the gate opens, with both reads done.
							// Branch finalizers finish in this scope before the writer lease closes.
							// The package plan is a short native command on the longer branch's
							// path, so the localization import, which holds the writer for most
							// of its branch, waits for it.
							const share = coldHalfBudget(process.availableMemory());
							const gate = yield* Deferred.make<void>();
							const planned = yield* Deferred.make<void>();
							const importedFiber = yield* Effect.forkScoped(
								Effect.result(
									importTarget(selected, input, {
										memoryBudgetBytes: share,
										planGate: Deferred.await(planned)
									})
								)
							);
							const projectFiber = yield* Effect.forkScoped(
								refreshProject(input, {
									memoryBudgetBytes: share,
									publishGate: Deferred.await(gate),
									planned: Deferred.succeed(planned, undefined).pipe(
										Effect.asVoid
									)
								}).pipe(Effect.ensuring(Deferred.succeed(planned, undefined)))
							);
							const importedExit = yield* Fiber.await(importedFiber);
							if (Exit.isFailure(importedExit)) {
								yield* Fiber.interrupt(projectFiber);
								return yield* Effect.failCause(importedExit.cause);
							}
							const imported = importedExit.value;
							if (Result.isFailure(imported)) {
								yield* Fiber.interrupt(projectFiber);
								return { kind: "import-failed" as const, cause: imported.failure };
							}
							yield* Deferred.succeed(gate, undefined);
							const project = yield* Fiber.join(projectFiber);
							const target = yield* buildTarget(project, imported.success, input);
							return { kind: "prepared" as const, target };
						}).pipe(Effect.scoped),
						input.changedFiles
					);
				});
			const result = yield* prepare(request);
			if (result.kind === "prepared") return result.target;
			if (!options.fallbackToSource || request.targetName === undefined)
				return yield* Effect.fail(result.cause);
			// Release the failed target session before attempting a different view. Native failures
			// close their session; they must never be swallowed inside a still-leased writer.
			const { targetName: _target, requireManifest: _manifest, ...sourceRequest } = request;
			const source = yield* prepare(sourceRequest);
			if (source.kind === "import-failed") return yield* Effect.fail(source.cause);
			return source.target;
		});

		const openTarget = Effect.fn("GameTextIndex.openTarget")(function* (
			target: GameTextTargetIndex
		): Effect.fn.Return<GameTextIndexModel, IndexFailure, Scope.Scope> {
			const reportProgress = yield* GameTextIndexProgressReporter;
			const configuration = configurationFor(
				cacheRoot,
				target.project.projectRoot,
				target.view.kind === "source" ? undefined : target.view.target
			);
			const indexLayer = sharedIndexNodeLayer(configuration);
			const result = {
				imported: target.imported,
				join: target.join,
				review: target.review,
				packages: target.project.packages
			};
			reportProgress({ phase: "opening", completed: 0, total: 0 });
			const joined = yield* openJoinedTarget().pipe(
				Effect.provide(indexLayer),
				normalizeFailure
			);
			yield* checkProject(target.project, joined.reader.manifest);
			if (
				Object.entries(target.fileKeys).some(
					([name, key]) => joined.reader.manifest.active[name] !== key
				)
			)
				return yield* Effect.fail(stale("localization"));
			if (
				joined.reader.manifest.generation !== target.generation ||
				joined.reader.manifest.active.joined !== target.join.key ||
				joined.reader.manifest.active["joined.invalidated"]
			)
				return yield* Effect.fail(stale("target"));
			yield* Effect.annotateCurrentSpan({
				"game_text.index.packages_read": result.packages.readPackages,
				"game_text.index.join_rebuilt": result.join.rebuilt,
				"game_text.index.generation": joined.reader.manifest.generation,
				"game_text.index.query_backend": "native"
			});
			const indexedEvidence = yield* readIndexedLocalizationEvidence(joined).pipe(
				Effect.provide(LocalizationFileAccessLive),
				Effect.mapError((cause) =>
					failure(
						"evidence",
						"The retained localization evidence could not be read.",
						"Refresh the Game Text index and retry.",
						cause
					)
				)
			);
			const native = yield* queries.open({
				configuration,
				generation: target.generation,
				joinedKey: target.join.key
			});
			const query = native;
			const summary = yield* query.summary();
			const search = query.search;
			const searchRows = query.searchRows;
			reportProgress({ phase: "ready", completed: 0, total: 0 });
			const corpus = query.readCorpus();
			const localization = {
				schemaVersion: 1 as const,
				target: joined.meta.input.target.name,
				nativeCulture: joined.meta.input.target.nativeCulture,
				cultures: joined.meta.input.target.cultures
			};
			const localizationJoin = query
				.localizationLines(indexedLocalizationLinesRequest(joined))
				.pipe(Effect.map((lines) => ({ ...localization, lines })));
			// The check report's target, corpus facts, evidence and findings.
			const checkInput = (header: TextCorpusReportHeader) =>
				[
					{
						target: joined.meta.input.target.name,
						cultures: joined.meta.input.target.cultures
					},
					{ status: summary.status, ...header },
					indexedEvidence,
					query
				] as const;
			// The host's running evaluations, on any model opened for it.
			const host = progressHost(reportProgress);
			const evaluations = runningEvaluations.get(host) ?? new Map();
			runningEvaluations.set(host, evaluations);
			/**
			 * Evaluates a document's findings with a check's progress, in rules: one event before
			 * the engine runs, one as each rule finishes, and one after, with the findings of the
			 * rules `counted` selects. Reports through the reporter captured when this target opened,
			 * so later evaluations still reach the host that opened the index. When it ends, also by
			 * failing or being interrupted, the host sees another running evaluation's latest event,
			 * or ready when none runs, as after a scan.
			 */
			const evaluateWithProgress = (
				phase: "localization_quality" | "source_quality",
				document: RuleDocumentV4,
				counted: (rule: GameTextContract.RuleMetadata) => boolean
			) =>
				Effect.suspend(() => {
					const evaluation = Symbol(phase);
					const report = (progress: GameTextIndexProgress) => {
						evaluations.delete(evaluation);
						evaluations.set(evaluation, { progress, reporter: reportProgress });
						reportProgress(progress);
					};
					return Effect.gen(function* () {
						const rules = enabledRuleDocument(document).rules.length;
						report({ phase, completed: 0, total: rules, findings: 0 });
						const evaluated = yield* query.findingsEvaluate(document, (progress) => {
							if (progress.unit === "rules" && progress.completed > 0)
								report({ phase, completed: progress.completed, total: rules });
						});
						let findings = 0;
						for (const { rule, count } of evaluated.counts)
							if (counted(evaluated.rules[rule]!)) findings += count;
						report({ phase, completed: rules, total: rules, findings });
						return evaluated;
					}).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								evaluations.delete(evaluation);
								// A replaced model's evaluation no longer reaches the host, so it is
								// never shown again; its own end could not clear it.
								const running = [...evaluations.values()].filter(({ reporter }) =>
									reachesProgressHost(reporter)
								);
								reportProgress(
									running.at(-1)?.progress ?? {
										phase: "ready",
										completed: 0,
										total: 0
									}
								);
							})
						)
					);
				});
			return {
				...result,
				project: target.project,
				queryRevision: queryRevisionFor(
					target.project,
					joined.reader.manifest.generation,
					target.join.key
				),
				revision: `${joined.reader.manifest.generation}#${++openedModels}`,
				joined,
				query,
				summary,
				localization,
				search,
				searchRows,
				evidence: indexedEvidence,
				corpus,
				localizationJoin,
				// Quality is the engine's: every page, focus and proposal is a findings query.
				localizationQuality: (ruleDocument, scanOptions) =>
					Effect.gen(function* () {
						const options = scanOptions ?? {};
						const target = joined.meta.input.target;
						const join = {
							target: target.name,
							nativeCulture: target.nativeCulture,
							cultures: target.cultures
						};
						const evaluated = yield* evaluateWithProgress(
							"localization_quality",
							effectiveRuleDocument(ruleDocument, options),
							(rule) => rule.subject !== "unit_source"
						);
						const acceptance = yield* acceptReview(
							query,
							evaluated.key,
							options.review
						);
						const enabled = enabledLocalizationChecks(
							join,
							indexedEvidence,
							options,
							ruleDocument
						);
						const customChecks = customRulesOf(ruleDocument);
						return {
							findings: {
								key: evaluated.key,
								...(acceptance ? { acceptance } : undefined)
							},
							workspace: queriedLocalizationQualityWorkspace({
								findings: query,
								key: evaluated.key,
								rules: evaluated.rules,
								acceptance,
								metadata: {
									join,
									rules: [
										...sourceRulesOf(ruleDocument)
											.map((rule) => rule.id)
											.sort((left, right) => left.localeCompare(right)),
										...localizationRulesOf(ruleDocument).map((rule) => rule.id),
										...enabled.map(localizationRuleId),
										...customChecks.map((custom) => custom.id)
									],
									...(customChecks.length
										? {
												customChecks: customChecks.map(({ id, label }) => ({
													ruleId: id,
													label
												}))
											}
										: undefined),
									unsupportedRuleCultures: ruleDocument
										? localizationPolicyRules(target.cultures, ruleDocument)
												.diagnostics.length
										: 0,
									status: summary.status,
									coverage: summary.coverage
								},
								detail: query.localizationDetail
							})
						} satisfies QueriedLocalizationQuality;
					}),
				sourceQuality: (ruleDocument) =>
					Effect.gen(function* () {
						const evaluation = yield* evaluateWithProgress(
							"source_quality",
							effectiveRuleDocument(ruleDocument),
							(rule) => rule.subject === "unit_source"
						);
						const header = yield* query.readCorpusReportHeader();
						return yield* queriedTextQualityQuery({
							findings: query,
							evaluation,
							report: {
								coverage: summary.coverage,
								diagnostics: header.diagnostics,
								diagnosticCount: header.diagnosticCount,
								diagnosticCounts: header.diagnosticCounts,
								diagnosticsOmitted: header.diagnosticsOmitted,
								ruleDocumentVersion: ruleDocument.schemaVersion,
								schemaVersion: 1,
								status: summary.status
							}
						});
					}),
				// The engine writes the report's findings; the host never reads the corpus or join.
				prepareLocalizationCheck: (document, options) =>
					Effect.flatMap(query.readCorpusReportHeader(), (header) =>
						prepareLocalizationCheck(...checkInput(header), options, document)
					),
				localizationCheck: (document, options) =>
					Effect.flatMap(query.readCorpusReportHeader(), (header) =>
						indexedLocalizationCheckReport(...checkInput(header), options, document)
					)
			};
		}, normalizeFailure);
		/**
		 * Open only an already committed view. None means the disposable cache cannot be used.
		 * The temporary inspection reader closes before the normal model reader is opened.
		 */
		const openCommitted = Effect.fn("GameTextIndex.openCommitted")(function* (input: {
			readonly projectRoot: string;
			readonly targetName?: string;
		}): Effect.fn.Return<Option.Option<GameTextIndexModel>, never, Scope.Scope> {
			const attempt = Effect.gen(function* () {
				const request = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						projectRoot: GameTextIndexRefreshRequest.fields.projectRoot,
						targetName: GameTextTargetImportRequest.fields.targetName
					})
				)(input);
				const project = yield* openProject(request);
				const target = yield* Effect.scoped(
					Effect.gen(function* () {
						const index = yield* SharedIndex;
						const manifest = yield* index.inspect();
						const key = manifest.active.joined;
						if (!key || manifest.active["joined.invalidated"])
							return yield* Effect.fail(stale("committed_join"));
						const joined = yield* readJoinedTarget(yield* index.open());
						const meta = joined.meta;
						if (
							meta.input.projectRoot !== project.projectRoot ||
							meta.input.target.name !== (request.targetName ?? savedTarget.name)
						)
							return yield* Effect.fail(stale("committed_identity"));
						const indexed: GameTextProjectIndex = {
							...project,
							generation: manifest.generation,
							packageKey: packageKey(manifest),
							packages: {
								readPackages: 0,
								reusedPackages: 0,
								changedShards: 0,
								removedShards: 0,
								published: false,
								profile: {
									readBytes: 0,
									indexReadBytes: 0,
									appendedBytes: 0,
									lookupStrings: 0,
									reusedStrings: 0,
									probePasses: 0,
									sortMs: 0,
									probeMs: 0,
									appendMs: 0,
									segments: 0,
									timings: {
										collectMs: 0,
										reuseMs: 0,
										layerEncodeMs: 0,
										layerVerifyMs: 0,
										garbageMs: 0,
										rootPublishMs: 0
									}
								}
							}
						};
						return {
							project: indexed,
							view:
								request.targetName === undefined
									? { kind: "source" }
									: { kind: "localization", target: request.targetName },
							imported: {
								target: meta.input.target,
								files: [],
								diagnostics: [],
								profile: null
							},
							join: {
								key,
								rebuilt: false,
								bytes: 0,
								count: meta.count,
								keyChanges: null
							},
							review: {
								file:
									meta.input.review ??
									emptyLocalizationReviewFile(meta.input.target.name),
								relativePath: defaultLocalizationReviewPath(meta.input.target.name),
								contentHash: null
							},
							generation: manifest.generation,
							fileKeys: {}
						} satisfies GameTextTargetIndex;
					}).pipe(
						Effect.provide(
							sharedIndexNodeLayer(
								configurationFor(cacheRoot, project.projectRoot, request.targetName)
							)
						)
					)
				);
				return yield* openTarget(target);
			});
			const scope = yield* Scope.fork(yield* Effect.scope);
			return yield* attempt.pipe(
				Effect.provideService(Scope.Scope, scope),
				Effect.map(Option.some),
				// Disposable cache reads may throw format defects; cancellation must still propagate.
				// oxlint-disable-next-line anti-slop/no-effect-catch-all -- Every unusable cache is a miss.
				Effect.catchCause((cause) =>
					Scope.close(scope, Exit.void).pipe(
						Effect.andThen(
							Cause.hasInterrupts(cause)
								? Effect.interrupt
								: Effect.annotateCurrentSpan({
										"game_text.cache.miss_reason": Cause.pretty(cause)
									}).pipe(Effect.as(Option.none<GameTextIndexModel>()))
						)
					)
				)
			);
		});
		const invalidate = Effect.fn("GameTextIndex.invalidate")(function* (
			request: typeof GameTextIndexRefreshRequest.Type
		) {
			const projectRoot = yield* Effect.tryPromise({
				try: () => realpath(request.projectRoot),
				catch: (cause) =>
					failure(
						"project",
						"The project directory could not be resolved.",
						"Choose an accessible project directory.",
						cause
					)
			});
			yield* withSession(
				configurationFor(cacheRoot, projectRoot, request.targetName),
				Effect.gen(function* () {
					const index = yield* SharedIndex,
						writer = yield* index.writer();
					const active = writer.manifest().active;
					const removed = [...(request.changedFiles ?? [])].filter(
						(name) => active[name] !== undefined
					);
					if (active.joined)
						yield* writer.publish("joined.invalidated", `invalidate:${randomUUID()}`, {
							columns: [
								{
									name: "invalidate",
									kind: "bytes",
									load: async () => Uint8Array.of(1)
								}
							]
						});
					if (removed.length) yield* writer.publishBatch([], removed);
				})
			);
		});
		// Index work runs on the host's event loop; slicing keeps a server host answering meanwhile.
		const sliced =
			<Args extends ReadonlyArray<unknown>, A, E, R>(
				step: (...args: Args) => Effect.Effect<A, E, R>
			) =>
			(...args: Args) =>
				withHostSlices(step(...args));
		return {
			openProject: sliced(openProject),
			refreshProject: sliced(refreshProject),
			importTarget: sliced(importTarget),
			buildTarget: sliced(buildTarget),
			prepareTarget: sliced(prepareTarget),
			openTarget: sliced(openTarget),
			openCommitted: sliced(openCommitted),
			invalidate: sliced(invalidate)
		};
	});

/**
 * Headless project, target-import, build and open workflow. Steps reject stale input
 * generations and own scoped writers/readers; hosts compose them without copying Workbench
 * orchestration.
 */
export class GameTextIndexSteps extends Context.Service<
	GameTextIndexSteps,
	Effect.Success<ReturnType<typeof makeGameTextIndexSteps>>
>()("@ue-shed/game-text/GameTextIndexSteps") {}

/**
 * Layer for the headless step service. Provide a builder, project-index source and localization
 * evidence.
 */
export const gameTextIndexStepsLayer = (
	cacheRoot: string,
	options: GameTextIndexStepsOptions = {}
) => Layer.effect(GameTextIndexSteps, makeGameTextIndexSteps(cacheRoot, options));
