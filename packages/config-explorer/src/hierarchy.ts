import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { ConfigFileAccess, ConfigFileAccessError } from "./file-access.js";
import type { ConfigSource } from "./schema.js";

export interface ConfigProject {
	readonly root: string;
	readonly descriptor: string;
	readonly label: string;
}

export interface ConfigHierarchyLayer {
	readonly name: string;
	readonly path: string;
	readonly source: ConfigSource;
}

function invalidProject(message: string): ConfigFileAccessError {
	return new ConfigFileAccessError({
		operation: "stat",
		message,
		retrySafe: false
	});
}

export function resolveConfigProject(
	project: string
): Effect.Effect<ConfigProject, ConfigFileAccessError, ConfigFileAccess> {
	return Effect.gen(function* () {
		const files = yield* ConfigFileAccess;
		const selected = resolve(project);
		const isFile = yield* files
			.isFile(selected)
			.pipe(Effect.catch(() => Effect.succeed(false)));
		if (isFile) {
			if (extname(selected).toLocaleLowerCase() !== ".uproject") {
				return yield* Effect.fail(
					invalidProject("Project selection is not a .uproject file.")
				);
			}
			return {
				root: dirname(selected),
				descriptor: selected,
				label: basename(selected, extname(selected))
			};
		}
		const entries = yield* files.list(selected);
		const descriptors = entries.filter(
			(entry) =>
				entry.kind === "file" && extname(entry.name).toLocaleLowerCase() === ".uproject"
		);
		if (descriptors.length !== 1) {
			return yield* Effect.fail(
				invalidProject(
					descriptors.length === 0
						? "Project root contains no .uproject descriptor."
						: "Project root contains more than one .uproject descriptor."
				)
			);
		}
		const descriptor = join(selected, descriptors[0]!.name);
		return {
			root: selected,
			descriptor,
			label: basename(descriptor, extname(descriptor))
		};
	});
}

function logicalPath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function layer(
	name: string,
	scope: ConfigSource["scope"],
	root: string,
	path: string
): ConfigHierarchyLayer {
	return { name, path, source: { scope, path: logicalPath(root, path) } };
}

type RootScope = "engine" | "project";

interface Template {
	readonly name: string;
	readonly scope: RootScope;
	readonly relativePath: string;
	readonly expanded: boolean;
	readonly platform: boolean;
}

function expandedPaths(options: {
	readonly engineRoot: string;
	readonly projectRoot: string;
	readonly template: Template;
	readonly platform?: string;
}): readonly { readonly name: string; readonly path: string }[] {
	const root =
		options.template.scope === "engine"
			? join(options.engineRoot, "Engine")
			: options.projectRoot;
	const sourcePath = options.template.relativePath.replaceAll(
		"{PLATFORM}",
		options.platform ?? ""
	);
	const base = join(root, ...sourcePath.split("/"));
	if (!options.template.expanded) return [{ name: options.template.name, path: base }];

	const restricted = ["NotForLicensees", "NoRedist", "LimitedAccess"].map((kind) => ({
		name: `${options.template.name}.Restricted.${kind}`,
		path: join(root, "Restricted", kind, ...sourcePath.split("/"))
	}));
	if (!options.template.platform || options.platform === undefined) {
		return [{ name: options.template.name, path: base }, ...restricted];
	}
	const afterPlatform = sourcePath.replace(`Config/${options.platform}/`, "");
	const platformExtension = {
		name: `${options.template.name}.PlatformExtension`,
		path: join(root, "Platforms", options.platform, "Config", ...afterPlatform.split("/"))
	};
	const restrictedExtensions = ["NotForLicensees", "NoRedist", "LimitedAccess"].map((kind) => ({
		name: `${options.template.name}.Restricted.${kind}.PlatformExtension`,
		path: join(
			root,
			"Restricted",
			kind,
			"Platforms",
			options.platform!,
			"Config",
			...afterPlatform.split("/")
		)
	}));
	return [
		{ name: options.template.name, path: base },
		...restricted,
		platformExtension,
		...restrictedExtensions
	];
}

export function buildConfigHierarchy(options: {
	readonly engineRoot: string;
	readonly projectRoot: string;
	readonly family: string;
	readonly platforms: readonly string[];
}): readonly ConfigHierarchyLayer[] {
	const type = options.family;
	const templates: readonly Template[] = [
		{
			name: "AbsoluteBase",
			scope: "engine",
			relativePath: "Config/Base.ini",
			expanded: false,
			platform: false
		},
		{
			name: "Base",
			scope: "engine",
			relativePath: `Config/Base${type}.ini`,
			expanded: true,
			platform: false
		},
		{
			name: "BasePlatform",
			scope: "engine",
			relativePath: `Config/{PLATFORM}/Base{PLATFORM}${type}.ini`,
			expanded: true,
			platform: true
		},
		{
			name: "ProjectDefault",
			scope: "project",
			relativePath: `Config/Default${type}.ini`,
			expanded: true,
			platform: false
		},
		{
			name: "ProjectGenerated",
			scope: "project",
			relativePath: `Config/Generated${type}.ini`,
			expanded: true,
			platform: false
		},
		{
			name: "EnginePlatform",
			scope: "engine",
			relativePath: `Config/{PLATFORM}/{PLATFORM}${type}.ini`,
			expanded: true,
			platform: true
		},
		{
			name: "ProjectPlatform",
			scope: "project",
			relativePath: `Config/{PLATFORM}/{PLATFORM}${type}.ini`,
			expanded: true,
			platform: true
		},
		{
			name: "ProjectPlatformGenerated",
			scope: "project",
			relativePath: `Config/{PLATFORM}/Generated{PLATFORM}${type}.ini`,
			expanded: true,
			platform: true
		}
	];
	return templates.flatMap((template) => {
		const platforms = template.platform ? options.platforms : [undefined];
		return Array.from(
			{ length: template.expanded ? (template.platform ? 8 : 4) : 1 },
			(_, index) =>
				platforms.flatMap((platform) =>
					expandedPaths({
						engineRoot: options.engineRoot,
						projectRoot: options.projectRoot,
						template,
						...(platform === undefined ? {} : { platform })
					}).filter((_, expansion) => expansion === index)
				)
		)
			.flat()
			.map((candidate) => {
				const root = template.scope === "engine" ? options.engineRoot : options.projectRoot;
				return layer(candidate.name, template.scope, root, candidate.path);
			});
	});
}

function iniParent(text: string): string | undefined {
	let section = "";
	for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1);
			continue;
		}
		if (section.toLocaleLowerCase() !== "datadrivenplatforminfo") continue;
		const equals = line.indexOf("=");
		if (equals === -1 || line.slice(0, equals).trim().toLocaleLowerCase() !== "iniparent")
			continue;
		return line.slice(equals + 1).trim();
	}
	return undefined;
}

function platformMetadataPaths(options: {
	readonly engineRoot: string;
	readonly projectRoot: string;
	readonly platform: string;
}): readonly string[] {
	return [
		join(
			options.engineRoot,
			"Engine",
			"Config",
			options.platform,
			"DataDrivenPlatformInfo.ini"
		),
		join(
			options.engineRoot,
			"Engine",
			"Platforms",
			options.platform,
			"Config",
			"DataDrivenPlatformInfo.ini"
		),
		join(options.projectRoot, "Config", options.platform, "DataDrivenPlatformInfo.ini"),
		join(
			options.projectRoot,
			"Platforms",
			options.platform,
			"Config",
			"DataDrivenPlatformInfo.ini"
		)
	];
}

export function resolvePlatformChain(options: {
	readonly engineRoot: string;
	readonly projectRoot: string;
	readonly platform: string;
}): Effect.Effect<readonly string[], ConfigFileAccessError, ConfigFileAccess> {
	return Effect.gen(function* () {
		const files = yield* ConfigFileAccess;
		const visiting = new Set<string>();
		const chain: string[] = [];
		let current: string | undefined = options.platform;
		while (current !== undefined && current !== "") {
			const normalized = current.toLocaleLowerCase();
			if (visiting.has(normalized)) {
				return yield* Effect.fail(
					invalidProject("Platform IniParent chain contains a cycle.")
				);
			}
			visiting.add(normalized);
			let found = false;
			let parent: string | undefined;
			for (const path of platformMetadataPaths({ ...options, platform: current })) {
				if (!(yield* files.exists(path))) continue;
				found = true;
				const value = yield* files.readText(path);
				const candidate = iniParent(value);
				if (candidate !== undefined) parent = candidate;
			}
			if (!found) {
				return yield* Effect.fail(
					invalidProject(
						"The selected platform has no DataDrivenPlatformInfo.ini evidence."
					)
				);
			}
			chain.unshift(current);
			current = parent;
		}
		return chain;
	});
}
