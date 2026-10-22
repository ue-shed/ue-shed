import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Schema } from "effect";

export const corpusOwnershipName = "UEShedGameTextCorpus.ownership.json";
export function filesUnder(root: string): string[] {
	return existsSync(root)
		? readdirSync(root, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => join(entry.parentPath, entry.name))
		: [];
}
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function inside(root: string, path: string) {
	const part = relative(root, path);
	return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** Validate the complete previous receipt before deleting even one byte. Foreign files stop clean. */
export function prepareCorpusOutput(
	projectRoot: string,
	content: string,
	target: string,
	clean: boolean,
	remove = true
) {
	const localization = join(projectRoot, "Content", "Localization", target);
	const config = join(projectRoot, "Config", "Localization", `${target}_Gather.ini`);
	const receipt = join(content, corpusOwnershipName);
	const existing = [
		...filesUnder(content),
		...filesUnder(localization),
		...(existsSync(config) ? [config] : [])
	];
	if (existing.length === 0) return;
	if (!clean) throw new Error("Corpus output exists; pass --clean to replace owned files.");
	if (!existsSync(receipt)) throw new Error("Refusing --clean: no corpus ownership receipt.");
	const value = Schema.decodeUnknownSync(
		Schema.fromJsonString(
			Schema.Struct({
				version: Schema.Literal(1),
				files: Schema.Array(
					Schema.Struct({
						path: Schema.String,
						sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
					})
				)
			})
		)
	)(readFileSync(receipt, "utf8"));
	const owned = new Map<string, string>();
	for (const entry of value.files) {
		const path = resolve(projectRoot, entry.path);
		if (
			!inside(projectRoot, path) ||
			!(inside(content, path) || inside(localization, path) || path === config)
		)
			throw new Error("Ownership path escapes corpus output.");
		owned.set(path, entry.sha256);
	}
	for (const file of existing)
		if (
			file !== receipt &&
			(!owned.has(resolve(file)) || digest(file) !== owned.get(resolve(file)))
		)
			throw new Error(`Refusing --clean: foreign or edited file ${file}`);
	for (const file of owned.keys())
		if (!existsSync(file)) throw new Error(`Owned file is missing: ${file}`);
	if (!remove) return;
	// All recursive targets were checked against the explicit output directories above.
	rmSync(content, { recursive: true, force: true });
	if (existsSync(localization)) rmSync(localization, { recursive: true });
	if (existsSync(config)) rmSync(config);
}

export function writeCorpusOwnership(projectRoot: string, content: string, target: string) {
	const files = [
		...filesUnder(content),
		...filesUnder(join(projectRoot, "Content", "Localization", target)),
		join(projectRoot, "Config", "Localization", `${target}_Gather.ini`)
	];
	writeFileSync(
		join(content, corpusOwnershipName),
		JSON.stringify(
			{
				version: 1,
				files: files
					.filter((file) => !file.endsWith(corpusOwnershipName))
					.map((file) => ({
						path: relative(projectRoot, file).replaceAll("\\", "/"),
						sha256: digest(file)
					}))
			},
			null,
			"\t"
		) + "\n"
	);
}
