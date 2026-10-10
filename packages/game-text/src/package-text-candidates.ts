import type { ProjectIndexHeader } from "@ue-shed/unreal-assets";
import type { TextCorpus } from "./schema.js";

export const REQUIRES_LOCALIZATION_GATHER = 0x00040000;

/** Saved external-object layout relates an external package to its outer package.
 * Use the complete inventory, including packages outside a caller's changed selection.
 */
export function packageTextExternalReferences(paths: readonly string[]): ReadonlySet<string> {
	const normalized = paths.map((path) => path.replaceAll("\\", "/"));
	const outers = new Set<string>();
	const references = new Set<string>();
	for (const [index, path] of normalized.entries()) {
		const match =
			/^((?:.*\/)?Content\/)__(?:ExternalActors|ExternalObjects)__\/(.+)\/(?:[^/]+\/){2}[^/]+\.(?:uasset|umap)$/u.exec(
				path
			);
		if (match) {
			references.add(paths[index]!);
			outers.add(`${match[1]}${match[2]}`);
		}
	}
	for (const [index, path] of normalized.entries())
		if (outers.has(path.replace(/\.(?:uasset|umap)$/u, ""))) references.add(paths[index]!);
	return references;
}

/** Header evidence is mandatory: older workers must be upgraded before candidate pruning. */
export function isPackageTextCandidate(
	header: NonNullable<ProjectIndexHeader["headerData"]>,
	hasExternalPackages = false
): boolean {
	return (
		(header.packageFlags & REQUIRES_LOCALIZATION_GATHER) !== 0 ||
		(header.gatherableTextDataCount > 0 && header.gatherableTextDataOffset > 0) ||
		hasExternalPackages
	);
}

/** Complete covers inspected candidates. Exclusion never proves the absence of FText. */
export function textCorpusWithExcludedPackages(
	corpus: TextCorpus,
	packageFiles: readonly string[]
): TextCorpus {
	const excluded = new Set(packageFiles);
	for (const unit of corpus.units)
		if (unit.occurrences.some((occurrence) => excluded.has(occurrence.packageFile)))
			throw new Error("STOP: excluded package contains decoded text.");
	const coverage = corpus.packageCoverage ?? [];
	if (coverage.some((item) => excluded.has(item.packageFile)))
		throw new Error("An excluded package must not also be inspected.");
	return {
		...corpus,
		packageCoverage: [
			...coverage,
			...[...excluded].map((packageFile) => ({
				packageFile,
				status: "not_gatherable" as const
			}))
		],
		diagnostics: [
			...corpus.diagnostics,
			...[...excluded].map((packageFile) => ({
				code: "package_not_gatherable" as const,
				packageFile,
				message:
					"Excluded because Unreal does not gather this package. Its text payload was not inspected."
			}))
		]
	};
}
