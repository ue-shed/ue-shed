import { Schema, Result } from "effect";
import {
	ArchiveEntry,
	CultureCode,
	LocalizationError,
	LocalizationTarget,
	ManifestEntry,
	parsePO,
	projectPOEvidence,
	discoverLocalizationTargets,
	type LocalizationTargetEvidence,
	type PODocument
} from "@ue-shed/localization/browser";
import { TextCorpus, TextUnit } from "./schema.js";

export function success<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}

export const cultureCode = Schema.decodeUnknownSync(CultureCode);
export const testTarget = success(
	discoverLocalizationTargets({
		dashboardText: "",
		configs: [
			{
				relativePath: "Config/Localization/Test.ini",
				text: "[CommonSettings]\nManifestName=Test.manifest\nNativeCulture=en\nCulturesToGenerate=en\nCulturesToGenerate=de\n[GatherTextStep0]\nCommandletClass=GatherTextFromAssets\nIncludePathFilters=Content/Text/*\nPackageFileNameFilters=*.uasset\nShouldExcludeDerivedClasses=false\n"
			}
		]
	})
).targets[0];
if (!testTarget) throw new Error("Test target recipe did not produce a target.");
// A separately decoded value preserves narrowing for callers of test helpers.
export const target = Schema.decodeUnknownSync(LocalizationTarget)(testTarget);

export function manifestEntry(
	key = "K",
	text = "Source",
	path = "/Game/Text/Table.Table",
	namespace = "NS"
): ManifestEntry {
	return Schema.decodeUnknownSync(ManifestEntry)({
		namespace,
		key,
		source: { Text: text },
		path
	});
}

export function archiveEntry(
	key = "K",
	source = "Source",
	translation = "Translation",
	namespace = "NS"
): ArchiveEntry {
	return Schema.decodeUnknownSync(ArchiveEntry)({
		namespace,
		key,
		source: { Text: source },
		translation: { Text: translation }
	});
}

export function poDocument(
	translation = "Translation",
	format: PODocument["format"] = "Unreal",
	namespace = "NS"
): PODocument {
	const identity =
		format === "Crowdin"
			? `msgid "${namespace},K"`
			: `msgctxt "${namespace},K"\nmsgid "Source"`;
	return success(
		parsePO(
			new TextEncoder().encode(
				`# translator\n#. extracted\n#: reference\n#, fuzzy\n${identity}\nmsgstr "${translation}"\n`
			),
			{ format }
		)
	);
}

export function evidence(
	manifests: readonly ManifestEntry[] = [manifestEntry()],
	archives: readonly ArchiveEntry[] = [archiveEntry()],
	po: PODocument = poDocument()
): LocalizationTargetEvidence {
	const provenance = {
		relativePath: "Content/Localization/Test",
		size: 1,
		modifiedTime: "2026-01-01T00:00:00Z",
		contentHash: "hash"
	};
	const failed = {
		status: "failed",
		relativePath: null,
		error: new LocalizationError({
			code: "file_missing",
			message: "Evidence is missing.",
			recovery: "Generate this file with Unreal."
		})
	} satisfies LocalizationTargetEvidence["locmeta"];
	return {
		schemaVersion: 1,
		target,
		manifest: {
			status: "read",
			provenance,
			value: { formatVersion: 1, entries: manifests, diagnostics: [] }
		},
		cultures: target.cultures.map((culture) => ({
			culture,
			archive: {
				status: "read",
				provenance,
				value: { formatVersion: 2, entries: archives, diagnostics: [] }
			},
			po: { status: "read", provenance, value: projectPOEvidence(po) }
		})),
		locmeta: failed,
		wordCount: failed
	};
}

export function unit(
	key = "K",
	source = "Source",
	packageFile = "Content/Text/Table.uasset",
	namespace = "NS"
): TextUnit {
	return Schema.decodeUnknownSync(TextUnit)({
		id: `unit:${key}`,
		source: { status: "consistent", value: source },
		identity: { status: "resolved", namespace, key },
		occurrences: [
			{
				id: `occurrence:${key}`,
				devNotes: "",
				packageFile,
				source,
				identity: { status: "resolved", namespace, key },
				editCapability: "source_editable",
				location: {
					kind: "string_table_entry",
					objectPath: "/Game/Text/Table.Table",
					entryKey: key
				}
			}
		]
	});
}

export function corpus(units: readonly TextUnit[] = [unit()]): TextCorpus {
	return {
		schemaVersion: 1,
		status: "complete",
		units,
		diagnostics: [],
		packageCoverage: [{ packageFile: "Content/Text/Table.uasset", status: "complete" }],
		coverage: {
			discoveredPackages: 1,
			inspectedPackages: 1,
			partialPackages: 0,
			failedPackages: 0,
			textUnits: units.length,
			textOccurrences: units.flatMap((value) => value.occurrences).length,
			resolvedOccurrences: units.length,
			unresolvedOccurrences: 0,
			unsupportedTextProperties: 0
		}
	};
}
