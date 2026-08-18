import { readdir, readFile } from "node:fs/promises";
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

const ProjectDescriptor = Schema.Struct({
	EngineAssociation: Schema.optional(Schema.String)
});

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
>()("@ue-shed/engine-discovery/EngineInstallationDiscovery") {}

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
		const value = yield* readJson(projectDescriptor, "invalid_project_descriptor").pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(ProjectDescriptor)),
			Effect.mapError(() =>
				failure(
					"invalid_project_descriptor",
					"The selected .uproject descriptor has an invalid contract.",
					"Choose a readable Unreal .uproject descriptor.",
					false
				)
			)
		);
		return value.EngineAssociation?.trim() || undefined;
	});
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
