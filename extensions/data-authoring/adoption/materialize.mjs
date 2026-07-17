import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const adoptionDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(adoptionDirectory, "../../..");

function fail(message) {
	throw new Error(`Data Authoring materialization failed: ${message}`);
}

function option(name) {
	const prefix = `--${name}=`;
	const inline = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const targetArgument = option("target");
const sourceCommit = option("source-commit");
const accent = option("accent");
if (!targetArgument) fail("pass --target <empty-directory>");
if (!sourceCommit || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
	fail("pass --source-commit <40-character-git-commit>");
}
if (accent !== undefined && !/^#[0-9a-f]{6}$/i.test(accent)) {
	fail("--accent must be a six-digit hex color such as #ff6b6b");
}

const targetRoot = resolve(targetArgument);
const relativeTarget = relative(targetRoot, sourceRoot);
if (relativeTarget === "" || (!relativeTarget.startsWith("..") && !isAbsolute(relativeTarget))) {
	fail("the target must not contain the source kit");
}

await mkdir(targetRoot, { recursive: true });
if ((await readdir(targetRoot)).length > 0) fail("the target directory must be empty");

const manifestPath = join(sourceRoot, "extensions", "data-authoring", "adoption.manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== 2 || manifest.slice !== "data-authoring") {
	fail("unsupported manifest identity or schema version");
}

async function copyRelative(entry, destinationRoot = targetRoot) {
	const source = resolve(sourceRoot, entry);
	const relativeSource = relative(sourceRoot, source);
	if (relativeSource.startsWith("..") || isAbsolute(relativeSource)) {
		fail(`entry escapes source kit: ${entry}`);
	}
	const destination = join(destinationRoot, entry);
	await mkdir(dirname(destination), { recursive: true });
	await cp(source, destination, { recursive: (await stat(source)).isDirectory() });
}

const templateRoot = resolve(sourceRoot, manifest.consumerTemplate);
for (const entry of await readdir(templateRoot)) {
	await cp(join(templateRoot, entry), join(targetRoot, entry), { recursive: true });
}
for (const entry of [...manifest.copy.kernel, ...manifest.copy.owned]) await copyRelative(entry);

if (accent !== undefined) {
	const themePath = join(targetRoot, "packages", "ui-theme", "src", "themes.stylex.ts");
	const theme = await readFile(themePath, "utf8");
	const divergentTheme = theme.replace('colorAccent: "#b7e26d"', `colorAccent: "${accent}"`);
	if (divergentTheme === theme) fail("could not find the applied theme accent to replace");
	await writeFile(themePath, divergentTheme);
}

const metadataRoot = join(targetRoot, ".ue-shed", "data-authoring");
await mkdir(metadataRoot, { recursive: true });
await cp(manifestPath, join(metadataRoot, "adoption.manifest.json"));
await cp(
	resolve(sourceRoot, manifest.provenance.schema),
	join(metadataRoot, "provenance.schema.json")
);

const provenance = JSON.parse(
	await readFile(resolve(sourceRoot, manifest.provenance.template), "utf8")
);
provenance.source.commit = sourceCommit.toLowerCase();
provenance.ownership.kernel = manifest.copy.kernel;
provenance.ownership.owned = manifest.copy.owned;
await writeFile(
	join(targetRoot, manifest.provenance.target),
	`${JSON.stringify(provenance, null, 2)}\n`
);

const reportPath = join(targetRoot, "ADOPTION-REPORT.md");
const report = (await readFile(reportPath, "utf8"))
	.replaceAll("__SOURCE_COMMIT__", sourceCommit.toLowerCase())
	.replaceAll("__TARGET__", targetRoot);
await writeFile(reportPath, report);

console.log(`Materialized Data Authoring into ${targetRoot}`);
