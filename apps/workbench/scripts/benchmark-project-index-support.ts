import { access, readFile, readdir, realpath, rename, stat, utimes } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export const DISPOSABLE_MARKER_FILE = ".ue-shed-project-index-benchmark-disposable";
export const DISPOSABLE_MARKER_CONTENT = "UE_SHED_PROJECT_INDEX_BENCHMARK_DISPOSABLE=1\n";

export interface DisposableMutationTarget {
	readonly packagePath: string;
	readonly relatedPaths: readonly string[];
	readonly root: string;
}

async function packageFiles(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return packageFiles(path);
			if (!entry.isFile()) return [];
			const extension = extname(entry.name).toLowerCase();
			return extension === ".uasset" || extension === ".umap" ? [path] : [];
		})
	);
	return nested.flat();
}

async function existingCompanions(packagePath: string): Promise<readonly string[]> {
	const extension = extname(packagePath);
	const stem = basename(packagePath, extension);
	const candidates = [".uexp", ".ubulk", ".uptnl"].map((candidateExtension) =>
		join(dirname(packagePath), `${stem}${candidateExtension}`)
	);
	const existing = await Promise.all(
		candidates.map(async (candidate) => {
			try {
				await access(candidate);
				return candidate;
			} catch {
				return undefined;
			}
		})
	);
	return existing.filter((candidate): candidate is string => candidate !== undefined);
}

export async function resolveDisposableMutationTarget(args: {
	readonly primaryProjectRoot: string;
	readonly mutationProjectRoot: string;
}): Promise<DisposableMutationTarget> {
	const [primaryRoot, mutationRoot] = await Promise.all([
		realpath(args.primaryProjectRoot),
		realpath(args.mutationProjectRoot)
	]);
	if (primaryRoot.toLowerCase() === mutationRoot.toLowerCase()) {
		throw new Error("--mutation-project must be distinct from the read-only --project.");
	}
	const marker = await readFile(join(mutationRoot, DISPOSABLE_MARKER_FILE), "utf8").catch(
		() => ""
	);
	if (marker !== DISPOSABLE_MARKER_CONTENT) {
		throw new Error(
			`--mutation-project must contain ${DISPOSABLE_MARKER_FILE} with the documented exact content.`
		);
	}
	const content = join(mutationRoot, "Content");
	const packages = [...(await packageFiles(content))].sort((left, right) =>
		left.localeCompare(right)
	);
	const packagePath = packages[0];
	if (packagePath === undefined) {
		throw new Error("--mutation-project must contain at least one .uasset or .umap package.");
	}
	return {
		packagePath,
		relatedPaths: [packagePath, ...(await existingCompanions(packagePath))],
		root: mutationRoot
	};
}

export async function withChangedPackage<A>(
	target: DisposableMutationTarget,
	operation: () => Promise<A>
): Promise<A> {
	const details = await stat(target.packagePath);
	await utimes(target.packagePath, details.atime, new Date(details.mtimeMs + 60_000));
	try {
		return await operation();
	} finally {
		await utimes(target.packagePath, details.atime, details.mtime);
	}
}

export async function withDeletedPackage<A>(
	target: DisposableMutationTarget,
	operation: () => Promise<A>
): Promise<A> {
	const moved: Array<{ readonly backup: string; readonly original: string }> = [];
	try {
		for (const original of target.relatedPaths) {
			const backup = `${original}.ue-shed-benchmark-backup-${process.pid}`;
			await access(backup).then(
				() => {
					throw new Error(
						`Refusing to overwrite an existing benchmark backup: ${backup}`
					);
				},
				() => undefined
			);
			await rename(original, backup);
			moved.push({ backup, original });
		}
		return await operation();
	} finally {
		for (const entry of moved.reverse()) await rename(entry.backup, entry.original);
	}
}
