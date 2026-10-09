import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";
import { readScaleRecipe, repositoryPath } from "./game-text-scale-options.ts";

/** Recipe-specific token census, not a JSON/PO parser. Memory is bounded by one read chunk. */
async function census(path: string, encoding: BufferEncoding, tokens: readonly string[]) {
	const counts = Object.fromEntries(tokens.map((token) => [token, 0]));
	const decoder = new StringDecoder(encoding);
	const overlap = Math.max(...tokens.map((token) => token.length)) - 1;
	let carry = "";
	let bytes = 0;
	let prefix = "";
	let suffix = "";
	const consume = (chunk: string, final: boolean) => {
		const text = carry + chunk;
		const end = final ? text.length : Math.max(0, text.length - overlap);
		for (const token of tokens) {
			let position = text.indexOf(token);
			while (position >= 0 && position < end) {
				counts[token]++;
				position = text.indexOf(token, position + token.length);
			}
		}
		carry = text.slice(end);
	};
	for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
		bytes += chunk.length;
		const decoded = decoder.write(chunk);
		if (prefix.length < 64) prefix = (prefix + decoded).slice(0, 64);
		suffix = (suffix + decoded.slice(-64)).slice(-64);
		consume(decoded, false);
	}
	consume(decoder.end(), true);
	return { bytes, counts, prefix, suffix };
}

export async function validateGameTextScale(project: string) {
	const root = repositoryPath(project);
	const started = performance.now();
	const recipe = await readScaleRecipe(root);
	const files: { path: string; kind: string; bytes: number; counts: Record<string, number> }[] =
		[];
	const bytesByKind = {
		manifest: 0,
		archives: 0,
		po: 0,
		events: 0,
		config: 0
	};
	const check = async (
		relative: string,
		kind: keyof typeof bytesByKind,
		encoding: BufferEncoding,
		expected: Record<string, number>,
		ending: string,
		beginning: string
	) => {
		const path = resolve(root, relative);
		const size = (await stat(path)).size;
		const result = await census(path, encoding, Object.keys(expected));
		if (
			size !== result.bytes ||
			!result.prefix.startsWith(beginning) ||
			!result.suffix.endsWith(ending)
		)
			throw new Error(`${relative}: invalid size or framing.`);
		for (const [token, count] of Object.entries(expected))
			if (result.counts[token] !== count)
				throw new Error(
					`${relative}: ${token}: expected ${count}, found ${result.counts[token]}.`
				);
		bytesByKind[kind] += size;
		files.push({ path: relative, kind, bytes: size, counts: result.counts });
	};
	const base = "Content/Localization/Generated";
	await check(
		`${base}/Generated.manifest`,
		"manifest",
		"utf16le",
		{ '"Source":{"Text":': recipe.keys, '"Key":': recipe.keys },
		"]}]}",
		'\uFEFF{"FormatVersion":1'
	);
	for (const culture of recipe.cultures) {
		await check(
			`${base}/${culture}/Generated.archive`,
			"archives",
			"utf16le",
			{
				'"Source":{"Text":': recipe.keys,
				'"Translation":{"Text":': recipe.keys,
				'"Key":': recipe.keys
			},
			"]}]}",
			'\uFEFF{"FormatVersion":2'
		);
		await check(
			`${base}/${culture}/Generated.po`,
			"po",
			"utf8",
			{
				"\r\nmsgctxt ": recipe.keys,
				"\r\nmsgid ": recipe.keys,
				"\r\nmsgstr ": recipe.keys + 1
			},
			"\r\n\r\n",
			'\uFEFFmsgid ""'
		);
	}
	await check(
		"saved-text.ndjson",
		"events",
		"utf8",
		{
			'{"event":"text_occurrence"': recipe.occurrences,
			'{"event":"text_coverage_gap"': recipe.gaps,
			'{"event":"text_package"': recipe.packages,
			'{"event":"text_summary"': 1,
			'"status":"partial"': recipe.partialPackages,
			"\n": recipe.occurrences + recipe.gaps + recipe.packages + 1
		},
		"}\n",
		'{"event":"text_occurrence"'
	);
	for (const relative of [
		"scale.json",
		"Config/DefaultEditor.ini",
		"Config/Localization/Generated_Gather.ini",
		"Config/UEShed/Localization/Generated.review.json"
	]) {
		const metadata = await stat(resolve(root, relative));
		if (!metadata.isFile() || metadata.size === 0)
			throw new Error(`${relative}: missing file content.`);
		bytesByKind.config += metadata.size;
	}
	return {
		schemaVersion: 1,
		status: "passed",
		recipe,
		files,
		bytesByKind,
		bytes: Object.values(bytesByKind).reduce((sum, size) => sum + size, 0),
		seconds: (performance.now() - started) / 1000,
		validation:
			"Streamed token counts and BOM/framing; no whole-file parsing. Sizes are logical file bytes."
	};
}
