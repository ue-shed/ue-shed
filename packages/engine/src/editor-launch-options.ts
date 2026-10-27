import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, Option, Schema } from "effect";

/**
 * A map the editor opens at startup instead of the project's default map, as a long package
 * name such as `/Game/Maps/Arena`. A map that does not exist would silently open the default
 * map, so the launcher checks `/Game` maps and maps in launched plugins on disk first.
 */
export const UnrealStartupMap = Schema.NonEmptyString.check(
	Schema.isMaxLength(1024),
	Schema.isPattern(/^\/[\p{L}\p{N}_]+(?:\/[\p{L}\p{N}_-]+)+$/u)
);
export type UnrealStartupMap = typeof UnrealStartupMap.Type;

/** One literal editor argument; no control characters, so it stays one token. */
export const UnrealEditorArgument = Schema.NonEmptyString.check(
	Schema.isMaxLength(4096),
	Schema.isPattern(/^[^\0-\x1f\x7f]+$/u)
);

/**
 * Launch options shared by the plain launcher and supervised sessions.
 *
 * - `startupMap`: open this map directly instead of the default map.
 * - `logPath`: an absolute path the editor writes this run's log to (`-abslog`); its folder is
 *   created. The result and failures name it.
 * - `sourceControl: "disabled"`: start without connecting to source control (`-SCCProvider=None`)
 *   for this run only; the project's saved provider is unchanged.
 * - `additionalArguments`: other editor switches, such as `-nosplash`, `-nosound`, `-culture=`,
 *   `-ExecCmds=` or a non-Remote Control `-ini:` override. Switches the launcher owns are refused;
 *   see `reservedUnrealEditorArgument`.
 */
export const UnrealEditorLaunchOptionFields = {
	startupMap: Schema.optional(UnrealStartupMap),
	logPath: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(4096))),
	sourceControl: Schema.optional(Schema.Literals(["project", "disabled"])),
	additionalArguments: Schema.optional(
		Schema.Array(UnrealEditorArgument).check(Schema.isMaxLength(64))
	)
};

/** The per-run launch options as plain values; see `UnrealEditorLaunchOptionFields`. */
export interface UnrealEditorLaunchOptions {
	readonly startupMap?: string | undefined;
	readonly logPath?: string | undefined;
	readonly sourceControl?: "project" | "disabled" | undefined;
	readonly additionalArguments?: readonly string[] | undefined;
}

const ownedSwitches = new Map([
	["plugin", "Pass plugins in the launch request."],
	["enableplugins", "Pass plugins in the launch request."],
	["noengineplugins", "It also turns off the engine plugins Remote Control needs."],
	["rcwebcontrolenable", "The launcher configures Remote Control."],
	["rcwebcontroldisable", "The launcher configures Remote Control."],
	["rcwebinterfaceenable", "The launcher configures Remote Control."],
	["rcwebinterfacedisable", "The launcher configures Remote Control."],
	["nullrhi", "It turns Remote Control off."],
	["buildmachine", "It turns Remote Control off."],
	["game", "It starts the game, not the editor."],
	["server", "It starts a server, not the editor."],
	["run", "It runs a commandlet, not the editor."],
	["multiprocess", "It changes how the editor saves and caches."],
	["cmdlinefile", "It reads arguments the launcher cannot check."],
	["abslog", "Use logPath."],
	["unattended", "Use a supervised session's unattended option."],
	["sccprovider", "Use sourceControl."],
	["renderoffscreen", "Use a supervised session's window option."],
	["autodeclinepackagerecovery", "It deletes the project's unsaved-work recovery data."],
	["autoacceptpackagerecovery", "It decides the project's unsaved-work recovery for the user."],
	["livecoding", "The launcher turns Live Coding off for plugin sessions."],
	["map", "Use startupMap; the editor ignores -map=."]
]);

/**
 * Why the launcher refuses `argument` in `additionalArguments`, or undefined when it is
 * allowed. Switches are matched case-insensitively. `enabledPlugins` are the plugin IDs this
 * launch enables, which `-DisablePlugins=` may not name.
 */
export function reservedUnrealEditorArgument(
	argument: string,
	enabledPlugins: readonly string[] = []
): string | undefined {
	if (!argument.startsWith("-"))
		return "Write each switch with a leading -. The launcher passes the project and startup map itself.";
	const match = /^-([A-Za-z0-9_.]+)([=:]?)(.*)$/su.exec(argument);
	if (!match) return "Write each switch as -Name or -Name=value.";
	const name = (match[1] ?? "").toLowerCase();
	const value = match[3] ?? "";
	if (name === "log" && match[2] === "=") return "Use logPath.";
	const owned = ownedSwitches.get(name);
	if (owned !== undefined) return owned;
	if (name === "disableplugins") {
		const enabled = new Set([...enabledPlugins, "RemoteControl"].map((id) => id.toLowerCase()));
		const named = value.split(",").find((id) => enabled.has(id.trim().toLowerCase()));
		return named === undefined
			? undefined
			: `It disables ${named.trim()}, which this launch needs.`;
	}
	if (name === "ini") {
		const ini = value.toLowerCase();
		if (ini.startsWith("remotecontrol:"))
			return "The launcher owns Remote Control settings; use the Remote Control launch options.";
		if (ini.includes("[/script/livecoding.livecodingsettings]"))
			return "The launcher turns Live Coding off for plugin sessions.";
	}
	return undefined;
}

/** Per-run arguments for already checked options, after the plugin and Remote Control ones. */
export function unrealEditorOptionArguments(options: UnrealEditorLaunchOptions): string[] {
	return [
		...(options.logPath === undefined ? [] : [`-abslog=${resolve(options.logPath)}`]),
		...(options.sourceControl === "disabled" ? ["-SCCProvider=None"] : []),
		...(options.additionalArguments ?? [])
	];
}

/** Where a startup map's `.umap` must be, when the launch knows its mount; else undefined. */
export function startupMapFile(
	projectDescriptor: string,
	map: string,
	plugins: readonly { readonly descriptor: string; readonly id: string }[] = []
): string | undefined {
	const [, mount = "", ...rest] = map.split("/");
	const root =
		mount === "Game"
			? dirname(projectDescriptor)
			: plugins.find((plugin) => plugin.id === mount)?.descriptor;
	if (root === undefined) return undefined;
	return join(mount === "Game" ? root : dirname(root), "Content", ...rest) + ".umap";
}

/** A launch option the launcher refused, in the caller's error vocabulary. */
export interface EditorLaunchOptionFailure {
	readonly code: "invalid_request" | "startup_map_missing";
	readonly message: string;
	readonly recovery: string;
	readonly cause?: unknown;
}

/**
 * Checks launch options against the project before spawning: refused switches, a relative log
 * path, and a startup map missing on disk. Creates the log folder.
 */
export const checkEditorLaunchOptions = Effect.fn("UnrealEditor.checkLaunchOptions")(function* (
	projectDescriptor: string,
	options: UnrealEditorLaunchOptions,
	plugins: readonly { readonly descriptor: string; readonly id: string }[] = []
) {
	for (const argument of options.additionalArguments ?? []) {
		const reason = reservedUnrealEditorArgument(
			argument,
			plugins.map(({ id }) => id)
		);
		if (reason !== undefined)
			return yield* Effect.fail<EditorLaunchOptionFailure>({
				code: "invalid_request",
				message: `The editor argument ${argument.split("=")[0]} is not allowed in additionalArguments.`,
				recovery: reason
			});
	}
	if (options.startupMap !== undefined) {
		const file = startupMapFile(projectDescriptor, options.startupMap, plugins);
		if (file !== undefined)
			yield* Effect.tryPromise({
				try: () => access(file),
				catch: (cause): EditorLaunchOptionFailure => ({
					code: "startup_map_missing",
					message: `The startup map ${options.startupMap} does not exist.`,
					recovery:
						"Choose a map that exists in the project, or launch without a startup map.",
					cause
				})
			});
	}
	if (options.logPath !== undefined) {
		const logPath = options.logPath;
		if (!isAbsolute(logPath))
			return yield* Effect.fail<EditorLaunchOptionFailure>({
				code: "invalid_request",
				message: "The editor log path must be absolute.",
				recovery: "Resolve the log path before launching."
			});
		yield* Effect.tryPromise({
			try: () => mkdir(dirname(logPath), { recursive: true }),
			catch: (cause): EditorLaunchOptionFailure => ({
				code: "invalid_request",
				message: `The editor log folder ${dirname(logPath)} cannot be created.`,
				recovery: "Choose a log path in a folder you can write to.",
				cause
			})
		});
	}
});

const PackageRestoreData = Schema.Struct({
	RestoreEnabled: Schema.Boolean,
	Packages: Schema.optionalKey(Schema.Array(Schema.Unknown))
});

/**
 * Whether the editor would offer to restore unsaved work for this project at startup:
 * `Saved/Autosaves/PackageRestoreData.json` (the same file in UE 4.27 and 5.x) is enabled and
 * lists packages. An unattended editor deletes that data without asking, so callers refuse an
 * unattended launch while it is pending.
 */
export const pendingPackageRecovery = Effect.fn("UnrealEditor.pendingPackageRecovery")(function* (
	projectDescriptor: string
) {
	const file = join(dirname(projectDescriptor), "Saved", "Autosaves", "PackageRestoreData.json");
	const text = yield* Effect.promise(() => readFile(file, "utf8").catch(() => undefined));
	if (text === undefined) return false;
	const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageRestoreData))(
		text
	).pipe(Effect.option);
	// An unreadable file is treated as pending: losing recovery data is the worse mistake.
	if (Option.isNone(data)) return true;
	return data.value.RestoreEnabled && (data.value.Packages?.length ?? 0) > 0;
});
