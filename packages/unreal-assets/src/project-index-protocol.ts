import {
	type UAssetIoEvent,
	type UAssetIoProjectIndexDictionaryPage,
	type UAssetIoProjectIndexPage,
	type UAssetIoProjectIndexSummary
} from "@ue-shed/protocol";
import {
	ProjectIdentity,
	ProjectIndexCorruptCatalog,
	ProjectIndexCursor,
	type ProjectIndexError,
	ProjectIndexGeneration,
	ProjectIndexHeader,
	ProjectIndexInventory,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIndexIncompatibleWorker,
	ProjectIndexInvalidRequest,
	ProjectIndexMap,
	ProjectIndexPackage,
	ProjectIndexPage,
	ProjectIndexRefreshEvent,
	ProjectIndexRefreshFailed,
	ProjectIndexStaleGeneration,
	type ProjectIndexSummary,
	ProjectIndexUnavailable
} from "./project-index.js";
import { ProtocolStreamFailure } from "./protocol-transport.js";
import { retainValidatedPage } from "./project-index-page-validation.js";

type ProtocolFailed = Extract<UAssetIoEvent, { readonly kind: "failed" }>;
type ProtocolRejected = Extract<UAssetIoEvent, { readonly kind: "rejected" }>;
type ProtocolProgress = Extract<UAssetIoEvent, { readonly kind: "progress" }>;
type RefreshPhase = "enumerating" | "comparing" | "reading_headers" | "committing";

const isRefreshPhase = (phase: ProtocolProgress["phase"]): phase is RefreshPhase =>
	phase === "enumerating" ||
	phase === "comparing" ||
	phase === "reading_headers" ||
	phase === "committing";

/**
 * Projects recognized native refresh phases into domain progress events. Returns undefined
 * for unrelated protocol phases rather than inventing catalog progress.
 */
export function mapProjectIndexProgress(
	event: ProtocolProgress
): ProjectIndexRefreshEvent | undefined {
	if (!isRefreshPhase(event.phase)) return undefined;
	return ProjectIndexRefreshEvent.cases.Progress.make({
		completedPackages: event.completedItems,
		phase: event.phase,
		...(event.totalItems === undefined ? undefined : { totalPackages: event.totalItems })
	});
}

/**
 * Converts an already wire-validated summary to branded catalog identity/generation.
 * Synchronous schema construction can throw on invalid input; use the protocol boundary for
 * untrusted bytes.
 */
export function decodeProjectIndexWireSummary(
	summary: UAssetIoProjectIndexSummary
): ProjectIndexSummary {
	const changes = summary.changes;
	return {
		changedPackages: summary.changedPackages,
		completeness: summary.completeness,
		diagnostics: summary.diagnostics,
		...(summary.omittedDiagnostics === undefined
			? undefined
			: { omittedDiagnostics: summary.omittedDiagnostics }),
		generation: ProjectIndexGeneration.make(summary.generation),
		mapCount: summary.mapCount,
		packageCount: summary.packageCount,
		projectId: ProjectIdentity.make(summary.projectId),
		removedPackages: summary.removedPackages,
		...(summary.mounts === undefined ? undefined : { mounts: summary.mounts }),
		...(summary.inventoryDigest === undefined
			? undefined
			: { inventoryDigest: summary.inventoryDigest }),
		...(changes === undefined
			? undefined
			: {
					changes: {
						changed: changes.changed,
						removed: changes.removed,
						complete: changes.complete,
						...(changes.total === undefined ? undefined : { total: changes.total }),
						...(changes.baseGeneration === undefined
							? undefined
							: {
									baseGeneration: ProjectIndexGeneration.make(
										changes.baseGeneration
									)
								})
					}
				})
	};
}

/**
 * Converts an already validated native page into its domain map/header/inventory
 * representation. This synchronous adapter is not a JSON parser or a substitute for protocol
 * validation.
 */
export function decodeProjectIndexWirePage(page: UAssetIoProjectIndexPage): ProjectIndexPage {
	const items = page.items.map(
		(
			item
		): ProjectIndexMap | ProjectIndexHeader | ProjectIndexInventory | ProjectIndexPackage => {
			if (item.kind === "inventory" || item.kind === "package") return item;
			if (item.kind === "map")
				return { kind: "map", mapPath: item.mapPath, packageName: item.packageName };
			// A field a v1.27 query left out is absent on the wire and empty here.
			const header: ProjectIndexHeader = {
				classes: item.classes === undefined ? [] : [...item.classes],
				kind: "header",
				packageName: item.packageName,
				packagePath: item.packagePath,
				serializedNames: item.serializedNames === undefined ? [] : [...item.serializedNames]
			};
			if (item.headerData !== undefined)
				Object.assign(header, { headerData: item.headerData });
			return header;
		}
	);
	return {
		generation: ProjectIndexGeneration.make(page.generation),
		items,
		projectId: ProjectIdentity.make(page.projectId),
		...(page.nextCursor === undefined
			? undefined
			: { nextCursor: ProjectIndexCursor.make(page.nextCursor) })
	};
}

// Domain bounds the wire contract leaves open (it only requires these strings to be non-empty).
const MAX_PATH_LENGTH = 32_767;
const MAX_STRING_LENGTH = 1_024;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_SIGNATURE_LENGTH = 8_192;
const MAX_FAILURE_LENGTH = 256;
const MAX_REFERENCES = 64;
const MAX_PAGE_STRINGS = PROJECT_INDEX_MAX_PAGE_SIZE * 128;

class InvalidDictionaryPage extends Error {}

const boundedString = (value: string, maximum: number): string => {
	if (value.length === 0 || value.length > maximum) throw new InvalidDictionaryPage();
	return value;
};

/**
 * Validates and expands one protocol-validated dictionary page in one pass, without a second
 * schema walk: the domain bounds the wire leaves open, list lengths, and integer references
 * inside `strings`. `headerData` is the wire's own `PackageHeaderData`.
 */
function expandDictionaryPage(input: UAssetIoProjectIndexDictionaryPage): ProjectIndexPage {
	const { generation, items, nextCursor, projectId, strings } = input;
	if (!Number.isSafeInteger(generation) || generation < 1) throw new InvalidDictionaryPage();
	boundedString(projectId, MAX_PATH_LENGTH);
	if (nextCursor !== undefined) boundedString(nextCursor, MAX_CURSOR_LENGTH);
	if (items.length > PROJECT_INDEX_MAX_PAGE_SIZE || strings.length > MAX_PAGE_STRINGS)
		throw new InvalidDictionaryPage();
	for (const value of strings) boundedString(value, MAX_STRING_LENGTH);
	// A bound failure anywhere wins over a reference failure, as when bounds were checked first.
	let outOfBounds = false;
	const resolve = (index: number): string => {
		// One lookup checks integrality, sign and range together.
		const value = Number.isInteger(index) ? strings[index] : undefined;
		if (value === undefined) {
			outOfBounds = true;
			return "";
		}
		return value;
	};
	const references = (ids: readonly number[] | undefined): string[] => {
		if (ids === undefined) return [];
		if (ids.length > MAX_REFERENCES) throw new InvalidDictionaryPage();
		return ids.map(resolve);
	};
	const expanded = items.map(
		(
			item
		): ProjectIndexMap | ProjectIndexHeader | ProjectIndexInventory | ProjectIndexPackage => {
			switch (item.kind) {
				case "map":
					return {
						kind: "map",
						mapPath: boundedString(item.mapPath, MAX_PATH_LENGTH),
						packageName: boundedString(item.packageName, MAX_PATH_LENGTH)
					};
				case "inventory": {
					const packagePath = boundedString(item.packagePath, MAX_PATH_LENGTH);
					const signature = boundedString(item.signature, MAX_SIGNATURE_LENGTH);
					return item.headerData === undefined
						? { kind: "inventory", packagePath, signature }
						: {
								kind: "inventory",
								packagePath,
								signature,
								headerData: item.headerData
							};
				}
				case "header": {
					// A field a v1.27 query left out is absent on the wire and empty here.
					const classes = references(item.classes);
					const packageName = boundedString(item.packageName, MAX_PATH_LENGTH);
					const packagePath = boundedString(item.packagePath, MAX_PATH_LENGTH);
					const serializedNames = references(item.serializedNames);
					return item.headerData === undefined
						? { classes, kind: "header", packageName, packagePath, serializedNames }
						: {
								classes,
								kind: "header",
								packageName,
								packagePath,
								serializedNames,
								headerData: item.headerData
							};
				}
				case "package": {
					const entry: ProjectIndexPackage = {
						classes: references(item.classes),
						dependencies: item.dependencies.map((dependency) => {
							return {
								package: resolve(dependency.package),
								...(dependency.packagePath === undefined
									? undefined
									: { packagePath: resolve(dependency.packagePath) }),
								hard: dependency.hard,
								game: dependency.game,
								build: dependency.build
							};
						}),
						kind: "package",
						packageName: boundedString(item.packageName, MAX_PATH_LENGTH),
						packagePath: boundedString(item.packagePath, MAX_PATH_LENGTH)
					};
					if (item.failure === undefined) return entry;
					const failure = boundedString(item.failure, MAX_FAILURE_LENGTH);
					return Object.assign(entry, { failure });
				}
				default:
					throw new InvalidDictionaryPage();
			}
		}
	);
	if (outOfBounds)
		throw new ProtocolStreamFailure(
			"contract",
			"Project Index dictionary reference is out of bounds"
		);
	return retainValidatedPage({
		generation: ProjectIndexGeneration.make(generation),
		items: expanded,
		projectId: ProjectIdentity.make(projectId),
		...(nextCursor === undefined
			? undefined
			: { nextCursor: ProjectIndexCursor.make(nextCursor) })
	});
}

export function decodeProjectIndexDictionaryPage(
	input: UAssetIoProjectIndexDictionaryPage
): ProjectIndexPage {
	try {
		return expandDictionaryPage(input);
	} catch (cause) {
		if (cause instanceof ProtocolStreamFailure) throw cause;
		throw new ProjectIndexUnavailable({
			message: "The Project Index adapter returned an unbounded or invalid page.",
			recovery: "Rebuild the Catalog, then retry with a bounded query.",
			retrySafe: true,
			nextStep: "retry"
		});
	}
}

/**
 * Maps protocol terminal failures for Project Index operations onto typed domain errors.
 * An old worker that exits before `accepted` becomes `ProjectIndexIncompatibleWorker`.
 */
export function mapProjectIndexProtocolFailure(input: {
	readonly event?: ProtocolFailed | ProtocolRejected;
	readonly exitCode?: number;
	readonly sawAccepted: boolean;
	readonly stderr?: string;
}): ProjectIndexError {
	if (!input.sawAccepted) {
		return new ProjectIndexIncompatibleWorker({
			message:
				input.stderr?.trim() ||
				"The uasset worker rejected the Project Index request before accepting it.",
			recovery:
				"Upgrade to a paired uasset-io worker that supports the requested Project Index operation and encoding, then retry.",
			retrySafe: false,
			nextStep: "fix_input"
		});
	}
	if (input.event?.kind === "rejected") {
		const message = input.event.problems.join("; ");
		if (/unsupported|unknown operation|project_index_/i.test(message)) {
			return new ProjectIndexIncompatibleWorker({
				message,
				recovery:
					"Upgrade to a paired uasset-io worker that supports the requested Project Index operation and encoding, then retry.",
				retrySafe: false,
				nextStep: "fix_input"
			});
		}
		return new ProjectIndexInvalidRequest({
			message,
			recovery: "Correct the Project Index request and retry.",
			retrySafe: false,
			nextStep: "fix_input"
		});
	}
	if (input.event?.kind === "failed") {
		switch (input.event.code) {
			case "stale_generation":
				return new ProjectIndexStaleGeneration({
					actualGeneration: ProjectIndexGeneration.make(
						input.event.actualGeneration ?? 1
					),
					expectedGeneration: ProjectIndexGeneration.make(
						input.event.expectedGeneration ?? 1
					),
					message: input.event.message,
					recovery: "Read status for the current generation, then retry the query.",
					retrySafe: true,
					nextStep: "reconcile"
				});
			case "corrupt_catalog":
				return new ProjectIndexCorruptCatalog({
					message: input.event.message,
					recovery: "Rebuild the Catalog, then retry.",
					retrySafe: true,
					nextStep: "reconcile"
				});
			case "invalid_request":
				return new ProjectIndexInvalidRequest({
					message: input.event.message,
					recovery: "Correct the Project Index request and retry.",
					retrySafe: false,
					nextStep: "fix_input"
				});
			case "unavailable":
				return new ProjectIndexUnavailable({
					message: input.event.message,
					recovery: "Retry after the Catalog coordinator is available, or rebuild.",
					retrySafe: true,
					nextStep: "retry"
				});
			case "cancelled":
				return new ProjectIndexRefreshFailed({
					message: input.event.message,
					recovery: "Retry the refresh when ready.",
					retrySafe: true,
					nextStep: "retry"
				});
			default:
				return new ProjectIndexRefreshFailed({
					message: input.event.message,
					recovery: "Retry the operation. If it keeps failing, rebuild the Catalog.",
					retrySafe: input.event.retrySafe,
					nextStep: input.event.retrySafe ? "retry" : "escalate"
				});
		}
	}
	return new ProjectIndexRefreshFailed({
		message:
			input.stderr?.trim() ||
			`Project Index worker exited ${input.exitCode ?? "unexpectedly"}`,
		recovery: "Retry the operation. If it keeps failing, rebuild the Catalog.",
		retrySafe: true,
		nextStep: "retry"
	});
}
