import type { LocalizationFileAccess } from "@ue-shed/localization";
import type { Effect, Layer, Stream } from "effect";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import type { GameTextCodeSource } from "./index-contract.js";

/**
 * The project a host has selected. The workspace never chooses or changes the project; it reads
 * the host's selection and refuses to publish a scan once the selection or its generation moved.
 */
export type GameTextWorkspaceProjectState =
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly error: { readonly message: string; readonly recovery: string };
	  }
	| {
			readonly status: "ready";
			readonly project: { readonly projectRoot: string; readonly generation?: number };
	  };

export type { GameTextWorkspaceProgress } from "./workspace-progress.js";

/**
 * The host's own project scan, as the workspace reads it: while it is `enumerating` or
 * `scanning`, the workspace reports it as `project_enumerating` or `project_scanning`, with its
 * counts. Other fields a host's progress carries are ignored.
 */
export interface GameTextWorkspaceProjectProgress {
	readonly phase: "idle" | "enumerating" | "scanning" | "ready" | "failed";
	readonly completed: number;
	readonly total: number;
}

/** A failure a host reports from one of its hooks, in words a user can act on. */
export interface GameTextWorkspaceHostFailure {
	/** Use `already_exists` when an exclusive create refuses to replace existing bytes. */
	readonly code?: string;
	readonly message: string;
	readonly recovery: string;
}

/**
 * Host-owned selected-project port. Workspace reads and refreshes this selection, checks its
 * generation before publication, and uses its committed candidates and progress without
 * introducing a second project picker.
 */
export interface GameTextWorkspaceProject {
	/** The selected project, as the host last published it. */
	readonly current: () => Effect.Effect<GameTextWorkspaceProjectState>;
	/** Re-reads the selected project from disk before a scan. */
	readonly refresh: () => Effect.Effect<GameTextWorkspaceProjectState>;
	/** The committed package inventory a scan reads, with the generation it belongs to. */
	readonly candidates: () => Effect.Effect<
		{ readonly generation: number; readonly summary: { readonly projectRoot: string } },
		GameTextWorkspaceHostFailure
	>;
	/** The host's own project progress, shown while the host enumerates or scans the project. */
	readonly progress: () => Effect.Effect<GameTextWorkspaceProjectProgress>;
	/**
	 * Each change to the host's project progress, so the workspace's progress follows it without
	 * polling. A host without one is read when Game Text's own progress changes.
	 */
	readonly progressChanges?: () => Stream.Stream<unknown>;
}

/**
 * A host file-selection result. cancelled is an ordinary outcome; a selected path does not
 * change the workspace's active project.
 */
export type GameTextWorkspaceFileChoice =
	| { readonly status: "selected"; readonly path: string }
	| { readonly status: "cancelled" };

/**
 * Host-facing file-dialog filter. Extensions omit the dot; a filter guides selection and does
 * not replace format validation at the read boundary.
 */
export interface GameTextWorkspaceFileFilter {
	readonly name: string;
	readonly extensions: readonly string[];
}

/**
 * Where the workspace reads and writes files that are not localization files. A desktop host shows
 * dialogs; a headless host answers with fixed paths or `cancelled`.
 */
export interface GameTextWorkspaceFileHooks {
	readonly chooseFile: (options: {
		readonly title: string;
		readonly filters?: readonly GameTextWorkspaceFileFilter[];
	}) => Effect.Effect<GameTextWorkspaceFileChoice, GameTextWorkspaceHostFailure>;
	readonly chooseSaveFile: (options: {
		readonly title: string;
		readonly defaultPath?: string;
		readonly filters?: readonly GameTextWorkspaceFileFilter[];
	}) => Effect.Effect<GameTextWorkspaceFileChoice, GameTextWorkspaceHostFailure>;
	readonly readFile: (
		path: string,
		options?: { readonly maxBytes?: number }
	) => Effect.Effect<Uint8Array, GameTextWorkspaceHostFailure>;
	/** Reads a file under a directory, refusing paths that leave it. */
	readonly readFileWithin: (
		directory: string,
		relativePath: string,
		options?: { readonly maxBytes?: number }
	) => Effect.Effect<Uint8Array, GameTextWorkspaceHostFailure>;
	/**
	 * The writable-file hook: every rules file, report, line export and investigation file the
	 * workspace writes goes through it, so a host can check a file out, refuse it or redirect it.
	 * The host creates parent directories
	 * when its storage needs them, and must honor exclusive creation without replacing existing bytes.
	 */
	readonly writeFile: (
		path: string,
		bytes: Uint8Array,
		/** `exclusive` refuses to replace an existing file. */
		options?: { readonly maxBytes?: number; readonly exclusive?: boolean }
	) => Effect.Effect<void, GameTextWorkspaceHostFailure>;
}

/** Everything a host supplies to run the Game Text workspace. */
export interface GameTextWorkspaceHost {
	readonly project: GameTextWorkspaceProject;
	readonly files: GameTextWorkspaceFileHooks;
	/**
	 * Rules location: the project-relative path of the project's rules file, which starter rules
	 * are written to and loaded from. Defaults to `GAME_TEXT_RULES_RELATIVE_PATH`.
	 */
	readonly rulesRelativePath?: string;
	/** Policy: the rules file **Create rules file** writes. Defaults to `STARTER_GAME_TEXT_RULES`. */
	readonly starterRules?: GameTextRuleDocument;
	/**
	 * Writable-file hook for a batch: called with the absolute path of every PO file a
	 * translation edit will replace, read fresh before the write, or of the review file a
	 * review change will create or replace, before the first one is written, so a host can check
	 * them all out first. A failure writes nothing. `localizationFiles` still checks each file as
	 * it writes it.
	 */
	readonly prepareWrites?: (
		paths: readonly string[]
	) => Effect.Effect<void, GameTextWorkspaceHostFailure>;
	/**
	 * Code reading: the engine a target's code is read with for the selected project (its source
	 * gather behaviour and installation root). Absent, or answering undefined, leaves code unread:
	 * C++ and config text then shows from the gather manifest only.
	 */
	readonly codeSource?: (projectRoot: string) => Effect.Effect<GameTextCodeSource | undefined>;
	/**
	 * Recovery copy: called with a file's previous bytes before the workspace overwrites it (a
	 * saved rules file), so a host can keep a copy to restore. A read failure or recovery-copy
	 * failure stops the write; absence is never inferred from a failure.
	 */
	readonly recoveryCopy?: (
		path: string,
		previous: Uint8Array
	) => Effect.Effect<void, GameTextWorkspaceHostFailure>;
	/** Policy: the name review records carry for the person making them. */
	readonly reviewer?: () => string;
	/** Policy: the name change sets carry as their author. Defaults to `"game-text"`. */
	readonly changeAuthor?: string;
	/**
	 * Writable-file hook for localization files: the file access that writes PO edits and review
	 * files. Defaults to `LocalizationFileAccessLive`.
	 */
	readonly localizationFiles?: Layer.Layer<LocalizationFileAccess>;
}
