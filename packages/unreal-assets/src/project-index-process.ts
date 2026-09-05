import type { UAssetIoOperation, UAssetIoProjectIndexQuery } from "@ue-shed/protocol";
import { Effect, Layer, Metric, Scope, Semaphore, Stream } from "effect";
import type { AssetReaderConfiguration, AssetReaderProtocolObservation } from "./asset-reader.js";
import { DEFAULT_CATALOG_TIMEOUT_MS, MAX_PROTOCOL_OUTPUT_BYTES } from "./asset-reader.js";
import {
	type ProjectIndexCacheRoot,
	type ProjectIndexError,
	type ProjectIndexPage,
	type ProjectIndexQuery,
	type ProjectIndexApi,
	type ProjectIndexStatus,
	type ProjectIndexSummary,
	type ProjectIndexTarget,
	ProjectIndex,
	ProjectIndexCacheRoot as CacheRootSchema,
	ProjectIndexConfig,
	ProjectIndexCorruptCatalog,
	ProjectIndexIncompatibleWorker,
	ProjectIndexInvalidRequest,
	ProjectIndexRefreshEvent,
	ProjectIndexRefreshFailed,
	ProjectIndexStaleGeneration,
	ProjectIndexUnavailable,
	decodeProjectIndexPage,
	projectIndexConfigLayer
} from "./project-index.js";
import {
	decodeProjectIndexWirePage,
	decodeProjectIndexDictionaryPage,
	decodeProjectIndexWireSummary,
	mapProjectIndexProgress,
	mapProjectIndexProtocolFailure
} from "./project-index-protocol.js";
import {
	ProtocolStreamFailure,
	UassetProtocolSession,
	makeProtocolRequest,
	runUassetProtocolEvents
} from "./protocol-transport.js";

export const projectIndexRefreshDuration = Metric.histogram(
	"ue_shed_project_index_refresh_duration_ms",
	{
		boundaries: [10, 50, 100, 250, 1_000, 5_000, 15_000, 60_000, 300_000],
		description: "Wall time for a Project Index refresh or rebuild worker"
	}
);
export const projectIndexQueryDuration = Metric.histogram(
	"ue_shed_project_index_query_duration_ms",
	{
		boundaries: [1, 5, 10, 25, 50, 100, 250, 1_000, 5_000],
		description: "Wall time for a bounded Project Index query"
	}
);
export const projectIndexChangedPackages = Metric.counter(
	"ue_shed_project_index_changed_packages_total",
	{
		description: "Packages whose header evidence was rebuilt during refresh",
		incremental: true
	}
);
export const projectIndexRemovedPackages = Metric.counter(
	"ue_shed_project_index_removed_packages_total",
	{
		description: "Packages removed when a refresh committed",
		incremental: true
	}
);
export const projectIndexGeneration = Metric.gauge("ue_shed_project_index_generation", {
	description: "Latest committed Project Index generation observed by this process"
});
export const projectIndexCacheBytes = Metric.gauge("ue_shed_project_index_cache_bytes", {
	description: "Catalog storage bytes reported after a successful refresh"
});
export const projectIndexEvidenceWrites = Metric.counter(
	"ue_shed_project_index_evidence_writes_total",
	{
		description: "Committed Catalog evidence-row writes reported after refresh",
		incremental: true
	}
);
export const projectIndexQuarantines = Metric.counter("ue_shed_project_index_quarantine_total", {
	description: "Corrupt or incompatible Catalog quarantines observed before refresh",
	incremental: true
});
export const projectIndexTerminalState = Metric.frequency("ue_shed_project_index_terminal_total", {
	description: "Project Index protocol terminal states"
});

export const projectIndexMetrics = {
	cacheBytes: projectIndexCacheBytes,
	changedPackages: projectIndexChangedPackages,
	evidenceWrites: projectIndexEvidenceWrites,
	generation: projectIndexGeneration,
	queryDuration: projectIndexQueryDuration,
	quarantines: projectIndexQuarantines,
	refreshDuration: projectIndexRefreshDuration,
	removedPackages: projectIndexRemovedPackages,
	terminalState: projectIndexTerminalState
};

export interface ProjectIndexProcessConfiguration {
	readonly executable: string;
	/** Path-free native diagnostics used by benchmark and host attribution hooks. */
	readonly projectIndexDiagnosticObserver?: (event: {
		readonly code: string;
		readonly message: string;
	}) => void;
	readonly protocolObserver?: (event: AssetReaderProtocolObservation) => void;
	readonly timeoutMs: number;
}

const toWireQuery = (request: ProjectIndexQuery): UAssetIoProjectIndexQuery => {
	const base = {
		expectedGeneration: request.expectedGeneration,
		limit: request.limit,
		projectId: request.projectId,
		...(request.cursor === undefined ? undefined : { cursor: request.cursor })
	};
	switch (request._tag) {
		case "Maps":
			return { kind: "maps", ...base };
		case "ExactClasses":
			return { kind: "exact_classes", ...base, values: [...request.values] };
		case "ClassPrefixes":
			return { kind: "class_prefixes", ...base, values: [...request.values] };
		case "ClassNameSuffixes":
			return { kind: "class_name_suffixes", ...base, values: [...request.values] };
		case "SerializedNames":
			return { kind: "serialized_names", ...base, values: [...request.values] };
	}
};

const makeRequest = (
	operation: UAssetIoOperation,
	timeoutMs: number
): ReturnType<typeof makeProtocolRequest> =>
	makeProtocolRequest(
		operation,
		{
			maximumOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
			timeoutMs
		},
		{ contractMinor: operation.kind === "project_index_query" ? 3 : 1 }
	);

const mapStreamFailure = (cause: unknown, sawAccepted: boolean): ProjectIndexError => {
	if (cause instanceof ProtocolStreamFailure) {
		return mapProjectIndexProtocolFailure({
			sawAccepted,
			stderr: cause.stderr ?? cause.message,
			...(cause.exitCode === undefined ? undefined : { exitCode: cause.exitCode })
		});
	}
	if (
		cause instanceof ProjectIndexUnavailable ||
		cause instanceof ProjectIndexInvalidRequest ||
		cause instanceof ProjectIndexStaleGeneration ||
		cause instanceof ProjectIndexIncompatibleWorker ||
		cause instanceof ProjectIndexCorruptCatalog ||
		cause instanceof ProjectIndexRefreshFailed
	) {
		return cause;
	}
	return new ProjectIndexRefreshFailed({
		message: cause instanceof Error ? cause.message : String(cause),
		recovery: "Retry the Project Index operation, or rebuild the Catalog if it persists.",
		retrySafe: true
	});
};

const parseMetricsDiagnostic = (
	message: string
): {
	readonly committedRows: number;
	readonly durationMs: number;
	readonly storageBytes: number;
} | null => {
	const match = /committed_rows=(\d+).*storage_bytes=(\d+).*duration_ms=(\d+)/.exec(message);
	if (match === null) return null;
	return {
		committedRows: Number(match[1]),
		storageBytes: Number(match[2]),
		durationMs: Number(match[3])
	};
};

const recordRefreshMetrics = (
	summary: ProjectIndexSummary,
	extras: {
		readonly committedRows?: number;
		readonly durationMs?: number;
		readonly quarantined: boolean;
		readonly storageBytes?: number;
		readonly terminal: string;
	}
): Effect.Effect<void> =>
	Effect.all([
		Metric.update(projectIndexChangedPackages, summary.changedPackages),
		Metric.update(projectIndexRemovedPackages, summary.removedPackages),
		Metric.update(projectIndexGeneration, summary.generation),
		Metric.update(projectIndexTerminalState, extras.terminal),
		...(extras.durationMs === undefined
			? []
			: [Metric.update(projectIndexRefreshDuration, extras.durationMs)]),
		...(extras.storageBytes === undefined
			? []
			: [Metric.update(projectIndexCacheBytes, extras.storageBytes)]),
		...(extras.committedRows === undefined
			? []
			: [Metric.update(projectIndexEvidenceWrites, extras.committedRows)]),
		...(extras.quarantined ? [Metric.update(projectIndexQuarantines, 1)] : [])
	]).pipe(Effect.asVoid);

async function* refreshEventStream(
	configuration: ProjectIndexProcessConfiguration,
	cacheRoot: ProjectIndexCacheRoot,
	target: ProjectIndexTarget,
	operation: "refresh" | "rebuild",
	signal: AbortSignal | undefined
): AsyncGenerator<typeof ProjectIndexRefreshEvent.Type, void, void> {
	yield ProjectIndexRefreshEvent.cases.Started.make({ operation });
	const request = makeRequest(
		{
			cacheRoot,
			kind: operation === "rebuild" ? "project_index_rebuild" : "project_index_refresh",
			projectRoot: target.projectRoot
		},
		configuration.timeoutMs
	);
	let sawAccepted = false;
	let quarantined = false;
	let metrics: ReturnType<typeof parseMetricsDiagnostic> = null;
	let summary: ProjectIndexSummary | undefined;
	try {
		for await (const event of runUassetProtocolEvents({
			configuration,
			request,
			signal,
			timeoutMs: configuration.timeoutMs
		})) {
			if (event.kind === "accepted") {
				sawAccepted = true;
				continue;
			}
			if (event.kind === "progress") {
				const progress = mapProjectIndexProgress(event);
				if (progress !== undefined) yield progress;
				continue;
			}
			if (event.kind === "diagnostic") {
				if (event.code === "catalog_quarantined") quarantined = true;
				if (
					event.code === "catalog_quarantined" ||
					event.code === "project_index_metrics"
				) {
					try {
						configuration.projectIndexDiagnosticObserver?.({
							code: event.code,
							message: event.message
						});
					} catch {
						// Optional measurement hooks must never change Project Index behavior.
					}
				}
				if (event.code === "project_index_metrics") {
					metrics = parseMetricsDiagnostic(event.message);
				}
				continue;
			}
			if (event.kind === "result" && event.result.kind === "project_index_summary") {
				summary = decodeProjectIndexWireSummary(event.result.summary);
				yield ProjectIndexRefreshEvent.cases.Completed.make({ summary });
				continue;
			}
			if (event.kind === "failed" || event.kind === "rejected") {
				throw mapProjectIndexProtocolFailure({ event, sawAccepted });
			}
			if (event.kind === "result") {
				throw new ProjectIndexUnavailable({
					message: `Unexpected Project Index result kind ${event.result.kind}.`,
					recovery: "Upgrade to a paired uasset-io worker, then retry.",
					retrySafe: false
				});
			}
		}
	} catch (cause) {
		throw mapStreamFailure(cause, sawAccepted);
	}
	if (summary === undefined) {
		throw new ProjectIndexRefreshFailed({
			message: "Project Index refresh completed without a summary.",
			recovery: "Retry the refresh, or rebuild the Catalog if it persists.",
			retrySafe: true
		});
	}
	await Effect.runPromise(
		recordRefreshMetrics(summary, {
			quarantined,
			terminal: "complete",
			...(metrics === null
				? undefined
				: {
						committedRows: metrics.committedRows,
						durationMs: metrics.durationMs,
						storageBytes: metrics.storageBytes
					})
		})
	);
}

async function collectStatus(
	configuration: ProjectIndexProcessConfiguration,
	cacheRoot: ProjectIndexCacheRoot,
	target: ProjectIndexTarget,
	signal: AbortSignal | undefined
): Promise<ProjectIndexStatus> {
	const request = makeRequest(
		{
			cacheRoot,
			kind: "project_index_status",
			projectRoot: target.projectRoot
		},
		configuration.timeoutMs
	);
	let sawAccepted = false;
	let status: ProjectIndexStatus | undefined;
	try {
		for await (const event of runUassetProtocolEvents({
			configuration,
			request,
			signal,
			timeoutMs: configuration.timeoutMs
		})) {
			if (event.kind === "accepted") {
				sawAccepted = true;
				continue;
			}
			if (event.kind === "result" && event.result.kind === "project_index_status") {
				status =
					event.result.status.status === "absent"
						? { status: "absent" }
						: {
								status: "ready",
								summary: decodeProjectIndexWireSummary(event.result.status.summary)
							};
				continue;
			}
			if (event.kind === "failed" || event.kind === "rejected") {
				throw mapProjectIndexProtocolFailure({ event, sawAccepted });
			}
		}
	} catch (cause) {
		throw mapStreamFailure(cause, sawAccepted);
	}
	if (status === undefined) {
		throw new ProjectIndexUnavailable({
			message: "Project Index status completed without a status frame.",
			recovery: "Retry status, or refresh the Catalog first.",
			retrySafe: true
		});
	}
	return status;
}

async function collectQuery(
	configuration: ProjectIndexProcessConfiguration,
	session: UassetProtocolSession,
	cacheRoot: ProjectIndexCacheRoot,
	request: ProjectIndexQuery,
	signal: AbortSignal | undefined
): Promise<ProjectIndexPage> {
	const started = Date.now();
	const protocolRequest = makeRequest(
		{
			cacheRoot,
			kind: "project_index_query",
			pageEncoding: "dictionary",
			query: toWireQuery(request)
		},
		configuration.timeoutMs
	);
	let sawAccepted = false;
	let page: ProjectIndexPage | undefined;
	try {
		for await (const event of session.events({
			request: protocolRequest,
			signal,
			telemetryOperation: "project_index",
			timeoutMs: configuration.timeoutMs
		})) {
			if (event.kind === "accepted") {
				sawAccepted = true;
				continue;
			}
			if (event.kind === "result" && event.result.kind === "project_index_page") {
				page = decodeProjectIndexWirePage(event.result.page);
				continue;
			}
			if (event.kind === "result" && event.result.kind === "project_index_dictionary_page") {
				page = decodeProjectIndexDictionaryPage(event.result.page);
				continue;
			}
			if (event.kind === "failed" || event.kind === "rejected") {
				throw mapProjectIndexProtocolFailure({ event, sawAccepted });
			}
		}
	} catch (cause) {
		throw mapStreamFailure(cause, sawAccepted);
	}
	if (page === undefined) {
		throw new ProjectIndexUnavailable({
			message: "Project Index query completed without a page frame.",
			recovery: "Retry the query against the current generation.",
			retrySafe: true
		});
	}
	await Effect.runPromise(
		Effect.all([
			Metric.update(projectIndexQueryDuration, Math.max(0, Date.now() - started)),
			Metric.update(projectIndexGeneration, page.generation),
			Metric.update(projectIndexTerminalState, "complete")
		]).pipe(Effect.asVoid)
	);
	return page;
}

function refreshStream(
	configuration: ProjectIndexProcessConfiguration,
	cacheRoot: ProjectIndexCacheRoot,
	target: ProjectIndexTarget,
	operation: "refresh" | "rebuild"
): Stream.Stream<typeof ProjectIndexRefreshEvent.Type, ProjectIndexError> {
	const controller = new AbortController();
	const events = refreshEventStream(
		configuration,
		cacheRoot,
		target,
		operation,
		controller.signal
	);
	return Stream.fromAsyncIterable(events, (cause) => mapStreamFailure(cause, true)).pipe(
		Stream.ensuring(Effect.sync(() => controller.abort())),
		Stream.withSpan(
			operation === "rebuild"
				? "unreal_assets.project_index_rebuild"
				: "unreal_assets.project_index_refresh"
		)
	);
}

function makeProcessService(
	configuration: ProjectIndexProcessConfiguration,
	cacheRoot: ProjectIndexCacheRoot
): Effect.Effect<ProjectIndexApi, never, Scope.Scope> {
	return Effect.gen(function* () {
		const mutex = yield* Semaphore.make(1);
		const session = yield* Effect.acquireRelease(
			Effect.sync(() => new UassetProtocolSession(configuration)),
			(session) => Effect.promise(() => session.close())
		);
		const refresh = (target: ProjectIndexTarget) =>
			refreshStream(configuration, cacheRoot, target, "refresh");
		const rebuild = (target: ProjectIndexTarget) =>
			refreshStream(configuration, cacheRoot, target, "rebuild");

		const query = Effect.fn("ProjectIndexProcess.query")(function* (
			request: ProjectIndexQuery
		) {
			const page = yield* mutex.withPermits(1)(
				Effect.tryPromise({
					try: (signal) =>
						collectQuery(configuration, session, cacheRoot, request, signal),
					catch: (cause) => mapStreamFailure(cause, true)
				}).pipe(Effect.withSpan("unreal_assets.project_index_query"))
			);
			return yield* decodeProjectIndexPage(page);
		});

		const status = Effect.fn("ProjectIndexProcess.status")(function* (
			target: ProjectIndexTarget
		) {
			return yield* Effect.tryPromise({
				try: (signal) => collectStatus(configuration, cacheRoot, target, signal),
				catch: (cause) => mapStreamFailure(cause, true)
			}).pipe(Effect.withSpan("unreal_assets.project_index_status"));
		});

		return { query, rebuild, refresh, status };
	});
}

/**
 * Production Project Index adapter. TypeScript supplies only the cache root and worker policy;
 * the native worker owns Catalog files and never exposes SQL.
 */
export function projectIndexProcessLayer(
	configuration: ProjectIndexProcessConfiguration & { readonly cacheRoot: string }
): Layer.Layer<ProjectIndex> {
	const cacheRoot = CacheRootSchema.make(configuration.cacheRoot);
	return Layer.effect(
		ProjectIndex,
		makeProcessService(configuration, cacheRoot).pipe(Effect.map(ProjectIndex.of))
	);
}

/** Same adapter, reading the disposable cache root from `ProjectIndexConfig`. */
export function projectIndexProcessLayerFromConfig(
	configuration: ProjectIndexProcessConfiguration
): Layer.Layer<ProjectIndex, never, ProjectIndexConfig> {
	return Layer.effect(
		ProjectIndex,
		Effect.gen(function* () {
			const { cacheRoot } = yield* ProjectIndexConfig;
			return ProjectIndex.of(yield* makeProcessService(configuration, cacheRoot));
		})
	);
}

export function projectIndexProcessLayerWithConfig(
	configuration: ProjectIndexProcessConfiguration & { readonly cacheRoot: string }
): Layer.Layer<ProjectIndex | ProjectIndexConfig> {
	const cacheRoot = CacheRootSchema.make(configuration.cacheRoot);
	return Layer.merge(
		projectIndexProcessLayer(configuration),
		projectIndexConfigLayer({ cacheRoot })
	);
}

/** Build from the same worker settings AssetReader uses, still requiring an explicit cache root. */
export function projectIndexProcessLayerFromReader(
	configuration: Pick<
		AssetReaderConfiguration,
		"executable" | "protocolObserver" | "catalogTimeoutMs"
	> & { readonly cacheRoot: string }
): Layer.Layer<ProjectIndex | ProjectIndexConfig> {
	return projectIndexProcessLayerWithConfig({
		cacheRoot: configuration.cacheRoot,
		executable: configuration.executable,
		timeoutMs: configuration.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
		...(configuration.protocolObserver === undefined
			? undefined
			: { protocolObserver: configuration.protocolObserver })
	});
}
