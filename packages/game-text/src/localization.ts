import {
	LocalizationIdentity,
	type ArchiveEntry,
	type LocalizationTarget,
	type LocalizationTargetEvidence,
	type LocalizationText,
	type ManifestEntry,
	type POEntry
} from "@ue-shed/localization/browser";
import { Option, Schema } from "effect";
import {
	LocalizationEvidenceLineId,
	LocalizationLineId,
	LocalizationUnknownReason,
	type LocalizationCultureState,
	type LocalizationJoin,
	type LocalizationLine,
	type LocalizationState
} from "./localization-schema.js";
import type { TextCorpus, TextOccurrence, TextUnit } from "./schema.js";

/** FString matching is case insensitive; ? consumes zero or one character, * any number. */
export function matchesUnrealWildcard(value: string, pattern: string): boolean {
	const expression = [...pattern]
		.map((character) => {
			if (character === "*") return ".*";
			if (character === "?") return ".?";
			return character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
		})
		.join("");
	return new RegExp(`^${expression}$`, "isu").test(value);
}

function normalizePath(value: string): string {
	return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

const GatherRule = Schema.Struct({
	includes: Schema.Array(Schema.String),
	excludes: Schema.Array(Schema.String),
	filenames: Schema.Array(Schema.String),
	classes: Schema.Array(Schema.String),
	excludeDerived: Schema.Boolean
});
type GatherRule = typeof GatherRule.Type;

function gatherRules(target: LocalizationTarget): readonly GatherRule[] | undefined {
	const rules = target.configs.flatMap((config) =>
		config.steps
			.filter((step) => step.commandletClass === "GatherTextFromAssets")
			.map((step): GatherRule => {
				const fields = step.fields;
				const common = config.common;
				return {
					includes: fields.IncludePathFilters.length
						? fields.IncludePathFilters
						: common.IncludePathFilters,
					excludes: fields.ExcludePathFilters.length
						? fields.ExcludePathFilters
						: common.ExcludePathFilters,
					filenames: fields.PackageFileNameFilters.length
						? fields.PackageFileNameFilters
						: common.PackageFileNameFilters,
					classes: fields.ExcludeClasses.length
						? fields.ExcludeClasses
						: common.ExcludeClasses,
					excludeDerived:
						fields.ShouldExcludeDerivedClasses ??
						common.ShouldExcludeDerivedClasses ??
						false
				};
			})
	);
	if (rules.length) return rules;
	const settings = target.dashboard?.settings.GatherFromPackages;
	if (!settings) {
		// An authored recipe without an asset-gather step proves assets are outside its scope.
		return target.configs.length ? [] : undefined;
	}
	if (!settings.IsEnabled) return [];
	if (
		[...settings.IncludePathWildcards, ...settings.ExcludePathWildcards].some(
			(path) => path.PathRoot === "Engine"
		)
	)
		return undefined;
	return [
		{
			includes: settings.IncludePathWildcards.map((path) => path.Pattern),
			excludes: settings.ExcludePathWildcards.map((path) => path.Pattern),
			filenames: settings.FileExtensions.map(
				(extension) => `*.${extension.Pattern.replace(/^\*?\./u, "")}`
			),
			classes: settings.ExcludeClasses ?? [],
			excludeDerived: settings.ShouldExcludeDerivedClasses ?? false
		}
	];
}

function pathRating(pattern: string): number {
	return (
		100 - (pattern.match(/\//gu)?.length ?? 0) + (pattern.match(/[?*]/gu)?.length ?? 0) * 1000
	);
}

function includedPath(path: string, rule: GatherRule): boolean {
	const filters = [
		...rule.includes.map((pattern) => ({ pattern: normalizePath(pattern), included: true })),
		...rule.excludes.map((pattern) => ({ pattern: normalizePath(pattern), included: false }))
	].sort(
		(a, b) =>
			pathRating(a.pattern) - pathRating(b.pattern) || Number(a.included) - Number(b.included)
	);
	return (
		filters.find(({ pattern }) =>
			pattern.indexOf("*") === pattern.length - 1
				? path.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase())
				: matchesUnrealWildcard(path, pattern)
		)?.included ?? false
	);
}

export const LocalizationGatherCoverage = Schema.Union([
	Schema.Struct({ status: Schema.Literals(["inside", "outside"]) }),
	Schema.Struct({ status: Schema.Literal("unknown"), reason: LocalizationUnknownReason })
]);
export type LocalizationGatherCoverage = typeof LocalizationGatherCoverage.Type;

/** Paths must be project-relative. No host paths or class hierarchy are guessed. */
export function localizationGatherCoverage(
	target: LocalizationTarget,
	occurrence: TextOccurrence
): LocalizationGatherCoverage {
	const path = normalizePath(occurrence.packageFile);
	if (/^(?:\/|[a-z]:)/iu.test(path) || path.split("/").includes(".."))
		return { status: "unknown", reason: "path_not_project_relative" };
	const rules = gatherRules(target);
	if (!rules) return { status: "unknown", reason: "gather_settings_unavailable" };
	let uncertain: LocalizationUnknownReason | undefined;
	for (const rule of rules) {
		if (
			[...rule.includes, ...rule.excludes].some(
				(pattern) =>
					/^(?:\/|[a-z]:)/iu.test(normalizePath(pattern)) ||
					normalizePath(pattern).split("/").includes("..")
			)
		) {
			uncertain = "gather_settings_unavailable";
			continue;
		}
		if (!includedPath(path, rule)) continue;
		if (
			!rule.filenames.some((pattern) =>
				matchesUnrealWildcard(path.split("/").at(-1) ?? "", pattern)
			)
		)
			continue;
		if (occurrence.location.kind === "data_table_cell" && rule.classes.length) {
			// The corpus location does not distinguish DataTable from CompositeDataTable classes.
			uncertain = "asset_class_unavailable";
			continue;
		}
		const classPath =
			occurrence.location.kind === "asset_property"
				? occurrence.location.classPath
				: occurrence.location.kind === "string_table_entry"
					? "/Script/Engine.StringTable"
					: "/Script/Engine.DataTable";
		if (
			rule.classes.some(
				(excluded) =>
					excluded.toLowerCase() === classPath.toLowerCase() ||
					excluded.toLowerCase() === classPath.split(".").at(-1)?.toLowerCase()
			)
		)
			continue;
		if (rule.excludeDerived && rule.classes.length) {
			uncertain = "class_hierarchy_unavailable";
			continue;
		}
		return { status: "inside" };
	}
	return uncertain ? { status: "unknown", reason: uncertain } : { status: "outside" };
}

function identityKey(identity: typeof LocalizationIdentity.Type): string {
	return JSON.stringify([identity.namespace, identity.key]);
}

function sameJson(left: typeof Schema.Json.Type, right: typeof Schema.Json.Type): boolean {
	if (left === right) return true;
	if (left === null || right === null) return false;
	if (Array.isArray(left))
		return (
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((item, index) => sameJson(item, right[index] ?? null))
		);
	if (Array.isArray(right)) return false;
	if (
		!Schema.is(Schema.Record(Schema.String, Schema.Json))(left) ||
		!Schema.is(Schema.Record(Schema.String, Schema.Json))(right)
	)
		return false;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) => Object.hasOwn(right, key) && sameJson(left[key] ?? null, right[key] ?? null)
		)
	);
}

function sameSource(left: LocalizationText, right: LocalizationText): boolean {
	return sameJson(left, right);
}

const CommentMetadata = Schema.Struct({ Comment: Schema.optionalKey(Schema.String) });

export function localizationManifestNotes(entry: ManifestEntry): readonly string[] {
	const info = Schema.decodeUnknownOption(CommentMetadata)(entry.metadata?.Info);
	const comment = Option.isSome(info) ? (info.value.Comment ?? "") : "";
	return [...new Set([entry.devNotes ?? "", comment])].filter((notes) => notes.trim() !== "");
}

/** A key path can point into a package or into C++/config. Only project asset paths prove absence. */
export function manifestPackageFile(path: string): string | undefined {
	const normalized = normalizePath(path);
	const file = normalized.match(/^(Content\/.*?\.(?:uasset|umap))(?:$|[:.])/iu)?.[1];
	if (file) return file;
	const game = normalized.match(/^\/Game\/([^.:]+)(?:\.|:|$)/u)?.[1];
	return game ? `Content/${game}.uasset` : undefined;
}

const precedence = [
	"outside_target",
	"not_gathered",
	"not_found",
	"gathered_only",
	"changed_since_gather",
	"unknown",
	"not_synced",
	"needs_update",
	"not_translated",
	"translated"
] satisfies readonly LocalizationState[];

function groupByIdentity<A extends typeof LocalizationIdentity.Type>(
	entries: readonly A[]
): Map<string, A[]> {
	const grouped = new Map<string, A[]>();
	for (const entry of entries) {
		const key = identityKey(entry);
		grouped.set(key, [...(grouped.get(key) ?? []), entry]);
	}
	return grouped;
}

/** Join namespace/key only. Source comparisons classify already-joined evidence. */
export function joinLocalizationTarget(
	corpus: TextCorpus,
	evidence: LocalizationTargetEvidence,
	target: LocalizationTarget = evidence.target
): LocalizationJoin {
	const manifest = groupByIdentity(
		evidence.manifest.status === "read" ? evidence.manifest.value.entries : []
	);
	const tables = new Map<string, typeof LocalizationIdentity.Type>();
	for (const unit of corpus.units) {
		if (unit.identity.status !== "resolved") continue;
		for (const occurrence of unit.occurrences) {
			if (occurrence.location.kind === "string_table_entry")
				tables.set(
					JSON.stringify([occurrence.location.objectPath, occurrence.location.entryKey]),
					Schema.decodeUnknownSync(LocalizationIdentity)(unit.identity)
				);
		}
	}
	const rows = new Map<
		string,
		{ identity: typeof LocalizationIdentity.Type | null; units: TextUnit[] }
	>();
	for (const unit of corpus.units) {
		const identity =
			unit.identity.status === "resolved"
				? Schema.decodeUnknownSync(LocalizationIdentity)(unit.identity)
				: unit.identity.status === "string_table"
					? (tables.get(JSON.stringify([unit.identity.tableId, unit.identity.key])) ??
						null)
					: null;
		const key = identity ? identityKey(identity) : `unresolved:${unit.id}`;
		const row = rows.get(key) ?? { identity, units: [] };
		row.units.push(unit);
		rows.set(key, row);
	}
	for (const [key, entries] of manifest) {
		const entry = entries[0];
		if (entry && !rows.has(key))
			rows.set(key, { identity: { namespace: entry.namespace, key: entry.key }, units: [] });
	}
	const packageCoverage = new Map<
		string,
		NonNullable<TextCorpus["packageCoverage"]>[number]["status"]
	>();
	for (const item of corpus.packageCoverage ?? []) {
		const path = normalizePath(item.packageFile).toLowerCase();
		const previous = packageCoverage.get(path);
		if (previous === "failed" || (previous === "partial" && item.status === "complete"))
			continue;
		packageCoverage.set(path, item.status);
	}
	for (const diagnostic of corpus.diagnostics) {
		const path = normalizePath(diagnostic.packageFile).toLowerCase();
		if (packageCoverage.get(path) === "failed") continue;
		packageCoverage.set(
			path,
			diagnostic.code === "package_inspection_failed" ? "failed" : "partial"
		);
	}
	const cultureIndexes = evidence.cultures.map((culture) => ({
		...culture,
		archives: groupByIdentity(
			culture.archive.status === "read" ? culture.archive.value.entries : []
		),
		pos: groupByIdentity(
			culture.po.status === "read"
				? culture.po.value.blocks.flatMap((block) =>
						block.kind === "entry" && block.entry?.identity
							? [{ ...block.entry.identity, entry: block.entry }]
							: []
					)
				: []
		)
	}));
	const lines: LocalizationLine[] = [];
	for (const [key, row] of rows) {
		const entries = manifest.get(key) ?? [];
		const first = entries[0];
		const reasons: LocalizationUnknownReason[] = [];
		const structural: LocalizationState[] = [];
		// A saved String Table reference has no authored source or gather scope of its own.
		// Its owning table entry supplies both, while all reference unit IDs remain attached.
		const authored = row.units.filter((unit) => unit.identity.status !== "string_table");
		const occurrences = (authored.length ? authored : row.units).flatMap(
			(unit) => unit.occurrences
		);
		const sources = [...new Set(occurrences.map((occurrence) => occurrence.source))];
		const source = sources.length ? sources.join(" ") : (first?.source.Text ?? "");
		if (!row.identity)
			reasons.push(
				row.units.some((unit) => unit.identity.status === "string_table")
					? "string_table_namespace_unavailable"
					: "unresolved_identity"
			);
		if (evidence.manifest.status === "failed") reasons.push("missing_manifest");
		if (entries.length > 1) reasons.push("duplicate_manifest_identity");
		if (sources.length > 1) reasons.push("conflicting_source");
		if (occurrences.length) {
			const coverage = occurrences.map((occurrence) =>
				localizationGatherCoverage(target, occurrence)
			);
			if (coverage.every((item) => item.status === "outside"))
				structural.push("outside_target");
			else if (!coverage.some((item) => item.status === "inside")) {
				for (const item of coverage)
					if (item.status === "unknown") reasons.push(item.reason);
			} else if (!first && evidence.manifest.status === "read" && row.identity)
				structural.push("not_gathered");
			if (first && sources.length === 1 && sources[0] !== first.source.Text)
				structural.push("changed_since_gather");
			// A global identity match does not prove that the manifest's original package still has it.
			for (const entry of entries) {
				const file = manifestPackageFile(entry.path);
				if (!file) continue;
				const path = normalizePath(file).toLowerCase();
				const alternative = path.replace(/\.uasset$/u, ".umap");
				if (
					occurrences.some((occurrence) =>
						[path, alternative].includes(
							normalizePath(occurrence.packageFile).toLowerCase()
						)
					)
				)
					continue;
				const status = packageCoverage.get(path) ?? packageCoverage.get(alternative);
				if (status === "complete") structural.push("not_found");
				else
					reasons.push(
						status === "partial"
							? "package_partial"
							: status === "failed"
								? "package_failed"
								: "package_not_scanned"
					);
			}
		} else if (first) {
			const files = entries.map((entry) => manifestPackageFile(entry.path));
			if (
				files.every((file) => file === undefined) &&
				entries.every((entry) => !normalizePath(entry.path).startsWith("/"))
			)
				structural.push("gathered_only");
			else {
				for (const file of files) {
					if (!file) {
						reasons.push("package_not_scanned");
						continue;
					}
					const normalized = normalizePath(file).toLowerCase();
					const status =
						packageCoverage.get(normalized) ??
						packageCoverage.get(normalized.replace(/\.uasset$/u, ".umap"));
					if (status !== "complete")
						reasons.push(
							status === "partial"
								? "package_partial"
								: status === "failed"
									? "package_failed"
									: "package_not_scanned"
						);
				}
				if (!reasons.length) structural.push("not_found");
			}
		}
		const cultures: LocalizationCultureState[] = target.cultures.map((culture) => {
			const index = cultureIndexes.find((item) => item.culture === culture);
			const archives: readonly ArchiveEntry[] = index?.archives.get(key) ?? [];
			const pos = index?.pos.get(key) ?? [];
			const archive = archives[0] ?? null;
			const po: POEntry | null = pos[0]?.entry ?? null;
			const poValue = po?.msgstr["0"] ?? "";
			const archiveAbsent =
				index?.archive.status === "failed" && index.archive.error.code === "file_missing";
			const poAbsent =
				index?.po.status === "failed" && index.po.error.code === "file_missing";
			const unknownReasons = [...reasons];
			const facts = [...structural];
			if (!index || index.archive.status === "failed") unknownReasons.push("missing_archive");
			if (!index || index.po.status === "failed") unknownReasons.push("missing_po");
			if (archives.length > 1) unknownReasons.push("duplicate_archive_identity");
			if (pos.length > 1) unknownReasons.push("duplicate_po_identity");
			if (target.collapseMode === "IdenticalNamespaceAndSource")
				unknownReasons.push("ambiguous_po_identity");
			if (
				(index?.archive.status === "read" || archiveAbsent) &&
				archives.length <= 1 &&
				pos.length === 1 &&
				poValue !== "" &&
				poValue !== (archive?.translation.Text ?? "")
			)
				facts.push("not_synced");
			if (
				archives.length === 1 &&
				entries.length === 1 &&
				archive &&
				first &&
				!sameSource(archive.source, first.source)
			)
				facts.push("needs_update");
			if ((index?.archive.status === "read" || archiveAbsent) && archives.length <= 1) {
				if (!archive || archive.translation.Text === "") facts.push("not_translated");
				else if (entries.length === 1 && first && sameSource(archive.source, first.source))
					facts.push("translated");
			}
			// Native entries are evaluated from the native archive too; absent evidence is never invented.
			if (
				unknownReasons.some(
					(reason) =>
						!(reason === "missing_archive" && archiveAbsent) &&
						!(reason === "missing_po" && poAbsent)
				)
			)
				facts.push("unknown");
			const state = precedence.find((candidate) => facts.includes(candidate)) ?? "unknown";
			return {
				culture,
				state,
				facts: [...new Set(facts)],
				unknownReasons: [...new Set(unknownReasons)],
				reducedSourceChecking: index?.po.status === "read" && !index.po.value.hasSourceText,
				archive,
				poTranslation: po && poValue !== (archive?.translation.Text ?? "") ? poValue : null,
				po
			};
		});
		const evidenceId = LocalizationEvidenceLineId.make(`evidence:${target.name}:${key}`);
		const origin: LocalizationLine["origin"] = row.units.length
			? { kind: "corpus", unitIds: row.units.map((unit) => unit.id).sort() }
			: { kind: "evidence", id: evidenceId };
		lines.push({
			id: LocalizationLineId.make(`${target.name}:${key}`),
			origin,
			identity: row.identity,
			source,
			manifest: entries,
			cultures
		});
	}
	return {
		schemaVersion: 1,
		target: target.name,
		nativeCulture: target.nativeCulture,
		cultures: target.cultures,
		lines: lines.sort((a, b) => a.id.localeCompare(b.id))
	};
}
