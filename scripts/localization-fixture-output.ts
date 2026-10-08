import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function contains(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Keep an unchanged output snapshot beside the disposable run's version-specific evidence. */
export function retainLocalizationFixtureOutput(
	fixtureRoot: string,
	evidenceDirectory: string,
	version: string
): string {
	if (!/^\d+\.\d+$/u.test(version)) throw new Error("Invalid localization engine version.");
	const source = resolve(fixtureRoot, "Content", "Localization", "FixtureGame");
	const evidenceRoot = resolve(evidenceDirectory);
	const name = `ue${version}-output`;
	const destination = resolve(evidenceRoot, name);
	if (
		relative(evidenceRoot, destination) !== name ||
		contains(source, destination) ||
		contains(destination, source)
	) {
		throw new Error("Localization output snapshots must be separate from generated output.");
	}
	// Check the source before replacing a previous snapshot, and delete only the checked child.
	if (!statSync(source).isDirectory()) throw new Error("Localization output is not a directory.");
	mkdirSync(evidenceRoot, { recursive: true });
	rmSync(destination, { recursive: true, force: true });
	cpSync(source, destination, { recursive: true });
	return destination;
}
