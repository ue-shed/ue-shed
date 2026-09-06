import {
	type UAssetIoEvent,
	type UAssetIoProjectIndexDictionaryPage,
	type UAssetIoProjectIndexPage,
	type UAssetIoProjectIndexSummary
} from "@ue-shed/protocol";
import { Exit, Schema } from "effect";
import {
	ProjectIdentity,
	ProjectIndexCorruptCatalog,
	ProjectIndexCursor,
	type ProjectIndexError,
	ProjectIndexGeneration,
	ProjectIndexHeader,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIndexIncompatibleWorker,
	ProjectIndexInvalidRequest,
	ProjectIndexMap,
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

export function mapProjectIndexProgress(
	event: ProtocolProgress
): typeof ProjectIndexRefreshEvent.Type | undefined {
	if (!isRefreshPhase(event.phase)) return undefined;
	return ProjectIndexRefreshEvent.cases.Progress.make({
		completedPackages: event.completedItems,
		phase: event.phase,
		...(event.totalItems === undefined ? undefined : { totalPackages: event.totalItems })
	});
}

export function decodeProjectIndexWireSummary(
	summary: UAssetIoProjectIndexSummary
): ProjectIndexSummary {
	return {
		changedPackages: summary.changedPackages,
		completeness: summary.completeness,
		diagnostics: summary.diagnostics,
		generation: ProjectIndexGeneration.make(summary.generation),
		mapCount: summary.mapCount,
		packageCount: summary.packageCount,
		projectId: ProjectIdentity.make(summary.projectId),
		removedPackages: summary.removedPackages
	};
}

export function decodeProjectIndexWirePage(page: UAssetIoProjectIndexPage): ProjectIndexPage {
	const items = page.items.map((item): ProjectIndexMap | ProjectIndexHeader =>
		item.kind === "map"
			? {
					kind: "map",
					mapPath: item.mapPath,
					packageName: item.packageName
				}
			: {
					classes: [...item.classes],
					kind: "header",
					packageName: item.packageName,
					packagePath: item.packagePath,
					serializedNames: [...item.serializedNames]
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

// The dictionary lookup below checks integrality, sign, and range together. Keep structural
// validation here and avoid running equivalent per-index refinements before every lookup.
const DictionaryReferences = Schema.Array(Schema.Number).check(Schema.isMaxLength(64));
const DictionaryDomainPage = Schema.Struct({
	...ProjectIndexPage.fields,
	items: Schema.Array(
		Schema.Union([
			ProjectIndexMap,
			Schema.Struct({
				...ProjectIndexHeader.fields,
				classes: DictionaryReferences,
				serializedNames: DictionaryReferences
			})
		])
	).check(Schema.isMaxLength(PROJECT_INDEX_MAX_PAGE_SIZE)),
	strings: Schema.Array(ProjectIndexHeader.fields.classes.value).check(
		Schema.isMaxLength(PROJECT_INDEX_MAX_PAGE_SIZE * 128)
	)
});
const decodeDictionaryDomainPage = Schema.decodeUnknownExit(DictionaryDomainPage);

export function decodeProjectIndexDictionaryPage(
	input: UAssetIoProjectIndexDictionaryPage
): ProjectIndexPage {
	// Validate domain bounds while names are shared. Expansion then only follows checked references.
	const decoded = decodeDictionaryDomainPage(input);
	if (Exit.isFailure(decoded)) {
		throw new ProjectIndexUnavailable({
			message: "The Project Index adapter returned an unbounded or invalid page.",
			recovery: "Rebuild the Catalog, then retry with a bounded query.",
			retrySafe: true
		});
	}
	const page = decoded.value;
	const resolveString = (index: number): string => {
		const value = page.strings[index];
		if (value === undefined) {
			throw new ProtocolStreamFailure(
				"contract",
				"Project Index dictionary reference is out of bounds"
			);
		}
		return value;
	};
	return retainValidatedPage({
		generation: page.generation,
		items: page.items.map((item) =>
			item.kind === "map"
				? item
				: {
						...item,
						classes: item.classes.map(resolveString),
						serializedNames: item.serializedNames.map(resolveString)
					}
		),
		projectId: page.projectId,
		...(page.nextCursor === undefined
			? undefined
			: { nextCursor: ProjectIndexCursor.make(page.nextCursor) })
	});
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
			retrySafe: false
		});
	}
	if (input.event?.kind === "rejected") {
		const message = input.event.problems.join("; ");
		if (/unsupported|unknown operation|project_index_/i.test(message)) {
			return new ProjectIndexIncompatibleWorker({
				message,
				recovery:
					"Upgrade to a paired uasset-io worker that supports the requested Project Index operation and encoding, then retry.",
				retrySafe: false
			});
		}
		return new ProjectIndexInvalidRequest({
			message,
			recovery: "Correct the Project Index request and retry.",
			retrySafe: false
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
					retrySafe: true
				});
			case "corrupt_catalog":
				return new ProjectIndexCorruptCatalog({
					message: input.event.message,
					recovery: "Rebuild the Catalog, then retry.",
					retrySafe: true
				});
			case "invalid_request":
				return new ProjectIndexInvalidRequest({
					message: input.event.message,
					recovery: "Correct the Project Index request and retry.",
					retrySafe: false
				});
			case "unavailable":
				return new ProjectIndexUnavailable({
					message: input.event.message,
					recovery: "Retry after the Catalog coordinator is available, or rebuild.",
					retrySafe: true
				});
			case "cancelled":
				return new ProjectIndexRefreshFailed({
					message: input.event.message,
					recovery: "Retry the refresh when ready.",
					retrySafe: true
				});
			default:
				return new ProjectIndexRefreshFailed({
					message: input.event.message,
					recovery: "Retry the operation. If it keeps failing, rebuild the Catalog.",
					retrySafe: input.event.retrySafe
				});
		}
	}
	return new ProjectIndexRefreshFailed({
		message:
			input.stderr?.trim() ||
			`Project Index worker exited ${input.exitCode ?? "unexpectedly"}`,
		recovery: "Retry the operation. If it keeps failing, rebuild the Catalog.",
		retrySafe: true
	});
}
