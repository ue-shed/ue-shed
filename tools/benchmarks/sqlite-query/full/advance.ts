/** Modify only generated localization documents, then exercise the shipping incremental join. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { SharedIndex } from "../../../../packages/game-text/src/shared-index.ts";
import { readJoinedTarget } from "../../../../packages/game-text/src/joined-target-reader.ts";
import { runJoinIn } from "../../../../scripts/columnar-join.test-support.ts";
import { GameTextIndexBuilder } from "../../../../packages/game-text/src/index-builder.ts";
import { nativeIndexBuilderLayer } from "../../../../packages/game-text/src/native-index-builder.ts";
import { localizationLineFingerprint } from "../../../../packages/game-text/src/localization-review.ts";
import { LocalizationKeyChangePair } from "../../../../packages/game-text/src/localization-key-changes.ts";
import { LocalizationReviewFile } from "../../../../packages/localization/dist/browser.js";
import { withNative } from "./native.ts";
import { digest } from "./evaluate.ts";
import { json } from "./model.ts";

const root = resolve(process.argv[2]!);
const input = JSON.parse(await readFile(resolve(root, "input.json"), "utf8"));
if (input.target !== "Cases" || !root.toLowerCase().includes("test-results\\sqlite-full\\"))
	throw new Error("This mutator only accepts its generated semantic fixture");
const projectRoot: string = input.settings.configuration.projectKey;
const inspect = () =>
	runJoinIn(
		projectRoot,
		root,
		"Cases",
		Effect.gen(function* () {
			const store = yield* SharedIndex;
			const manifest = yield* store.inspect();
			const joined = yield* readJoinedTarget(yield* store.open());
			return { manifest, meta: joined.meta };
		})
	);
const previous = await inspect();
const executable = resolve("target/release/uasset.exe");
await withNative(input, executable, async (query) => {
	const lines = await Effect.runPromise(query.readLocalizationLines());
	const base = lines.find((line) => line.identity?.key === "Base")!;
	const before = digest(json(base));
	const review = Schema.decodeUnknownSync(LocalizationReviewFile)({
		schemaVersion: 1,
		target: "Cases",
		acceptedFindings: [],
		records: lines
			.filter((line) => line.identity && ["Base", "U"].includes(line.identity.key))
			.map((line) => ({
				culture: "de",
				namespace: line.identity!.namespace,
				key: line.identity!.key,
				flags:
					line.identity!.key === "U" ? ["machine_translated"] : ["reviewed", "proofread"],
				fingerprint: localizationLineFingerprint(
					line,
					line.cultures.find((mark) => mark.culture === "de")!
				),
				by: "generated-reviewer",
				at: "2026-11-06T00:00:00Z"
			}))
	});
	const pairs = [
		Schema.decodeUnknownSync(LocalizationKeyChangePair)({
			from: { namespace: "UI", key: "Old" },
			to: { namespace: "UI", key: "New" },
			match: "same_place",
			sourceChanged: true,
			previousSource: "Old text",
			translations: [{ culture: "de", translation: "Old translation 変換" }]
		})
	];
	const manifestPath = resolve(projectRoot, "Cases.manifest");
	const manifest = JSON.parse(
		(await readFile(manifestPath)).toString("utf16le").replace(/^\uFEFF/u, "")
	);
	manifest.Subnamespaces = manifest.Subnamespaces.filter(
		(entry: { Children: { Keys: { Key: string }[] }[] }) =>
			!["F", "Added-漢字-1", "Added-漢字-2"].includes(entry.Children[0]!.Keys[0]!.Key)
	);
	for (const key of ["Added-漢字-1", "Added-漢字-2"])
		manifest.Subnamespaces.push({
			Namespace: "Σ識別子",
			Children: [
				{
					Source: {
						Text: "New 漢字 مرحبا \u{f0000} 😀",
						extra: { empty: {}, nested: [null, false, 7, ""] }
					},
					Keys: [
						{
							Key: key,
							Path: "Source/Generated/Example.cpp:7",
							DevNotes: "Translation notes 😀",
							MetaData: {
								Info: { Comment: "Keep nested evidence" },
								extra: { empty: {} }
							}
						}
					]
				}
			]
		});
	await writeFile(manifestPath, Buffer.from("\uFEFF" + JSON.stringify(manifest), "utf16le"));
	const poPath = resolve(projectRoot, "de.po");
	const poBytes = await readFile(poPath);
	const poEncoding = poBytes[0] === 255 && poBytes[1] === 254 ? "utf16le" : "utf8";
	const po = poBytes.toString(poEncoding);
	if (!po.includes("de Translation Base"))
		throw new Error("Unexpected generated PO; refusing another edit");
	await writeFile(
		poPath,
		Buffer.from(po.replace("de Translation Base", "Changed PO 漢字 Σ"), poEncoding)
	);
	const join = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const builder = yield* GameTextIndexBuilder;
				return yield* builder.withSession(
					{ configuration: input.settings.configuration },
					Effect.gen(function* () {
						for (const [relativePath, format] of [
							["Cases.manifest", "manifest"],
							["de.po", "po"]
						] as const)
							yield* builder.importLocalizationFile({
								projectRoot,
								cacheRoot: root,
								sharedTargetKey: "Cases",
								relativePath,
								format
							});
						return yield* builder.refreshJoinedTarget({
							...previous.meta.input,
							review,
							keyChangePairs: pairs
						});
					})
				);
			})
		).pipe(
			Effect.provide(
				nativeIndexBuilderLayer({ executable, timeoutMs: 120000, catalogTimeoutMs: 120000 })
			)
		)
	);
	const fresh = await inspect();
	const pinned = await Effect.runPromise(query.localizationFocus(base.id));
	if (digest(json(pinned)) !== before)
		throw new Error("Published native update changed a pinned old reader");
	await writeFile(
		resolve(root, "advance.json"),
		JSON.stringify({
			join,
			pinnedOldReader: true,
			before: previous.manifest.generation,
			after: fresh.manifest.generation
		})
	);
	await writeFile(resolve(root, "input-before.json"), JSON.stringify(input));
	await writeFile(
		resolve(root, "input.json"),
		JSON.stringify({
			...input,
			rawLineCount: fresh.meta.count,
			settings: {
				...input.settings,
				generation: fresh.manifest.generation,
				joinedKey: fresh.manifest.active.joined
			}
		})
	);
	console.log(JSON.stringify({ join, pinnedOldReader: true }));
});
