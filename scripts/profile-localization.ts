import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect, Result } from "effect";
import {
	discoverLocalizationTargets,
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	parseArchive,
	parseManifest,
	parsePO
} from "../packages/localization/dist/index.js";
import { localizationScaleEntry } from "./localization-scale-data.ts";

// Build localization first. Run each mode in a fresh Node process with --expose-gc;
// add --cpu-prof --cpu-prof-dir=out/localization-profile for parser attribution.
const root = resolve("out/localization-profile");
const mode = process.argv[2] ?? "po";
const count = Number(process.argv[3] ?? 132_606);
const cultures = ["en", "de", "fr", "es", "it", "ja", "ko", "zh", "pt", "pl"];
const recipe = `[CommonSettings]\nManifestName=Generated.manifest\nArchiveName=Generated.archive\nPortableObjectName=Generated.po\nDestinationPath=Content/Localization/Generated\nNativeCulture=en\n${cultures.map((culture) => `CulturesToGenerate=${culture}\n`).join("")}[GatherTextStep0]\nCommandletClass=GatherTextFromAssets\n`;

function success<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}

if (mode === "generate") {
	await mkdir(resolve(root, "Config/Localization"), { recursive: true });
	await writeFile(resolve(root, "Config/Localization/Generated.ini"), recipe);
	const po: string[] = ["\uFEFF"];
	const manifest: string[] = [];
	const archive: string[] = [];
	for (let index = 0; index < count; index++) {
		const entry = localizationScaleEntry(index);
		po.push(entry.po);
		manifest.push(
			JSON.stringify({
				Source: { Text: entry.source },
				Keys: [{ Key: entry.key, Path: entry.path }]
			})
		);
		archive.push(
			JSON.stringify({
				Source: { Text: entry.source },
				Translation: { Text: entry.translation },
				Key: entry.key
			})
		);
	}
	const folder = resolve(root, "Content/Localization/Generated");
	await mkdir(resolve(folder, "en"), { recursive: true });
	await writeFile(
		resolve(folder, "Generated.manifest"),
		Buffer.from(
			`\uFEFF{"FormatVersion":1,"Namespace":"Generated","Children":[${manifest.join(",")}]}`,
			"utf16le"
		)
	);
	await writeFile(
		resolve(folder, "en/Generated.archive"),
		Buffer.from(
			`\uFEFF{"FormatVersion":2,"Namespace":"Generated","Children":[${archive.join(",")}]}`,
			"utf16le"
		)
	);
	await writeFile(resolve(folder, "en/Generated.po"), po.join(""));
	for (const culture of cultures.slice(1)) {
		await mkdir(resolve(folder, culture), { recursive: true });
		for (const extension of ["archive", "po"]) {
			await copyFile(
				resolve(folder, `en/Generated.${extension}`),
				resolve(folder, `${culture}/Generated.${extension}`)
			);
		}
	}
	console.log(JSON.stringify({ mode, entries: count, root }));
} else if (mode === "evidence") {
	const target = success(
		discoverLocalizationTargets({
			dashboardText: "",
			configs: [{ relativePath: "Config/Localization/Generated.ini", text: recipe }]
		})
	).targets[0];
	if (target === undefined) throw new Error("Generated target missing.");
	globalThis.gc?.();
	const before = process.memoryUsage().heapUsed;
	const start = performance.now();
	const evidence = await Effect.runPromise(
		Effect.flatMap(LocalizationEvidence, (reader) =>
			reader.read({ projectRoot: root, target })
		).pipe(Effect.provide(LocalizationEvidenceNodeLive))
	);
	const seconds = (performance.now() - start) / 1000;
	globalThis.gc?.();
	if (
		evidence.manifest.status !== "read" ||
		evidence.cultures.some(
			(culture) => culture.po.status !== "read" || culture.archive.status !== "read"
		)
	) {
		throw new Error("The generated target did not load every manifest, archive and PO.");
	}
	console.log(
		JSON.stringify({
			mode,
			node: process.version,
			seconds,
			heapMiB: process.memoryUsage().heapUsed / 2 ** 20,
			retainedMiB: (process.memoryUsage().heapUsed - before) / 2 ** 20,
			cultures: evidence.cultures.map((culture) => ({
				culture: culture.culture,
				po: culture.po.status,
				archive: culture.archive.status
			})),
			manifest: evidence.manifest.status
		})
	);
} else {
	const path = mode === "manifest" ? "Generated.manifest" : `en/Generated.${mode}`;
	const bytes = await readFile(resolve(root, "Content/Localization/Generated", path));
	globalThis.gc?.();
	const start = performance.now();
	const value =
		mode === "po"
			? success(parsePO(bytes))
			: mode === "archive"
				? success(parseArchive(bytes))
				: success(parseManifest(bytes));
	const seconds = (performance.now() - start) / 1000;
	globalThis.gc?.();
	console.log(
		JSON.stringify({
			mode,
			node: process.version,
			bytes: bytes.length,
			seconds,
			heapMiB: process.memoryUsage().heapUsed / 2 ** 20,
			entries: "blocks" in value ? value.blocks.length : value.entries.length
		})
	);
}
