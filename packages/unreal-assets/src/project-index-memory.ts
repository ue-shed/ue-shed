import { Effect, Layer, Ref, Stream } from "effect";
import {
	countProjectIndexPages,
	type ProjectIdentity,
	type ProjectIndexCacheRoot,
	type ProjectIndexCursor,
	type ProjectIndexGeneration,
	type ProjectIndexHeader,
	type ProjectIndexInventory,
	type ProjectIndexItem,
	type ProjectIndexMap,
	type ProjectIndexPackage,
	type ProjectIndexPage,
	type ProjectIndexQuery,
	type ProjectIndexApi,
	type ProjectIndexStatus,
	type ProjectIndexSummary,
	type ProjectIndexTarget,
	ProjectIndex,
	ProjectIndexCacheRoot as CacheRootSchema,
	type ProjectIndexConfig,
	ProjectIndexCursor as CursorSchema,
	ProjectIndexGeneration as GenerationSchema,
	ProjectIdentity as IdentitySchema,
	ProjectIndexInvalidRequest,
	ProjectIndexRefreshEvent,
	ProjectIndexStaleGeneration,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	decodeProjectIndexQuery,
	projectIndexConfigLayer
} from "./project-index.js";

/**
 * Explicit maps, headers and inventory used to seed an in-memory catalog for a project
 * identity. Omitted collections start empty rather than reading project files.
 */
export interface ProjectIndexMemorySeed {
	readonly inventory?: readonly ProjectIndexInventory[];
	readonly headers?: readonly ProjectIndexHeader[];
	readonly maps?: readonly ProjectIndexMap[];
	/** Packages with resolved dependencies, answering dependency and dependents queries. */
	readonly packages?: readonly ProjectIndexPackage[];
	readonly projectId: ProjectIdentity;
}

/**
 * In-memory catalog configuration and optional evidence seed. The cacheRoot identifies
 * configuration only; this adapter does not persist a native catalog.
 */
export interface ProjectIndexMemoryOptions {
	readonly cacheRoot: string;
	readonly seed?: ProjectIndexMemorySeed;
}

interface CommittedCatalog {
	readonly inventory: readonly ProjectIndexInventory[];
	readonly headers: readonly ProjectIndexHeader[];
	readonly maps: readonly ProjectIndexMap[];
	readonly packages: readonly ProjectIndexPackage[];
	readonly summary: ProjectIndexSummary;
}

interface MemoryState {
	readonly byProjectRoot: ReadonlyMap<string, CommittedCatalog>;
	readonly cacheRoot: ProjectIndexCacheRoot;
	readonly seed: ProjectIndexMemorySeed | undefined;
}

const comparePath = (left: string, right: string): number => left.localeCompare(right);

const sortMaps = (maps: readonly ProjectIndexMap[]): readonly ProjectIndexMap[] =>
	[...maps].sort((left, right) => comparePath(left.mapPath, right.mapPath));

const sortHeaders = (headers: readonly ProjectIndexHeader[]): readonly ProjectIndexHeader[] =>
	[...headers].sort((left, right) => comparePath(left.packagePath, right.packagePath));

const className = (classPath: string): string => {
	const separator = classPath.lastIndexOf(".");
	return separator === -1 ? classPath : classPath.slice(separator + 1);
};

const matchesHeader = (request: ProjectIndexQuery, header: ProjectIndexHeader): boolean => {
	switch (request._tag) {
		case "Inventory":
			return false;
		case "Maps":
			return false;
		case "ExactClasses":
			return request.values.some((value) => header.classes.includes(value));
		case "ClassPrefixes":
			return request.values.some((prefix) =>
				header.classes.some((entry) => entry.startsWith(prefix))
			);
		case "ClassNameSuffixes":
			return request.values.some((suffix) =>
				header.classes.some((entry) => className(entry).endsWith(suffix))
			);
		case "SerializedNames":
			return request.values.some((value) => header.serializedNames.includes(value));
		case "Dependencies":
		case "Dependents":
			return false;
	}
};

const lower = (value: string): string => value.toLowerCase();

/**
 * Seeded dependency walks: forward through resolved `packagePath`s, backward through dependencies
 * that resolve to, or are named like, a target. Edge filters apply as in the native index.
 */
const walkPackages = (
	packages: readonly ProjectIndexPackage[],
	request: Extract<ProjectIndexQuery, { readonly _tag: "Dependencies" | "Dependents" }>
): readonly ProjectIndexPackage[] => {
	const byPath = new Map(packages.map((entry) => [lower(entry.packagePath), entry]));
	const edges = request.edges ?? {};
	const accepts = (dependency: ProjectIndexPackage["dependencies"][number]) =>
		(edges.hard === undefined || edges.hard === dependency.hard) &&
		(edges.game === undefined || edges.game === dependency.game) &&
		(edges.build === undefined || edges.build === dependency.build);
	const selected = new Map<string, ProjectIndexPackage>();
	if (request._tag === "Dependencies") {
		const pending = request.paths.flatMap((path) => byPath.get(lower(path)) ?? []);
		for (const entry of pending) selected.set(lower(entry.packagePath), entry);
		for (
			let current = request.transitive === true ? pending.pop() : undefined;
			current !== undefined;
			current = pending.pop()
		) {
			for (const dependency of current.dependencies) {
				const target =
					dependency.packagePath === undefined
						? undefined
						: byPath.get(lower(dependency.packagePath));
				if (!accepts(dependency) || target === undefined) continue;
				if (selected.has(lower(target.packagePath))) continue;
				selected.set(lower(target.packagePath), target);
				pending.push(target);
			}
		}
	} else {
		const targets = request.paths.map((path) => ({
			path: lower(path),
			name: byPath.get(lower(path))?.packageName
		}));
		for (let target = targets.pop(); target !== undefined; target = targets.pop()) {
			for (const entry of packages) {
				const depends = entry.dependencies.some(
					(dependency) =>
						accepts(dependency) &&
						((dependency.packagePath !== undefined &&
							lower(dependency.packagePath) === target.path) ||
							(target.name !== undefined &&
								lower(dependency.package) === lower(target.name)))
				);
				if (!depends || selected.has(lower(entry.packagePath))) continue;
				selected.set(lower(entry.packagePath), entry);
				if (request.transitive === true)
					targets.push({ path: lower(entry.packagePath), name: entry.packageName });
			}
		}
	}
	const classes = request._tag === "Dependents" ? request.classes : undefined;
	return [...selected.values()]
		.filter(
			(entry) =>
				classes === undefined || classes.some((value) => entry.classes.includes(value))
		)
		.sort((left, right) => comparePath(left.packagePath, right.packagePath));
};

const parseCursor = (
	cursor: ProjectIndexCursor | undefined
): Effect.Effect<number, ProjectIndexInvalidRequest> => {
	if (cursor === undefined) return Effect.succeed(0);
	if (!/^\d+$/.test(cursor)) {
		return Effect.fail(
			new ProjectIndexInvalidRequest({
				message: "Project Index cursor is not a stable page offset.",
				recovery: "Restart the query without a cursor, then page forward from the result.",
				retrySafe: false,
				nextStep: "fix_input"
			})
		);
	}
	return Effect.succeed(Number.parseInt(cursor, 10));
};

const pageItems = Effect.fn("ProjectIndex.Memory.pageItems")(function* (
	items: readonly ProjectIndexItem[],
	request: ProjectIndexQuery,
	generation: ProjectIndexGeneration,
	projectId: ProjectIdentity
): Effect.fn.Return<ProjectIndexPage, ProjectIndexInvalidRequest> {
	const offset = yield* parseCursor(request.cursor);
	const limit = Math.min(request.limit, PROJECT_INDEX_MAX_PAGE_SIZE);
	const slice = items.slice(offset, offset + limit);
	const nextOffset = offset + slice.length;
	return {
		generation,
		items: slice,
		projectId,
		...(nextOffset < items.length
			? { nextCursor: CursorSchema.make(String(nextOffset)) }
			: undefined)
	};
});

const identityFromRoot = (projectRoot: string, seed: ProjectIndexMemorySeed | undefined) =>
	seed?.projectId ?? IdentitySchema.make(projectRoot.replaceAll("\\", "/").slice(0, 256));

const buildCatalog = (
	projectRoot: string,
	generation: ProjectIndexGeneration,
	seed: ProjectIndexMemorySeed | undefined,
	previous: CommittedCatalog | undefined
): CommittedCatalog => {
	const maps = sortMaps(seed?.maps ?? previous?.maps ?? []);
	const headers = sortHeaders(seed?.headers ?? previous?.headers ?? []);
	const projectId = identityFromRoot(projectRoot, seed);
	const packageCount = maps.length + headers.length;
	return {
		headers,
		inventory: seed?.inventory ?? previous?.inventory ?? [],
		maps,
		packages: seed?.packages ?? previous?.packages ?? [],
		summary: {
			changedPackages: previous === undefined ? packageCount : 0,
			completeness: "complete",
			diagnostics: [],
			generation,
			mapCount: maps.length,
			packageCount,
			projectId,
			removedPackages: 0
		}
	};
};

const refreshStream = (
	state: Ref.Ref<MemoryState>,
	target: ProjectIndexTarget,
	operation: "refresh" | "rebuild"
): Stream.Stream<ProjectIndexRefreshEvent> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const current = yield* Ref.get(state);
			const previous =
				operation === "rebuild" ? undefined : current.byProjectRoot.get(target.projectRoot);
			const nextGeneration = GenerationSchema.make(
				operation === "rebuild" ? 1 : (previous?.summary.generation ?? 0) + 1
			);
			const catalog = buildCatalog(
				target.projectRoot,
				nextGeneration,
				current.seed,
				previous
			);
			const nextRoots = new Map(current.byProjectRoot);
			if (operation === "rebuild") {
				nextRoots.delete(target.projectRoot);
			}
			nextRoots.set(target.projectRoot, catalog);
			yield* Ref.set(state, { ...current, byProjectRoot: nextRoots });
			return Stream.fromIterable([
				ProjectIndexRefreshEvent.cases.Started.make({ operation }),
				ProjectIndexRefreshEvent.cases.Progress.make({
					completedPackages: catalog.summary.packageCount,
					phase: "committing",
					totalPackages: catalog.summary.packageCount
				}),
				ProjectIndexRefreshEvent.cases.Completed.make({ summary: catalog.summary })
			]);
		})
	);

const makeMemoryService = (state: Ref.Ref<MemoryState>): ProjectIndexApi => {
	const status = Effect.fn("ProjectIndex.Memory.status")(function* (target: ProjectIndexTarget) {
		const current = yield* Ref.get(state);
		const catalog = current.byProjectRoot.get(target.projectRoot);
		const result: ProjectIndexStatus =
			catalog === undefined
				? { status: "absent" }
				: { status: "ready", summary: catalog.summary };
		return result;
	});

	const query = Effect.fn("ProjectIndex.Memory.query")(function* (request: ProjectIndexQuery) {
		const decoded = yield* decodeProjectIndexQuery(request);
		const current = yield* Ref.get(state);
		const catalog = [...current.byProjectRoot.values()].find(
			(entry) => entry.summary.projectId === decoded.projectId
		);
		if (catalog === undefined) {
			return yield* new ProjectIndexInvalidRequest({
				message: "No committed Project Index generation matches that project identity.",
				recovery: "Refresh the Project Index for the project root, then retry the query.",
				retrySafe: true,
				nextStep: "reconcile"
			});
		}
		if (catalog.summary.generation !== decoded.expectedGeneration) {
			return yield* new ProjectIndexStaleGeneration({
				actualGeneration: catalog.summary.generation,
				expectedGeneration: decoded.expectedGeneration,
				message: "The Project Index generation changed since this query started.",
				recovery: "Read status for the current generation, then retry the query.",
				retrySafe: true,
				nextStep: "reconcile"
			});
		}
		const items: readonly ProjectIndexItem[] =
			decoded._tag === "Inventory"
				? catalog.inventory
				: decoded._tag === "Maps"
					? catalog.maps
					: decoded._tag === "Dependencies" || decoded._tag === "Dependents"
						? walkPackages(catalog.packages, decoded)
						: catalog.headers.filter((header) => matchesHeader(decoded, header));
		return yield* pageItems(
			items,
			decoded,
			catalog.summary.generation,
			catalog.summary.projectId
		);
	});

	return {
		count: (request) => countProjectIndexPages(query, request),
		rebuild: (target) => refreshStream(state, target, "rebuild"),
		refresh: (target) => refreshStream(state, target, "refresh"),
		query,
		status
	};
};

/**
 * In-memory Project Index adapter for public-interface and coordinator-free tests.
 * Callers supply an explicit cache root; this adapter never reads Electron paths or SQLite.
 */
export function projectIndexMemoryLayer(
	options: ProjectIndexMemoryOptions
): Layer.Layer<ProjectIndex> {
	const cacheRoot = CacheRootSchema.make(options.cacheRoot);
	return Layer.effect(
		ProjectIndex,
		Effect.gen(function* () {
			const state = yield* Ref.make<MemoryState>({
				byProjectRoot: new Map(),
				cacheRoot,
				seed: options.seed
			});
			return ProjectIndex.of(makeMemoryService(state));
		})
	);
}

/** Memory adapter plus the cache-root configuration service hosts must provide. */
export function projectIndexMemoryLayerWithConfig(
	options: ProjectIndexMemoryOptions
): Layer.Layer<ProjectIndex | ProjectIndexConfig> {
	const cacheRoot = CacheRootSchema.make(options.cacheRoot);
	return Layer.merge(projectIndexMemoryLayer(options), projectIndexConfigLayer({ cacheRoot }));
}
