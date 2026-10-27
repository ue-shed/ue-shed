import type { CorpusPlan, PlannedText } from "./plan.js";

/** Unreal's gather strips the editor package namespace (TextNamespaceUtil.cpp). */
export function gatheredNamespace(namespace: string) {
	return namespace.replace(/ ?\[[^\]]*\]$/u, "");
}

export function manifestLocation(path: string, name: string, text: PlannedText) {
	if (text.manifestPath) return text.manifestPath;
	if (text.kind === "stringTableEntry") return `${path}.${name} [${text.key}]`;
	return `${path}.${name}.${text.field}`;
}

/** Localization source files use Unreal's JSON/PO formats. Binary resources are written in UE. */
export function corpusLocalization(plan: CorpusPlan) {
	const folder = `Content/Localization/${plan.target}`;
	const files: Record<string, string> = {};
	const resources: {
		culture: string;
		entries: { namespace: string; key: string; source: string; translation: string }[];
	}[] = [];
	const entries = plan.packages.flatMap((owner) =>
		owner.texts
			.filter((text) => text.gathered && text.mode === "text")
			.map((text) => ({
				text,
				namespace: gatheredNamespace(text.namespace),
				path: manifestLocation(owner.path, owner.name, text)
			}))
	);
	// Gather retains one context per namespace/key/key-metadata, even with several saved places.
	const identities = new Map<string, typeof entries>();
	for (const entry of entries) {
		const key = JSON.stringify([entry.namespace, entry.text.key]);
		const group = identities.get(key) ?? [];
		group.push(entry);
		identities.set(key, group);
	}
	const byNamespace = new Map<string, typeof entries>();
	for (const group of identities.values()) {
		const entry = group[0]!;
		const groupEntries = byNamespace.get(entry.namespace) ?? [];
		groupEntries.push(entry);
		byNamespace.set(entry.namespace, groupEntries);
	}
	const json = <T>(value: T) => `${JSON.stringify(value, null, "\t")}\n`;
	files[`${folder}/${plan.target}.manifest`] = json({
		FormatVersion: 1,
		Namespace: "",
		Subnamespaces: [...byNamespace].map(([namespace, values]) => {
			const sources = new Map<string, typeof values>();
			for (const entry of values) {
				const identity = JSON.stringify([
					entry.text.manifestSource,
					entry.text.manifestMetadata
				]);
				const group = sources.get(identity) ?? [];
				group.push(entry);
				sources.set(identity, group);
			}
			return {
				Namespace: namespace,
				Children: [...sources.values()].map((group) => {
					const text = group[0]!.text;
					return {
						Source: {
							Text: text.manifestSource,
							...(Object.keys(text.manifestMetadata).length
								? { MetaData: text.manifestMetadata }
								: undefined)
						},
						// AddSource/FindEntryByContext retains the first context for key + key metadata.
						// SourceLocation and Info metadata do not make another context (UE Core Manifest.cpp).
						Keys: group.map((entry) => ({
							Key: entry.text.key,
							Path: entry.path,
							...(entry.text.notes
								? { MetaData: { Info: { Comment: entry.text.notes } } }
								: undefined)
						}))
					};
				})
			};
		})
	});
	for (const culture of plan.cultures) {
		const resource: (typeof resources)[number] = { culture, entries: [] };
		const po: string[] = [
			'msgid ""',
			'msgstr ""',
			JSON.stringify(`Language: ${culture}\n`),
			""
		];
		files[`${folder}/${culture}/${plan.target}.archive`] = json({
			FormatVersion: 2,
			Namespace: "",
			Subnamespaces: [...byNamespace].map(([namespace, values]) => ({
				Namespace: namespace,
				Children: values.flatMap(({ text }) => {
					const mark = text.cultures[culture]!;
					if (!mark.archive) return [];
					const entry = {
						Key: text.key,
						Source: {
							Text: mark.archiveSource,
							...(Object.keys(mark.archiveMetadata).length
								? { MetaData: mark.archiveMetadata }
								: undefined)
						},
						Translation: {
							Text: mark.translation,
							...(culture === "en" && Object.keys(text.manifestMetadata).length
								? { MetaData: text.manifestMetadata }
								: undefined)
						}
					};
					return text.case.startsWith("unknown-duplicate-archive@") &&
						culture === text.parameters.translationCulture
						? [entry, { ...entry, Translation: { Text: "Another uncertain bell" } }]
						: [entry];
				})
			}))
		});
		for (const group of identities.values()) {
			const { text, namespace } = group[0]!;
			const mark = text.cultures[culture]!;
			if (
				mark.poEntry &&
				(plan.scenario !== "collapse" ||
					!po.includes(`msgid ${JSON.stringify(text.manifestSource)}`))
			)
				po.push(
					`#. ${text.notes}`,
					`msgctxt ${JSON.stringify(plan.scenario === "collapse" ? namespace : `${namespace},${text.key}`)}`,
					`msgid ${JSON.stringify(mark.expectedSource)}`,
					`msgstr ${JSON.stringify(mark.po)}`,
					""
				);
			if (
				mark.archive &&
				mark.translation &&
				mark.archiveSource === mark.expectedSource &&
				JSON.stringify(mark.archiveMetadata) === JSON.stringify(text.manifestMetadata)
			)
				resource.entries.push({
					namespace,
					key: text.key,
					source: text.manifestSource,
					translation: mark.resourceTranslation || mark.translation
				});
		}
		files[`${folder}/${culture}/${plan.target}.po`] = po.join("\n");
		resources.push(resource);
	}
	files[`Config/Localization/${plan.target}_Gather.ini`] = [
		"[CommonSettings]",
		`SourcePath=${folder}`,
		`DestinationPath=${folder}`,
		`ManifestName=${plan.target}.manifest`,
		`ArchiveName=${plan.target}.archive`,
		`PortableObjectName=${plan.target}.po`,
		`ResourceName=${plan.target}.locres`,
		"NativeCulture=en",
		`LocalizedTextCollapseMode=${plan.scenario === "collapse" ? "IdenticalNamespaceAndSource" : "IdenticalTextIdAndSource"}`,
		...plan.cultures.map((culture) => `CulturesToGenerate=${culture}`),
		"",
		"[GatherTextStep0]",
		"CommandletClass=GatherTextFromAssets",
		`IncludePathFilters=%LOCPROJECTROOT%Content/${plan.root.slice(6)}/*`,
		"PackageFileNameFilters=*.uasset",
		// Background pure pins are editor-only saved text; gather them explicitly.
		"ShouldGatherFromEditorOnlyData=true",
		...plan.packages
			.filter((owner) => owner.folder.endsWith("/OutsideTarget"))
			.map(
				(owner) =>
					`ExcludePathFilters=%LOCPROJECTROOT%Content/${owner.path.slice(6)}.uasset`
			),
		"",
		"[GatherTextStep1]",
		"CommandletClass=GatherTextFromSource",
		`SearchDirectoryPaths=${folder}`,
		"FileNameFilters=*.cpp",
		"",
		"[GatherTextStep2]",
		"CommandletClass=GenerateGatherManifest",
		"",
		"[GatherTextStep3]",
		"CommandletClass=GenerateGatherArchive",
		""
	].join("\n");
	files[`${folder}/rules.json`] = json(plan.rules);
	const sourceEntries = entries.filter(({ text }) => text.manifestPath);
	if (sourceEntries.length)
		files[`${folder}/Corpus.cpp`] = sourceEntries
			.map(
				({ text, namespace }) =>
					`const FText ${text.key} = NSLOCTEXT(${JSON.stringify(namespace)}, ${JSON.stringify(text.key)}, ${JSON.stringify(text.source)});`
			)
			.join("\n");
	return { folder, files, resources };
}
