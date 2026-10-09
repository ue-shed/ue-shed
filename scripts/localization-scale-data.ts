import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import type { SavedAssetTextExtractionEvent } from "../packages/unreal-assets/dist/index.js";
import { localizationReviewFingerprint } from "../packages/localization/dist/index.js";
import { repositoryPath } from "./game-text-scale-options.ts";

export function localizationScaleEntry(
	index: number,
	authored?: {
		key: string;
		source: string;
		translation: string;
		path: string;
		namespace: string;
	}
) {
	const key = authored?.key ?? `Key${String(index).padStart(6, "0")}`;
	const source =
		authored?.source ??
		`Generated source ${key}: ${"The traveler follows the road to the village. ".repeat(5)}${index % 101 === 0 ? "\u2028" : ""}`;
	const translation =
		authored?.translation ??
		`Generated translation ${key}: ${"Continue along the path. ".repeat(4)}`;
	const path = authored?.path ?? `/Game/Generated/Text/Table${Math.floor(index / 100)}.Table`;
	const context = JSON.stringify(`${authored?.namespace ?? "Generated"},${key}`);
	const sourceLines =
		authored === undefined
			? `msgid ""\r\n${JSON.stringify(source.slice(0, 120))}\r\n${JSON.stringify(source.slice(120))}`
			: `msgid ${JSON.stringify(source)}`;
	const po = `#. Key: ${key}\r\n${authored === undefined ? "" : "#. Velora nimblet\r\n"}#: ${path}\r\nmsgctxt ${context}\r\n${sourceLines}\r\nmsgstr ${JSON.stringify(translation)}\r\n\r\n`;
	return { key, source, translation, path, po };
}

export const scaleCultures = [
	"en",
	"de",
	"fr",
	"es",
	"it",
	"ja",
	"ko",
	"zh",
	"pt",
	"pl",
	"nl",
	"sv",
	"da",
	"fi",
	"cs",
	"tr",
	"uk",
	"ar",
	"el",
	"hu"
];

export function gameTextScaleRecipe(scale: number) {
	if (!Number.isFinite(scale) || scale <= 0) throw new Error("Scale must be positive.");
	const count = (base: number, minimum = 1) => Math.max(minimum, Math.round(base * scale));
	const keys = count(132_606, 32);
	const gatheredOnly = count(1_048);
	const notFound = count(203);
	const changedKeys = count(300);
	const editor = count(59_458);
	const outside = count(4_132);
	const keyedUnknown = count(1_011);
	const keyless = count(386_000);
	const savedKeys = keys - gatheredOnly - notFound;
	const resolved = savedKeys + editor + outside + keyedUnknown + changedKeys;
	const textPackages = count(16_500, 2);
	const outsidePackages = Math.min(textPackages - 1, count(100));
	return {
		scale,
		keys,
		gatheredOnly,
		notFound,
		changedKeys,
		editor,
		outside,
		keyedUnknown,
		keyless,
		savedKeys,
		resolved,
		packages: count(166_518, 4),
		textPackages,
		outsidePackages,
		partialPackages: Math.min(textPackages - outsidePackages, count(15_400)),
		gaps: count(4_800_000, 10),
		occurrences: Math.max(resolved + keyless, count(1_028_205)),
		cultures: scaleCultures.slice(0, scale >= 10 ? 20 : 10)
	};
}
export type GameTextScaleRecipe = ReturnType<typeof gameTextScaleRecipe>;

function guid(index: number, seed: number): string {
	return `${(seed >>> 0).toString(16).padStart(8, "0")}${index.toString(16).padStart(24, "0")}`;
}

/** Random access seeded words keep the generator bounded regardless of target size. */
export function gameTextScaleEntry(index: number, recipe: GameTextScaleRecipe, seed: number) {
	const word = ["velora", "nimblet", "oriven", "taluma", "fenori", "lumeko", "mirava", "solune"];
	const sourceIndex = index % 31 === 0 ? index - (index % 7) : index;
	const offset = ((Math.imul(sourceIndex + 1, 1664525) + seed) >>> 0) % word.length;
	const phrase = Array.from({ length: 18 }, (_, i) => word[(offset + i * 3) % word.length]).join(
		" "
	);
	const source = `${phrase} ${sourceIndex}${sourceIndex % 101 === 0 ? "\u2028" : ""}`;
	const translation = `Velori ${phrase.slice(0, 96)} ${sourceIndex}`;
	const large = Math.round((recipe.keys * 19_000) / 132_606);
	const tableEnd = Math.round((recipe.keys * 55_000) / 132_606);
	const small = Math.min(
		Math.round(394 * Math.max(1, recipe.scale)),
		Math.floor(recipe.keys / 8)
	);
	const namespace =
		index < large
			? "Velora"
			: index < tableEnd
				? `TalumaTable${Math.floor((index - large) / Math.max(1, Math.round(600 * Math.min(1, recipe.scale))))}`
				: index >= recipe.keys - small && index < recipe.keys
					? `Fenori${index - recipe.keys + small}`
					: "";
	const key = index % 20 === 0 ? `Taluma.Row${index}.Label` : guid(index, seed);
	const packageIndex =
		index >= recipe.savedKeys && index < recipe.savedKeys + recipe.notFound
			? recipe.textPackages + (index % Math.max(1, recipe.packages - recipe.textPackages))
			: index % (recipe.textPackages - recipe.outsidePackages);
	const packagePath = `Content/Velora/Oriven/Fenori/Taluma/Package${packageIndex}.uasset`;
	const object = `/Game/Velora/Oriven/Fenori/Taluma/Package${packageIndex}.Package${packageIndex}`;
	const path =
		index >= recipe.keys - recipe.gatheredOnly
			? index % 2 === 0
				? `Source/Velora/Lumeko.cpp - line ${index + 1}`
				: `Config/Velora.ini - line ${index + 1}`
			: `${object}.Label${index}`;
	return {
		...localizationScaleEntry(index, { namespace, key, source, translation, path }),
		namespace,
		packagePath,
		object
	};
}

/** At most 1 MiB of pending text per file; never build a full JSON or PO string. */
function streamedFile(
	path: string,
	encoding: BufferEncoding,
	produce: (append: (text: string) => void) => void
) {
	const fd = openSync(path, "wx");
	let parts: string[] = [];
	let length = 0;
	let bytes = 0;
	const flush = () => {
		const buffer = Buffer.from(parts.join(""), encoding);
		let offset = 0;
		while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
		bytes += buffer.length;
		parts = [];
		length = 0;
	};
	try {
		produce((text) => {
			parts.push(text);
			length += text.length;
			if (length >= 512 * 1024) flush();
		});
		flush();
	} finally {
		closeSync(fd);
	}
	return bytes;
}

function jsonEntries(
	append: (text: string) => void,
	recipe: GameTextScaleRecipe,
	seed: number,
	archive: boolean,
	culture = "en"
) {
	append('\uFEFF{"FormatVersion":' + (archive ? 2 : 1) + ',"Namespace":"","Subnamespaces":[');
	let namespace: string | undefined;
	let first = true;
	for (let index = 0; index < recipe.keys; index++) {
		const entry = gameTextScaleEntry(index, recipe, seed);
		if (entry.namespace !== namespace) {
			if (namespace !== undefined) append("]},");
			append('{"Namespace":' + JSON.stringify(entry.namespace) + ',"Children":[');
			namespace = entry.namespace;
			first = true;
		}
		const text = culture === "en" ? entry.source : `${culture} ${entry.translation}`;
		const child = archive
			? {
					Source: { Text: entry.source },
					Translation: { Text: index % 97 === 1 ? "" : text },
					Key: entry.key
				}
			: {
					Source: { Text: entry.source },
					Keys: [
						{
							Key: entry.key,
							Path: entry.path,
							MetaData: { Info: { DevNotes: "Velora nimblet" } }
						}
					]
				};
		append((first ? "" : ",") + JSON.stringify(child));
		first = false;
	}
	append("]}]}");
}

export async function generateGameTextScale(options: {
	root: string;
	scale: number;
	seed: number;
}) {
	const root = repositoryPath(options.root);
	if (!Number.isSafeInteger(options.seed)) throw new Error("Seed must be a safe integer.");
	const recipe = gameTextScaleRecipe(options.scale);
	const start = performance.now();
	await mkdir(root); // Exclusive root: never overwrite a project or an earlier dataset.
	let bytes = 0;
	const write = async (path: string, text: string) => {
		bytes += Buffer.byteLength(text);
		await writeFile(resolve(root, path), text, { flag: "wx" });
	};
	await mkdir(resolve(root, "Config/Localization"), { recursive: true });
	await mkdir(resolve(root, "Config/UEShed/Localization"), { recursive: true });
	const cultures = recipe.cultures.map((culture) => `(CultureName="${culture}")`).join(",");
	await write(
		"Config/DefaultEditor.ini",
		`[/Script/LocalizationDashboard.LocalizationSettings]\r\n+GameTargetsSettings=(Name="Generated",Guid=${guid(1, options.seed)},GatherFromPackages=(IsEnabled=True,IncludePathWildcards=((Pattern="Content/*")),ExcludePathWildcards=((Pattern="Content/L10N/*")),FileExtensions=((Pattern="uasset"),(Pattern="umap")),ShouldGatherFromEditorOnlyData=False),NativeCultureIndex=0,SupportedCulturesStatistics=(${cultures}))\r\n`
	);
	await write(
		"Config/Localization/Generated_Gather.ini",
		`[CommonSettings]\r\nSourcePath=Content/Localization/Generated\r\nDestinationPath=Content/Localization/Generated\r\nManifestName=Generated.manifest\r\nArchiveName=Generated.archive\r\nPortableObjectName=Generated.po\r\nNativeCulture=en\r\n${recipe.cultures.map((culture) => `CulturesToGenerate=${culture}\r\n`).join("")}\r\n[GatherTextStep0]\r\nCommandletClass=GatherTextFromSource\r\nSearchDirectoryPaths=Source/Velora\r\nSearchDirectoryPaths=Config\r\nFileNameFilters=*.cpp\r\nFileNameFilters=*.ini\r\n\r\n[GatherTextStep1]\r\nCommandletClass=GatherTextFromAssets\r\nIncludePathFilters=%LOCPROJECTROOT%Content/*\r\nExcludePathFilters=%LOCPROJECTROOT%Content/L10N/*\r\nPackageFileNameFilters=*.uasset\r\nPackageFileNameFilters=*.umap\r\nShouldGatherFromEditorOnlyData=false\r\n\r\n[GatherTextStep2]\r\nCommandletClass=GenerateGatherManifest\r\n\r\n[GatherTextStep3]\r\nCommandletClass=GenerateGatherArchive\r\n`
	);
	const folder = resolve(root, "Content/Localization/Generated");
	await mkdir(folder, { recursive: true });
	bytes += streamedFile(resolve(folder, "Generated.manifest"), "utf16le", (append) =>
		jsonEntries(append, recipe, options.seed, false)
	);
	for (const culture of recipe.cultures) {
		await mkdir(resolve(folder, culture));
		bytes += streamedFile(resolve(folder, culture, "Generated.archive"), "utf16le", (append) =>
			jsonEntries(append, recipe, options.seed, true, culture)
		);
		bytes += streamedFile(resolve(folder, culture, "Generated.po"), "utf8", (append) => {
			append(`\uFEFFmsgid ""\r\nmsgstr ""\r\n"Language: ${culture}\\n"\r\n\r\n`);
			for (let index = 0; index < recipe.keys; index++) {
				const entry = gameTextScaleEntry(index, recipe, options.seed);
				const translation =
					index % 97 === 1
						? ""
						: culture === "en"
							? entry.source
							: `${culture} ${entry.translation}`;
				append(
					localizationScaleEntry(index, {
						...entry,
						translation: index % 89 === 2 ? translation + " mirava" : translation
					}).po
				);
			}
		});
	}
	const records = Array.from(
		{ length: Math.max(1, Math.round(100 * recipe.scale)) },
		(_, index) => {
			const entry = gameTextScaleEntry(index, recipe, options.seed);
			return {
				culture: "de",
				namespace: entry.namespace,
				key: entry.key,
				flags: ["reviewed"],
				fingerprint: localizationReviewFingerprint(entry.source, `de ${entry.translation}`),
				by: "Velora",
				at: "2026-01-01T00:00:00Z"
			};
		}
	);
	await write(
		"Config/UEShed/Localization/Generated.review.json",
		JSON.stringify({ schemaVersion: 1, target: "Generated", records, acceptedFindings: [] }) +
			"\n"
	);
	bytes += streamedFile(resolve(root, "saved-text.ndjson"), "utf8", (append) => {
		for (const event of gameTextScaleEvents(recipe, options.seed))
			append(
				JSON.stringify(event)
					.replaceAll("\u2028", "\\u2028")
					.replaceAll("\u2029", "\\u2029") + "\n"
			);
	});
	const descriptor =
		JSON.stringify({ schemaVersion: 1, seed: options.seed, recipe }, null, "\t") + "\n";
	await write("scale.json", descriptor);
	return {
		schemaVersion: 1,
		...options,
		root,
		recipe,
		bytes,
		seconds: (performance.now() - start) / 1000,
		recipeHash: createHash("sha256").update(descriptor).digest("hex")
	};
}

/** Relative paths are relocated by the replay adapter, keeping bytes independent of output root. */
export function* gameTextScaleEvents(
	recipe: GameTextScaleRecipe,
	seed: number
): Generator<SavedAssetTextExtractionEvent> {
	const normalPackages = recipe.textPackages - recipe.outsidePackages;
	const pathFor = (pkg: number) =>
		`Content/${pkg >= normalPackages && pkg < recipe.textPackages ? "L10N" : "Velora"}/Oriven/Fenori/Taluma/Package${pkg}.uasset`;
	const objectFor = (pkg: number) =>
		`/Game/${pkg >= normalPackages && pkg < recipe.textPackages ? "L10N" : "Velora"}/Oriven/Fenori/Taluma/Package${pkg}.Package${pkg}`;
	const packageCounts = new Uint32Array(recipe.packages);
	for (let occurrenceIndex = 0; occurrenceIndex < recipe.occurrences; occurrenceIndex++) {
		const unique = recipe.resolved + recipe.keyless;
		const id =
			occurrenceIndex < unique
				? occurrenceIndex
				: (occurrenceIndex - unique) % recipe.resolved;
		const entry = gameTextScaleEntry(
			id < recipe.savedKeys ? id : recipe.keys + id - recipe.savedKeys,
			recipe,
			seed
		);
		const tableEntries = Math.max(1, Math.round(recipe.occurrences * 0.0015));
		const isTable = id < tableEntries && occurrenceIndex < unique;
		const isCell = !isTable && occurrenceIndex % 100 < 19;
		const isReference = !isTable && id < tableEntries;
		const isOutside =
			id >= recipe.savedKeys + recipe.editor &&
			id < recipe.savedKeys + recipe.editor + recipe.outside;
		const pkg = isOutside
			? normalPackages + (id % recipe.outsidePackages)
			: id % normalPackages;
		packageCounts[pkg] = (packageCounts[pkg] ?? 0) + 1;
		const actualPath = pathFor(pkg);
		const actualObject = objectFor(pkg) + `:Mirava${occurrenceIndex}.Lumeko`;
		const local = occurrenceIndex;
		const changed = id >= recipe.resolved - recipe.changedKeys && id < recipe.resolved;
		const oldId = changed
			? recipe.keys -
				recipe.gatheredOnly -
				recipe.notFound +
				((id - recipe.resolved + recipe.changedKeys) % recipe.notFound)
			: id;
		const source = changed ? gameTextScaleEntry(oldId, recipe, seed).source : entry.source;
		// Saved FText markers are retained by the corpus and stripped by the localization join.
		const namespace =
			entry.namespace +
			(isTable || isReference ? "" : ` [${guid(id % normalPackages, seed)}]`);
		yield {
			event: "text_occurrence",
			schema_version: 1,
			path: actualPath,
			fileBytes: 4096,
			occurrence: {
				source,
				dev_notes: id % 43 === 0 ? "Velora nimblet" : "",
				identity:
					id >= recipe.resolved
						? { status: "unresolved", reason: "missing_key" }
						: isReference
							? { status: "string_table", table_id: entry.object, key: entry.key }
							: {
									status: "resolved",
									namespace,
									key: changed ? guid(recipe.keys + id, seed) : entry.key
								},
				location: isTable
					? {
							kind: "string_table_entry",
							object_path: entry.object,
							entry_key: entry.key
						}
					: isCell
						? {
								kind: "data_table_cell",
								object_path: actualObject,
								row: `Mirava${id}`,
								property_path: `Label${local}`
							}
						: {
								kind: "asset_property",
								object_path: actualObject,
								class_path: "/Script/Engine.DataAsset",
								property_path: `${id >= recipe.savedKeys && id < recipe.savedKeys + recipe.editor ? "NodeTitle" : "Label"}${local}`
							},
				edit_capability: isTable || isCell ? "source_editable" : "read_only"
			}
		};
	}
	let gapIndex = 0;
	for (let pkg = 0; pkg < recipe.packages; pkg++) {
		const path = pathFor(pkg);
		const object = objectFor(pkg);
		const gaps =
			pkg < recipe.partialPackages
				? Math.floor(recipe.gaps / recipe.partialPackages) +
					(pkg < recipe.gaps % recipe.partialPackages ? 1 : 0)
				: 0;
		for (let gap = 0; gap < gaps; gap++, gapIndex++) {
			const bucket = gapIndex % 10_000;
			yield {
				event: "text_coverage_gap",
				schema_version: 1,
				path,
				coverage_gap: {
					object_path: object,
					property_path: `Oriven[${gap}]`,
					reason:
						bucket < 5600
							? "property_decoder_rejected"
							: bucket < 9844
								? "feature_unavailable_for_engine_version"
								: bucket < 9994
									? "legacy_container_element_without_type_information"
									: "unsupported_text_history"
				}
			};
		}
		yield {
			event: "text_package",
			schema_version: 1,
			path,
			fileBytes: 4096,
			status: gaps > 0 ? "partial" : "complete",
			occurrences: packageCounts[pkg] ?? 0,
			coverage_gaps: gaps,
			diagnostics: []
		};
	}
	// The native adapter's scan summary reports all inspected packages, including those without text.
	yield {
		event: "text_summary",
		schema_version: 8,
		depth: "text",
		cacheHits: 0,
		diagnostics: [],
		emittedAssets: recipe.packages,
		failedAssets: 0,
		partialAssets: recipe.partialPackages,
		projectRoot: ".",
		roots: ["Content"],
		scannedAssets: recipe.packages,
		skippedAssets: 0
	};
}
