import { access, lstat, readdir, readFile, realpath, stat, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	defaultCustodianPolicy,
	projectTargetDefinitions,
	resolvePolicyDocument,
	type ProjectTargetDefinition
} from "./policy.js";
import type {
	CustodianDiagnostic,
	CustodianEngineReport,
	CustodianFreshness,
	CustodianPlan,
	CustodianPlanItem,
	CustodianPolicy,
	CustodianProjectReport,
	CustodianRefusal,
	CustodianReport,
	CustodianScanRequest,
	CustodianTarget,
	EngineTargetKey
} from "./schema.js";

const gibibyte = 1024 ** 3;
const maximumDiscoveryDepth = 8;
const scanConcurrency = 4;
const policyFilename = ".ueclean.json";
const logStamp = /-backup-(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})\.log$/iu;
const excludedProjectComponents = new Set(["templates", "samples"]);
const discoveryPruneDirectories = new Set(
	[
		"Intermediate",
		"Saved",
		"Binaries",
		"DerivedDataCache",
		"Content",
		"Source",
		"Config",
		"node_modules",
		".git",
		".svn",
		"Windows",
		"WinSxS",
		"$Recycle.Bin",
		"System Volume Information",
		"AppData",
		"Library"
	].map((value) => value.toLocaleLowerCase())
);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface EngineTargetDefinition {
	readonly key: EngineTargetKey;
	readonly relativePath: string;
	readonly description: string;
	readonly rebuildCost: string;
	readonly risk: CustodianTarget["risk"];
	readonly defaultOn: boolean;
	readonly sourceBuildOnly: boolean;
}

const engineTargetDefinitions: readonly EngineTargetDefinition[] = [
	{
		key: "engine_ddc",
		relativePath: "Engine/DerivedDataCache",
		description: "Engine-wide derived data cache",
		rebuildCost: "Re-derived on the next editor start",
		risk: "low",
		defaultOn: true,
		sourceBuildOnly: false
	},
	{
		key: "engine_logs",
		relativePath: "Engine/Saved/Logs",
		description: "Engine logs",
		rebuildCost: "No rebuild cost; historical diagnostics are lost",
		risk: "low",
		defaultOn: true,
		sourceBuildOnly: false
	},
	{
		key: "engine_crashes",
		relativePath: "Engine/Saved/Crashes",
		description: "Engine crash reports",
		rebuildCost: "No rebuild cost; crash evidence is lost",
		risk: "low",
		defaultOn: true,
		sourceBuildOnly: false
	},
	{
		key: "engine_intermediate",
		relativePath: "Engine/Intermediate",
		description: "Engine build intermediates",
		rebuildCost: "The next engine compile becomes a full rebuild",
		risk: "high",
		defaultOn: false,
		sourceBuildOnly: true
	},
	{
		key: "engine_binaries",
		relativePath: "Engine/Binaries",
		description: "Compiled engine binaries",
		rebuildCost: "The editor cannot launch until the engine is fully rebuilt",
		risk: "critical",
		defaultOn: false,
		sourceBuildOnly: true
	}
];

interface DiscoveryResult {
	readonly descriptors: readonly string[];
	readonly engineManifests: readonly string[];
	readonly diagnostics: readonly CustodianDiagnostic[];
}

interface EngineIdentity {
	readonly root: string;
	readonly version: string;
	readonly buildKind: "installed" | "source";
}

export interface NodeScannerDependencies {
	readonly deviceOf: (path: string) => Promise<number>;
	readonly freeBytesAt: (path: string) => Promise<number>;
}

const defaultNodeScannerDependencies: NodeScannerDependencies = {
	deviceOf: async (path) => (await stat(path)).dev,
	freeBytesAt: async (path) => {
		const volume = await statfs(path);
		return Math.max(0, Math.floor(volume.bavail * volume.bsize));
	}
};

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason ?? new Error("Custodian scan was cancelled.");
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function discover(
	root: string,
	rootDevice: number,
	signal: AbortSignal,
	dependencies: NodeScannerDependencies
): Promise<DiscoveryResult> {
	const descriptors: string[] = [];
	const engineManifests: string[] = [];
	const diagnostics: CustodianDiagnostic[] = [];
	const queue: Array<{ readonly path: string; readonly depth: number }> = [
		{ path: root, depth: 0 }
	];
	for (let index = 0; index < queue.length; index++) {
		throwIfAborted(signal);
		const current = queue[index];
		if (current === undefined) continue;
		let entries;
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch (cause) {
			diagnostics.push({
				code: "discovery_incomplete",
				message: `Could not inspect directory: ${cause instanceof Error ? cause.message : String(cause)}`,
				path: current.path
			});
			continue;
		}
		for (const entry of entries) {
			const path = join(current.path, entry.name);
			if (entry.isFile()) {
				if (entry.name.toLocaleLowerCase().endsWith(".uproject")) descriptors.push(path);
				if (
					entry.name === "Build.version" &&
					basename(current.path) === "Build" &&
					basename(dirname(current.path)) === "Engine"
				) {
					engineManifests.push(path);
				}
				continue;
			}
			if (!entry.isDirectory() || current.depth >= maximumDiscoveryDepth) continue;
			if (discoveryPruneDirectories.has(entry.name.toLocaleLowerCase())) continue;
			try {
				if ((await dependencies.deviceOf(path)) !== rootDevice) {
					diagnostics.push({
						code: "cross_volume_skipped",
						message:
							"Directory is on a different filesystem than the explicit scan root.",
						path
					});
					continue;
				}
			} catch (cause) {
				diagnostics.push({
					code: "discovery_incomplete",
					message: `Could not identify directory filesystem: ${cause instanceof Error ? cause.message : String(cause)}`,
					path
				});
				continue;
			}
			queue.push({ path, depth: current.depth + 1 });
		}
	}
	return { descriptors, engineManifests, diagnostics };
}

function isWithin(path: string, root: string): boolean {
	const fromRoot = relative(root, path);
	return (
		fromRoot === "" ||
		(!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
	);
}

async function identifyEngines(
	manifests: readonly string[],
	signal: AbortSignal
): Promise<readonly EngineIdentity[]> {
	const found = new Map<string, EngineIdentity>();
	for (const manifest of manifests) {
		throwIfAborted(signal);
		const root = dirname(dirname(dirname(manifest)));
		const hasBuildMachinery =
			(await isDirectory(join(root, "Engine", "Source"))) ||
			(await isDirectory(join(root, "Engine", "Build", "BatchFiles")));
		if (!hasBuildMachinery) continue;
		try {
			const document: unknown = JSON.parse(await readFile(manifest, "utf8"));
			if (!isRecord(document)) continue;
			const version = document;
			const label = ["MajorVersion", "MinorVersion", "PatchVersion"]
				.map((key) => (typeof version[key] === "number" ? String(version[key]) : "0"))
				.join(".");
			const build = join(root, "Engine", "Build");
			const installedMarker = await access(join(build, "InstalledBuild.txt")).then(
				() => true,
				() => false
			);
			const sourceMarker = await access(join(build, "SourceDistribution.txt")).then(
				() => true,
				() => false
			);
			const canonical = await realpath(root);
			found.set(canonical.toLocaleLowerCase(), {
				root,
				version: label,
				buildKind: !installedMarker && sourceMarker ? "source" : "installed"
			});
		} catch {
			continue;
		}
	}
	return [...found.values()].sort((left, right) => left.root.localeCompare(right.root));
}

async function newestMtime(root: string, signal: AbortSignal): Promise<number | undefined> {
	if (!(await isDirectory(root))) return undefined;
	let newest: number | undefined;
	const queue = [root];
	for (let index = 0; index < queue.length; index++) {
		throwIfAborted(signal);
		const directory = queue[index];
		if (directory === undefined) continue;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				queue.push(path);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const modified = (await stat(path)).mtimeMs;
				if (newest === undefined || modified > newest) newest = modified;
			} catch {
				continue;
			}
		}
	}
	return newest;
}

async function fileMtime(path: string): Promise<number | undefined> {
	try {
		const metadata = await stat(path);
		return metadata.isFile() ? metadata.mtimeMs : undefined;
	} catch {
		return undefined;
	}
}

function newestTimestamp(values: readonly (number | undefined)[]): number | undefined {
	return values.reduce<number | undefined>(
		(current, value) =>
			value === undefined
				? current
				: current === undefined || value > current
					? value
					: current,
		undefined
	);
}

interface ProjectPlugin {
	readonly descriptor: string;
	readonly root: string;
}

async function discoverProjectPlugins(
	projectRoot: string,
	signal: AbortSignal
): Promise<readonly ProjectPlugin[]> {
	const pluginsRoot = join(projectRoot, "Plugins");
	if (!(await isDirectory(pluginsRoot))) return [];
	const plugins: ProjectPlugin[] = [];
	const queue: Array<{ readonly path: string; readonly depth: number }> = [
		{ path: pluginsRoot, depth: 0 }
	];
	for (let index = 0; index < queue.length; index++) {
		throwIfAborted(signal);
		const current = queue[index];
		if (current === undefined) continue;
		let entries;
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch {
			continue;
		}
		const descriptor = entries
			.filter(
				(entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".uplugin")
			)
			.map((entry) => join(current.path, entry.name))
			.sort((left, right) => left.localeCompare(right))[0];
		if (descriptor !== undefined) {
			plugins.push({ descriptor, root: current.path });
			continue;
		}
		if (current.depth >= maximumDiscoveryDepth) continue;
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			if (discoveryPruneDirectories.has(entry.name.toLocaleLowerCase())) continue;
			queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
		}
	}
	return plugins.sort((left, right) => left.root.localeCompare(right.root));
}

async function containsBuildRule(root: string, signal: AbortSignal): Promise<boolean> {
	if (!(await isDirectory(root))) return false;
	const queue = [root];
	for (let index = 0; index < queue.length; index++) {
		throwIfAborted(signal);
		const directory = queue[index];
		if (directory === undefined) continue;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".build.cs")) return true;
			if (entry.isDirectory()) queue.push(join(directory, entry.name));
		}
	}
	return false;
}

async function pluginDeclaresNativeModules(descriptor: string): Promise<boolean> {
	try {
		const document: unknown = JSON.parse(await readFile(descriptor, "utf8"));
		if (!isRecord(document)) return true;
		const modules = document["Modules"];
		if (modules === undefined) return false;
		return !Array.isArray(modules) || modules.length > 0;
	} catch {
		// Descriptor uncertainty must preserve binaries rather than broaden reclaim authority.
		return true;
	}
}

async function hasNativeCode(
	projectRoot: string,
	plugins: readonly ProjectPlugin[],
	signal: AbortSignal
): Promise<boolean> {
	if (await isDirectory(join(projectRoot, "Source"))) return true;
	for (const plugin of plugins) {
		if (await containsBuildRule(join(plugin.root, "Source"), signal)) return true;
		if (await pluginDeclaresNativeModules(plugin.descriptor)) return true;
	}
	return false;
}

async function newestLogSession(savedLogs: string): Promise<number | undefined> {
	let entries;
	try {
		entries = await readdir(savedLogs, { withFileTypes: true });
	} catch {
		return undefined;
	}
	let newest: number | undefined;
	for (const entry of entries) {
		const match = logStamp.exec(entry.name);
		if (match === null) continue;
		const parts = match.slice(1).map(Number);
		if (parts.length !== 6 || parts.some((part) => !Number.isInteger(part))) continue;
		const [year, month, day, hour, minute, second] = parts;
		if (
			year === undefined ||
			month === undefined ||
			day === undefined ||
			hour === undefined ||
			minute === undefined ||
			second === undefined
		) {
			continue;
		}
		const stamp = Date.UTC(year, month - 1, day, hour, minute, second);
		if (!Number.isFinite(stamp)) continue;
		if (newest === undefined || stamp > newest) newest = stamp;
	}
	return newest;
}

async function measureFreshness(
	projectRoot: string,
	descriptor: string,
	plugins: readonly ProjectPlugin[],
	now: number,
	signal: AbortSignal
): Promise<CustodianFreshness> {
	const projectAuthored = await Promise.all([
		fileMtime(descriptor),
		...["Content", "Source", "Config"].map((name) =>
			newestMtime(join(projectRoot, name), signal)
		),
		...plugins.flatMap((plugin) => [
			fileMtime(plugin.descriptor),
			...["Content", "Source", "Config"].map((name) =>
				newestMtime(join(plugin.root, name), signal)
			)
		])
	]);
	const authoredAtMs = newestTimestamp(projectAuthored);
	const lastSessionAtMs = await newestLogSession(join(projectRoot, "Saved", "Logs"));
	const effectiveAtMs = newestTimestamp([authoredAtMs, lastSessionAtMs]);
	return {
		...(authoredAtMs === undefined ? {} : { authoredAt: new Date(authoredAtMs).toISOString() }),
		...(lastSessionAtMs === undefined
			? {}
			: { lastSessionAt: new Date(lastSessionAtMs).toISOString() }),
		...(effectiveAtMs === undefined
			? {}
			: {
					effectiveAt: new Date(effectiveAtMs).toISOString(),
					ageDays: Math.max(0, (now - effectiveAtMs) / 86_400_000)
				}),
		mtimesLookRewritten:
			authoredAtMs !== undefined &&
			lastSessionAtMs !== undefined &&
			authoredAtMs - lastSessionAtMs > 30 * 86_400_000
	};
}

interface DirectoryMeasurement {
	readonly bytes: number;
	readonly crossVolumePaths: readonly string[];
	readonly hardlinkExcludedBytes: number;
}

async function measureDirectory(options: {
	readonly path: string;
	readonly expectedDevice: number;
	readonly signal: AbortSignal;
	readonly dependencies: NodeScannerDependencies;
}): Promise<DirectoryMeasurement> {
	let bytes = 0;
	let hardlinkExcludedBytes = 0;
	const crossVolumePaths: string[] = [];
	const queue = [options.path];
	for (let index = 0; index < queue.length; index++) {
		throwIfAborted(options.signal);
		const directory = queue[index];
		if (directory === undefined) continue;
		if ((await options.dependencies.deviceOf(directory)) !== options.expectedDevice) {
			crossVolumePaths.push(directory);
			continue;
		}
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const child = join(directory, entry.name);
			if (entry.isDirectory()) {
				queue.push(child);
				continue;
			}
			if (!entry.isFile()) continue;
			const metadata = await lstat(child);
			if (metadata.nlink > 1) {
				// A read-only inventory cannot prove that every other name will be removed by a
				// future plan. Excluding the allocation is conservative and prevents both
				// cross-target double counting and credit while a retained link survives.
				hardlinkExcludedBytes += metadata.size;
				continue;
			}
			bytes += metadata.size;
		}
	}
	return { bytes, crossVolumePaths, hardlinkExcludedBytes };
}

async function loadPolicy(projectRoot: string): Promise<{
	readonly policy: CustodianPolicy;
	readonly diagnostic?: CustodianDiagnostic;
}> {
	const path = join(projectRoot, policyFilename);
	try {
		const contents = await readFile(path, "utf8");
		const resolution = resolvePolicyDocument(JSON.parse(contents));
		return {
			policy: resolution.policy,
			...(resolution.error === undefined
				? {}
				: {
						diagnostic: {
							code: "invalid_policy" as const,
							message: resolution.error,
							path
						}
					})
		};
	} catch (cause) {
		if (
			typeof cause === "object" &&
			cause !== null &&
			"code" in cause &&
			cause.code === "ENOENT"
		) {
			return { policy: defaultCustodianPolicy };
		}
		return {
			policy: { ...defaultCustodianPolicy, enabled: false, targets: [] },
			diagnostic: {
				code: "invalid_policy",
				message: `Could not read ${policyFilename}: ${cause instanceof Error ? cause.message : String(cause)}`,
				path
			}
		};
	}
}

async function projectCandidates(
	projectRoot: string,
	policy: CustodianPolicy,
	isCpp: boolean
): Promise<readonly { readonly definition: ProjectTargetDefinition; readonly path: string }[]> {
	const selected = new Set(policy.targets);
	const candidates: Array<{
		readonly definition: ProjectTargetDefinition;
		readonly path: string;
	}> = [];
	for (const definition of projectTargetDefinitions) {
		if (!selected.has(definition.key)) continue;
		if (
			isCpp &&
			policy.keepBinariesForCpp &&
			(definition.key === "binaries" || definition.key === "plugin_binaries")
		) {
			continue;
		}
		if (definition.wildcard === "plugin") {
			let plugins;
			try {
				plugins = await readdir(join(projectRoot, "Plugins"), { withFileTypes: true });
			} catch {
				continue;
			}
			const tail = definition.relativePath.endsWith("Intermediate")
				? "Intermediate"
				: "Binaries";
			for (const plugin of plugins) {
				candidates.push({
					definition,
					path: join(projectRoot, "Plugins", plugin.name, tail)
				});
			}
			continue;
		}
		candidates.push({ definition, path: join(projectRoot, definition.relativePath) });
	}
	return candidates;
}

function refusal(
	projectRoot: string,
	path: string,
	code: CustodianRefusal["code"],
	reason: string
): CustodianRefusal {
	return {
		path,
		relativePath: relative(projectRoot, path).split(sep).join("/"),
		code,
		reason
	};
}

async function measureProjectTargets(options: {
	readonly projectRoot: string;
	readonly policy: CustodianPolicy;
	readonly isCpp: boolean;
	readonly now: number;
	readonly expectedDevice: number;
	readonly signal: AbortSignal;
	readonly dependencies: NodeScannerDependencies;
}): Promise<{
	readonly targets: readonly CustodianTarget[];
	readonly refusals: readonly CustodianRefusal[];
	readonly diagnostics: readonly CustodianDiagnostic[];
}> {
	const targets: CustodianTarget[] = [];
	const refusals: CustodianRefusal[] = [];
	const diagnostics: CustodianDiagnostic[] = [];
	const canonicalRoot = await realpath(options.projectRoot);
	const candidates = await projectCandidates(options.projectRoot, options.policy, options.isCpp);
	for (const candidate of candidates) {
		throwIfAborted(options.signal);
		if (!(await isDirectory(candidate.path))) continue;
		let canonical;
		try {
			canonical = await realpath(candidate.path);
		} catch (cause) {
			refusals.push(
				refusal(
					options.projectRoot,
					candidate.path,
					"unreadable",
					cause instanceof Error ? cause.message : String(cause)
				)
			);
			continue;
		}
		if (!isWithin(canonical, canonicalRoot)) {
			refusals.push(
				refusal(
					options.projectRoot,
					candidate.path,
					"outside_root",
					"Symlink resolves outside the named project."
				)
			);
			continue;
		}
		const relativePath = relative(options.projectRoot, candidate.path).split(sep).join("/");
		const parts = relativePath.split("/");
		if (
			relativePath === "" ||
			["Content", "Source", "Config", "Plugins", "Saved"].includes(relativePath) ||
			parts.includes("SaveGames")
		) {
			refusals.push(
				refusal(
					options.projectRoot,
					candidate.path,
					"protected_path",
					"Authored content, project roots, plugin roots, and save data are protected."
				)
			);
			continue;
		}
		if (candidate.definition.minimumAgeDays > 0) {
			const newestTargetAt = await newestMtime(candidate.path, options.signal);
			const targetAgeDays =
				newestTargetAt === undefined
					? undefined
					: Math.max(0, (options.now - newestTargetAt) / 86_400_000);
			if (
				targetAgeDays === undefined ||
				targetAgeDays < candidate.definition.minimumAgeDays
			) {
				continue;
			}
		}
		try {
			const measurement = await measureDirectory({
				path: candidate.path,
				expectedDevice: options.expectedDevice,
				signal: options.signal,
				dependencies: options.dependencies
			});
			if (measurement.crossVolumePaths.length > 0) {
				refusals.push(
					refusal(
						options.projectRoot,
						candidate.path,
						"different_volume",
						"Target contains storage on a different filesystem than the scan root."
					)
				);
				continue;
			}
			if (measurement.hardlinkExcludedBytes > 0) {
				diagnostics.push({
					code: "hardlink_excluded",
					message:
						`${measurement.hardlinkExcludedBytes} byte(s) have multiple names and ` +
						"were conservatively excluded from reclaim estimates.",
					path: candidate.path
				});
			}
			targets.push({
				key: candidate.definition.key,
				path: candidate.path,
				relativePath,
				bytes: measurement.bytes,
				description: candidate.definition.description,
				rebuildCost: candidate.definition.rebuildCost,
				risk: candidate.definition.risk
			});
		} catch (cause) {
			diagnostics.push({
				code: "target_unreadable",
				message: cause instanceof Error ? cause.message : String(cause),
				path: candidate.path
			});
		}
	}
	targets.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
	return { targets, refusals, diagnostics };
}

async function mapConcurrent<A, B>(
	values: readonly A[],
	concurrency: number,
	map: (value: A) => Promise<B>
): Promise<readonly B[]> {
	const results: B[] = [];
	results.length = values.length;
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, async () => {
			while (cursor < values.length) {
				const index = cursor++;
				const value = values[index];
				if (value !== undefined) results[index] = await map(value);
			}
		})
	);
	return results;
}

async function scanProject(options: {
	readonly descriptor: string;
	readonly now: number;
	readonly expectedDevice: number;
	readonly signal: AbortSignal;
	readonly dependencies: NodeScannerDependencies;
}): Promise<CustodianProjectReport> {
	const root = dirname(options.descriptor);
	let engineAssociation = "not specified";
	const diagnostics: CustodianDiagnostic[] = [];
	try {
		const document: unknown = JSON.parse(await readFile(options.descriptor, "utf8"));
		if (isRecord(document)) {
			const association = document.EngineAssociation;
			if (typeof association === "string" && association.trim() !== "") {
				engineAssociation = association.trim();
			}
		}
	} catch (cause) {
		diagnostics.push({
			code: "descriptor_unreadable",
			message: cause instanceof Error ? cause.message : String(cause),
			path: options.descriptor
		});
	}
	const loadedPolicy = await loadPolicy(root);
	if (loadedPolicy.diagnostic !== undefined) diagnostics.push(loadedPolicy.diagnostic);
	const plugins = await discoverProjectPlugins(root, options.signal);
	const freshness = await measureFreshness(
		root,
		options.descriptor,
		plugins,
		options.now,
		options.signal
	);
	const isCpp = await hasNativeCode(root, plugins, options.signal);
	const measured = await measureProjectTargets({
		projectRoot: root,
		policy: loadedPolicy.policy,
		isCpp,
		now: options.now,
		expectedDevice: options.expectedDevice,
		signal: options.signal,
		dependencies: options.dependencies
	});
	diagnostics.push(...measured.diagnostics);
	const reclaimableBytes = measured.targets.reduce((total, target) => total + target.bytes, 0);
	const eligibility =
		loadedPolicy.diagnostic?.code === "invalid_policy"
			? ({ kind: "invalid_policy" } as const)
			: !loadedPolicy.policy.enabled
				? ({ kind: "opted_out" } as const)
				: reclaimableBytes === 0
					? ({ kind: "empty" } as const)
					: freshness.ageDays === undefined && loadedPolicy.policy.minAgeDays > 0
						? ({ kind: "unknown_age" } as const)
						: freshness.ageDays !== undefined &&
							  freshness.ageDays < loadedPolicy.policy.minAgeDays
							? ({
									kind: "recent",
									eligibleAfterDays:
										loadedPolicy.policy.minAgeDays - freshness.ageDays
								} as const)
							: ({ kind: "candidate" } as const);
	return {
		kind: "project",
		name: basename(options.descriptor, ".uproject"),
		root,
		descriptor: options.descriptor,
		engineAssociation,
		isCpp,
		policy: loadedPolicy.policy,
		freshness,
		eligibility,
		targets: measured.targets,
		refusals: measured.refusals,
		diagnostics,
		reclaimableBytes
	};
}

async function scanEngine(options: {
	readonly engine: EngineIdentity;
	readonly expectedDevice: number;
	readonly signal: AbortSignal;
	readonly dependencies: NodeScannerDependencies;
}): Promise<CustodianEngineReport> {
	const { engine } = options;
	const targets: CustodianTarget[] = [];
	const refusals: CustodianRefusal[] = [];
	const diagnostics: CustodianDiagnostic[] = [];
	for (const definition of engineTargetDefinitions) {
		throwIfAborted(options.signal);
		const path = join(engine.root, ...definition.relativePath.split("/"));
		if (!(await isDirectory(path))) continue;
		if (definition.sourceBuildOnly && engine.buildKind === "installed") {
			refusals.push({
				path,
				relativePath: definition.relativePath,
				code: "installed_engine",
				reason: "Precompiled install: this is engine product, not rebuildable output."
			});
			continue;
		}
		if (!definition.defaultOn) continue;
		try {
			const measurement = await measureDirectory({
				path,
				expectedDevice: options.expectedDevice,
				signal: options.signal,
				dependencies: options.dependencies
			});
			if (measurement.crossVolumePaths.length > 0) {
				refusals.push({
					path,
					relativePath: definition.relativePath,
					code: "different_volume",
					reason: "Target contains storage on a different filesystem than the scan root."
				});
				continue;
			}
			if (measurement.hardlinkExcludedBytes > 0) {
				diagnostics.push({
					code: "hardlink_excluded",
					message:
						`${measurement.hardlinkExcludedBytes} byte(s) have multiple names and ` +
						"were conservatively excluded from reclaim estimates.",
					path
				});
			}
			targets.push({
				key: definition.key,
				path,
				relativePath: definition.relativePath,
				bytes: measurement.bytes,
				description: definition.description,
				rebuildCost: definition.rebuildCost,
				risk: definition.risk
			});
		} catch (cause) {
			diagnostics.push({
				code: "target_unreadable",
				message: cause instanceof Error ? cause.message : String(cause),
				path
			});
		}
	}
	targets.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
	return {
		kind: "engine",
		name: `UE ${engine.version}`,
		root: engine.root,
		version: engine.version,
		buildKind: engine.buildKind,
		targets,
		refusals,
		diagnostics,
		reclaimableBytes: targets.reduce((total, target) => total + target.bytes, 0)
	};
}

function makePlan(options: {
	readonly projects: readonly CustodianProjectReport[];
	readonly engines: readonly CustodianEngineReport[];
	readonly freeBytes: number;
	readonly ignorePressure: boolean;
}): CustodianPlan {
	const thresholdGb =
		options.projects.length === 0
			? defaultCustodianPolicy.minFreeGb
			: Math.max(...options.projects.map(({ policy }) => policy.minFreeGb));
	const thresholdBytes = Math.round(thresholdGb * gibibyte);
	const eligible: CustodianPlanItem[] = [
		...options.projects
			.filter(({ eligibility }) => eligibility.kind === "candidate")
			.map(({ kind, name, root, reclaimableBytes: bytes, targets }) => ({
				kind,
				name,
				root,
				bytes,
				targets
			})),
		...options.engines
			.filter(({ reclaimableBytes }) => reclaimableBytes > 0)
			.map(({ kind, name, root, reclaimableBytes: bytes, targets }) => ({
				kind,
				name,
				root,
				bytes,
				targets
			}))
	].sort((left, right) => right.bytes - left.bytes || left.root.localeCompare(right.root));
	if (!options.ignorePressure && options.freeBytes >= thresholdBytes) {
		return {
			status: "pressure_satisfied",
			freeBytes: options.freeBytes,
			thresholdBytes,
			projectedFreeBytes: options.freeBytes,
			reclaimableBytes: 0,
			items: []
		};
	}
	if (eligible.length === 0) {
		return {
			status: "nothing_eligible",
			freeBytes: options.freeBytes,
			thresholdBytes,
			projectedFreeBytes: options.freeBytes,
			reclaimableBytes: 0,
			items: []
		};
	}
	const items: CustodianPlanItem[] = [];
	let projectedFreeBytes = options.freeBytes;
	for (const item of eligible) {
		if (!options.ignorePressure && projectedFreeBytes >= thresholdBytes) break;
		items.push(item);
		projectedFreeBytes += item.bytes;
	}
	return {
		status: items.length === 0 ? "nothing_eligible" : "ready",
		freeBytes: options.freeBytes,
		thresholdBytes,
		projectedFreeBytes,
		reclaimableBytes: items.reduce((total, item) => total + item.bytes, 0),
		items
	};
}

export async function scanCustodian(
	request: CustodianScanRequest,
	signal: AbortSignal,
	dependencies: NodeScannerDependencies = defaultNodeScannerDependencies
): Promise<CustodianReport> {
	const root = resolve(request.root);
	const rootStat = await stat(root);
	if (!rootStat.isDirectory()) throw new Error(`Scan root is not a directory: ${root}`);
	const rootDevice = await dependencies.deviceOf(root);
	const now = Date.now();
	const discovery = await discover(root, rootDevice, signal, dependencies);
	const engines = await identifyEngines(discovery.engineManifests, signal);
	const canonicalEngineRoots = await Promise.all(engines.map(({ root }) => realpath(root)));
	const descriptors: string[] = [];
	const seen = new Set<string>();
	for (const descriptor of discovery.descriptors) {
		throwIfAborted(signal);
		const canonical = await realpath(descriptor);
		const components = canonical.split(sep).map((part) => part.toLocaleLowerCase());
		if (components.some((part) => excludedProjectComponents.has(part))) continue;
		if (canonicalEngineRoots.some((engineRoot) => isWithin(canonical, engineRoot))) continue;
		const identity = canonical.toLocaleLowerCase();
		if (seen.has(identity)) continue;
		seen.add(identity);
		descriptors.push(descriptor);
	}
	const [projects, engineReports] = await Promise.all([
		mapConcurrent(descriptors, scanConcurrency, (descriptor) =>
			scanProject({
				descriptor,
				now,
				expectedDevice: rootDevice,
				signal,
				dependencies
			})
		),
		mapConcurrent(engines, scanConcurrency, (engine) =>
			scanEngine({ engine, expectedDevice: rootDevice, signal, dependencies })
		)
	]);
	const freeBytes = await dependencies.freeBytesAt(root);
	const sortedProjects = [...projects].sort((left, right) => left.name.localeCompare(right.name));
	const sortedEngines = [...engineReports].sort((left, right) =>
		left.root.localeCompare(right.root)
	);
	const totalReclaimableBytes = [...sortedProjects, ...sortedEngines].reduce(
		(total, report) => total + report.reclaimableBytes,
		0
	);
	return {
		schemaVersion: 1,
		root,
		measuredAt: new Date(now).toISOString(),
		freeBytes,
		totalReclaimableBytes,
		projects: sortedProjects,
		engines: sortedEngines,
		diagnostics: discovery.diagnostics,
		plan: makePlan({
			projects: sortedProjects,
			engines: sortedEngines,
			freeBytes,
			ignorePressure: request.ignorePressure ?? false
		}),
		destructiveOperationsAvailable: false
	};
}
