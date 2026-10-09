import { TextCorpus, TextUnit, makeTextUnitId, makeTextOccurrenceId } from "@ue-shed/game-text";
import {
	CultureCode,
	LocalizationTarget,
	LocalizationTargetEvidence,
	parsePO,
	projectPOEvidence
} from "@ue-shed/localization";
import { Result, Schema } from "effect";

export const cultureCode = Schema.decodeUnknownSync(CultureCode);
export const target = Schema.decodeUnknownSync(LocalizationTarget)({
	name: "Test",
	source: "config_only",
	nativeCulture: "en",
	cultures: ["en", "de"],
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

export function unit(key = "K"): TextUnit {
	return TextUnit.make({
		id: makeTextUnitId("unit:" + key),
		source: { status: "consistent", value: "Source" },
		identity: { status: "resolved", namespace: "NS", key },
		occurrences: [
			{
				id: makeTextOccurrenceId("occurrence:" + key),
				devNotes: "",
				packageFile: "Content/Text/Table.uasset",
				source: "Source",
				identity: { status: "resolved", namespace: "NS", key },
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
	return TextCorpus.make({
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
			textOccurrences: units.length,
			resolvedOccurrences: units.length,
			unresolvedOccurrences: 0,
			unsupportedTextProperties: 0
		}
	});
}

export function poDocument(translation = "Translation") {
	const parsed = parsePO(
		new TextEncoder().encode('msgctxt "NS,K"\nmsgid "Source"\nmsgstr "' + translation + '"\n'),
		{ format: "Unreal" }
	);
	if (Result.isFailure(parsed)) throw parsed.failure;
	return parsed.success;
}

export function evidence(po = poDocument()): LocalizationTargetEvidence {
	const provenance = {
		relativePath: "Content/Localization/Test",
		size: 1,
		modifiedTime: "2026-01-01T00:00:00Z",
		contentHash: "hash"
	};
	return Schema.decodeUnknownSync(LocalizationTargetEvidence)({
		schemaVersion: 1,
		target,
		manifest: {
			status: "read",
			provenance,
			value: {
				formatVersion: 1,
				diagnostics: [],
				entries: [
					{
						namespace: "NS",
						key: "K",
						source: { Text: "Source" },
						path: "/Game/Text/Table.Table"
					}
				]
			}
		},
		cultures: target.cultures.map((culture) => ({
			culture,
			archive: {
				status: "read",
				provenance,
				value: {
					formatVersion: 2,
					diagnostics: [],
					entries: [
						{
							namespace: "NS",
							key: "K",
							source: { Text: "Source" },
							translation: { Text: "Translation" }
						}
					]
				}
			},
			po: { status: "read", provenance, value: projectPOEvidence(po) }
		})),
		locmeta: {
			status: "failed",
			relativePath: null,
			error: {
				_tag: "LocalizationError",
				code: "file_missing",
				message: "Missing",
				recovery: "Gather"
			}
		},
		wordCount: {
			status: "failed",
			relativePath: null,
			error: {
				_tag: "LocalizationError",
				code: "file_missing",
				message: "Missing",
				recovery: "Gather"
			}
		}
	});
}
