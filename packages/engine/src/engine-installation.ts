import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Config, Context, Effect, Layer, Schema } from "effect";

export const EngineVersion = Schema.Struct({
	major: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	patch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type EngineVersion = typeof EngineVersion.Type;

const EngineBuildVersion = Schema.Struct({
	MajorVersion: Schema.Int,
	MinorVersion: Schema.Int,
	PatchVersion: Schema.optional(Schema.Int)
});

export const ProjectDescriptor = Schema.Struct({
	EngineAssociation: Schema.optional(Schema.String)
});
export interface ProjectDescriptor extends Schema.Schema.Type<typeof ProjectDescriptor> {}

const registeredBuildsKey = "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds";

export const EngineInstallation = Schema.Struct({
	root: Schema.NonEmptyString,
	version: EngineVersion
});
export type EngineInstallation = typeof EngineInstallation.Type;

export interface EngineInstallationRequest {
	readonly projectDescriptor: string;
	readonly explicitRoot?: string;
}

export class EngineInstallationError extends Schema.TaggedErrorClass<EngineInstallationError>()(
	"EngineInstallationError",
	{
		code: Schema.Literals([
			"invalid_project_descriptor",
			"invalid_engine_root",
			"engine_not_found",
			"engine_ambiguous"
		]),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		candidates: Schema.optionalKey(Schema.Array(Schema.String))
	}
) {}

export interface EngineInstallationDiscoveryApi {
	readonly resolve: (
		request: EngineInstallationRequest
	) => Effect.Effect<EngineInstallation, EngineInstallationError>;
}

export class EngineInstallationDiscovery extends Context.Service<
	EngineInstallationDiscovery,
	EngineInstallationDiscoveryApi
>()("@ue-shed/engine/EngineInstallationDiscovery") {}

function failure(
	code: EngineInstallationError["code"],
	message: string,
	recovery: string,
	retrySafe = true,
	candidates?: readonly string[]
): EngineInstallationError {
	return new EngineInstallationError({
		code,
		message,
		recovery,
		retrySafe,
		...(candidates === undefined ? undefined : { candidates: [...candidates] })
	});
}

function readJson(path: string, code: EngineInstallationError["code"]) {
	return Effect.tryPromise({
		try: (signal) => readFile(path, { encoding: "utf8", signal }).then(JSON.parse),
		catch: () =>
			failure(
				code,
				code === "invalid_project_descriptor"
					? "The selected .uproject descriptor is unreadable or invalid JSON."
					: "The selected Unreal installation has no readable Build.version.",
				code === "invalid_project_descriptor"
					? "Choose a readable Unreal .uproject descriptor."
					: "Choose an Unreal installation root containing Engine/Build/Build.version.",
				false
			)
	});
}

function withoutJsonComments(contents: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < contents.length; index += 1) {
		const character = contents[index]!;
		const next = contents[index + 1];
		if (lineComment) {
			if (character === "\n" || character === "\r") {
				lineComment = false;
				result += character;
			} else result += " ";
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				result += "  ";
				index += 1;
				blockComment = false;
			} else result += character === "\n" || character === "\r" ? character : " ";
			continue;
		}
		if (inString) {
			result += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			result += character;
		} else if (character === "/" && next === "/") {
			lineComment = true;
			result += "  ";
			index += 1;
		} else if (character === "/" && next === "*") {
			blockComment = true;
			result += "  ";
			index += 1;
		} else result += character;
	}
	return result;
}

function withoutTrailingCommas(contents: string): string {
	let result = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < contents.length; index += 1) {
		const character = contents[index]!;
		if (inString) {
			result += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		if (character === ",") {
			let nextIndex = index + 1;
			while (/\s/u.test(contents[nextIndex] ?? "")) nextIndex += 1;
			if (contents[nextIndex] === "]" || contents[nextIndex] === "}") continue;
		}
		result += character;
	}
	return result;
}

export function parseUnrealProjectDescriptor(contents: string): ProjectDescriptor {
	const withoutBom = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
	return Schema.decodeUnknownSync(ProjectDescriptor)(
		JSON.parse(withoutTrailingCommas(withoutJsonComments(withoutBom)))
	);
}

function installationAt(root: string): Effect.Effect<EngineInstallation, EngineInstallationError> {
	const normalized = resolve(root);
	return Effect.gen(function* () {
		const value = yield* readJson(
			join(normalized, "Engine", "Build", "Build.version"),
			"invalid_engine_root"
		).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(EngineBuildVersion)),
			Effect.mapError(() =>
				failure(
					"invalid_engine_root",
					"The selected Unreal Build.version has an invalid version contract.",
					"Choose a complete Unreal installation root.",
					false
				)
			)
		);
		return {
			root: normalized,
			version: {
				major: value.MajorVersion,
				minor: value.MinorVersion,
				patch: value.PatchVersion ?? 0
			}
		};
	});
}

function associationOf(
	projectDescriptor: string
): Effect.Effect<string | undefined, EngineInstallationError> {
	return Effect.gen(function* () {
		if (extname(projectDescriptor).toLocaleLowerCase() !== ".uproject") {
			return yield* failure(
				"invalid_project_descriptor",
				"Engine discovery requires an explicit .uproject descriptor.",
				"Choose the project descriptor rather than an ambient directory.",
				false
			);
		}
		const value = yield* Effect.tryPromise({
			try: (signal) =>
				readFile(projectDescriptor, { encoding: "utf8", signal }).then(
					parseUnrealProjectDescriptor
				),
			catch: () =>
				failure(
					"invalid_project_descriptor",
					"The selected .uproject descriptor is unreadable or invalid JSON.",
					"Choose a readable Unreal .uproject descriptor.",
					false
				)
		});
		return value.EngineAssociation?.trim() || undefined;
	});
}

function registeredEngineRoot(association: string | undefined): Effect.Effect<string | undefined> {
	if (process.platform !== "win32" || association === undefined) {
		return Effect.succeed(undefined);
	}
	return Effect.callback<string | undefined>((resume) => {
		const child = execFile(
			"reg.exe",
			["query", registeredBuildsKey, "/v", association],
			{ encoding: "utf8", windowsHide: true },
			(error, stdout) => resume(Effect.succeed(error ? undefined : stdout))
		);
		return Effect.sync(() => child.kill());
	}).pipe(
		Effect.map((output) => {
			if (output === undefined) return undefined;
			for (const line of output.split(/\r?\n/u)) {
				const match = line.match(/^\s*(.*?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.+?)\s*$/u);
				if (match?.[1] === association && match[2]) return resolve(match[2]);
			}
			return undefined;
		})
	);
}

function versionLabel(version: EngineVersion): string {
	return `${version.major}.${version.minor}`;
}

function discoverStandardInstallations(options: {
	readonly association?: string;
	readonly programFiles: string;
}): Effect.Effect<readonly EngineInstallation[], EngineInstallationError> {
	if (process.platform !== "win32") return Effect.succeed([]);
	const epicRoot = join(options.programFiles, "Epic Games");
	return Effect.tryPromise({
		try: () => readdir(epicRoot, { withFileTypes: true }),
		catch: () =>
			failure(
				"engine_not_found",
				"Standard engine locations are unavailable.",
				"Pass an explicit engine root."
			)
	}).pipe(
		Effect.catch(() => Effect.succeed([])),
		Effect.flatMap((entries) =>
			Effect.forEach(
				entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("UE_")),
				(entry) => Effect.option(installationAt(join(epicRoot, entry.name))),
				{ concurrency: 4 }
			)
		),
		Effect.map((candidates) =>
			candidates.flatMap((candidate) =>
				candidate._tag === "Some" &&
				(options.association === undefined ||
					versionLabel(candidate.value.version) === options.association)
					? [candidate.value]
					: []
			)
		)
	);
}

const programFiles = Config.string("ProgramFiles").pipe(Config.withDefault("C:\\Program Files"));

export const EngineInstallationDiscoveryLive = Layer.effect(
	EngineInstallationDiscovery,
	Effect.gen(function* () {
		const configuredProgramFiles = yield* programFiles;
		const resolveInstallation = Effect.fn("EngineInstallationDiscovery.resolve")(function* (
			request: EngineInstallationRequest
		) {
			if (request.explicitRoot !== undefined)
				return yield* installationAt(request.explicitRoot);
			const association = yield* associationOf(resolve(request.projectDescriptor));
			const registeredRoot = yield* registeredEngineRoot(association);
			if (registeredRoot !== undefined) {
				const registered = yield* Effect.option(installationAt(registeredRoot));
				if (registered._tag === "Some") return registered.value;
			}
			const candidates = yield* discoverStandardInstallations({
				programFiles: configuredProgramFiles,
				...(association === undefined ? undefined : { association })
			});
			if (candidates.length === 1) return candidates[0]!;
			if (candidates.length > 1) {
				return yield* failure(
					"engine_ambiguous",
					`More than one installed engine matches ${association ?? "the project"}.`,
					"Pass an explicit engine root.",
					false,
					candidates.map((candidate) => versionLabel(candidate.version))
				);
			}
			return yield* failure(
				"engine_not_found",
				association === undefined
					? "The project does not identify a discoverable Unreal installation."
					: `No installed Unreal ${association} engine was discovered.`,
				"Pass an explicit engine root.",
				true
			);
		});
		return EngineInstallationDiscovery.of({ resolve: resolveInstallation });
	})
);

export function makeEngineInstallationDiscoveryTestLayer(
	resolveInstallation: EngineInstallationDiscoveryApi["resolve"]
): Layer.Layer<EngineInstallationDiscovery> {
	return Layer.succeed(
		EngineInstallationDiscovery,
		EngineInstallationDiscovery.of({ resolve: resolveInstallation })
	);
}

export function projectLabel(projectDescriptor: string): string {
	return basename(projectDescriptor, extname(projectDescriptor));
}

export function projectRootOf(projectDescriptor: string): string {
	return dirname(projectDescriptor);
}
