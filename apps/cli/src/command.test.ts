import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import { parseCliCommand } from "./command.js";

const value = JSON.stringify({ kind: "bool", value: true });

const commands: ReadonlyArray<readonly [readonly string[], string]> = [
	[[], "Help"],
	[["--help"], "Help"],
	[["--version"], "Version"],
	[["audit", "textures", "project", "--rules", "rules.json"], "AuditTextures"],
	[["authoring", "tables", "project"], "AuthoringTables"],
	[["authoring", "relationships", "project"], "AuthoringRelationships"],
	[
		[
			"authoring",
			"join",
			"project",
			"/Game/Fixture/Authoring/DT_LeftReferences.DT_LeftReferences",
			"Target"
		],
		"AuthoringJoin"
	],
	[["authoring", "catalog", "project", "--endpoint", "http://editor"], "AuthoringCatalog"],
	[["authoring", "parity", "project", "http://editor"], "AuthoringParity"],
	[["authoring", "inspect", "table.uasset"], "AuthoringInspect"],
	[["authoring", "live", "tables", "http://editor"], "AuthoringLiveTables"],
	[["authoring", "live", "inspect", "http://editor", "/Game/Table"], "AuthoringLiveInspect"],
	[["authoring", "sessions", "list", "--project", "project"], "SessionsList"],
	[
		[
			"authoring",
			"sessions",
			"create",
			"table.uasset",
			"--project",
			"project",
			"--id",
			"draft"
		],
		"SessionsCreate"
	],
	[["authoring", "sessions", "show", "draft", "--project", "project"], "SessionsShow"],
	[["authoring", "sessions", "resume", "draft", "--project", "project"], "SessionsResume"],
	[["authoring", "sessions", "close", "draft", "--project", "project"], "SessionsClose"],
	[["authoring", "sessions", "discard", "draft", "--project", "project"], "SessionsDiscard"],
	[["authoring", "sessions", "undo", "draft", "--project", "project"], "SessionsUndo"],
	[["authoring", "sessions", "redo", "draft", "--project", "project"], "SessionsRedo"],
	[
		[
			"authoring",
			"sessions",
			"set-cell",
			"draft",
			"/Game/Table",
			"Row",
			"Field",
			value,
			"--project",
			"project"
		],
		"SessionsSetCell"
	],
	[
		[
			"authoring",
			"sessions",
			"add-row",
			"draft",
			"/Game/Table",
			"Beta",
			"--project",
			"project",
			"--index",
			"1"
		],
		"SessionsAddRow"
	],
	[
		[
			"authoring",
			"sessions",
			"duplicate-row",
			"draft",
			"/Game/Table",
			"row:Alpha",
			"Beta",
			"--project",
			"project"
		],
		"SessionsDuplicateRow"
	],
	[
		[
			"authoring",
			"sessions",
			"remove-row",
			"draft",
			"/Game/Table",
			"row:Alpha",
			"--project",
			"project"
		],
		"SessionsRemoveRow"
	],
	[
		[
			"authoring",
			"sessions",
			"rename-row",
			"draft",
			"/Game/Table",
			"row:Alpha",
			"Beta",
			"--project",
			"project"
		],
		"SessionsRenameRow"
	],
	[
		[
			"authoring",
			"sessions",
			"reorder-rows",
			"draft",
			"/Game/Table",
			'["row:Beta","row:Alpha"]',
			"--project",
			"project"
		],
		"SessionsReorderRows"
	],
	[
		["authoring", "sessions", "apply", "draft", "http://editor", "--project", "project"],
		"SessionsApply"
	],
	[
		["authoring", "sessions", "reconcile", "draft", "http://editor", "--project", "project"],
		"SessionsReconcile"
	],
	[
		["authoring", "sessions", "save", "draft", "http://editor", "--project", "project"],
		"SessionsSave"
	],
	[["authoring", "sessions", "review", "draft", "--project", "project"], "SessionsReview"],
	[["authoring", "sessions", "validate", "draft", "--project", "project"], "SessionsValidate"],
	[["authoring", "sessions", "diff", "draft", "--project", "project"], "SessionsDiff"],
	[["text", "scan", "project"], "TextScan"],
	[["text", "search", "project", "hello", "world"], "TextSearch"],
	[["review", "sets", "validate", "set.json"], "ReviewSetValidate"],
	[["review", "framing", "candidates", "http://editor"], "ReviewFramingCandidates"],
	[
		["review", "framing", "approve", "set.json", "http://editor", "view", "candidate"],
		"ReviewFramingApprove"
	],
	[["review", "capture", "project", "set.json", "http://editor"], "ReviewCapture"],
	[["review", "history", "project"], "ReviewHistory"],
	[["review", "show", "run.json"], "ReviewShow"]
];

it.effect("decodes every CLI command variant", () =>
	Effect.forEach(commands, ([args, expected]) =>
		parseCliCommand(args).pipe(
			Effect.tap((command) => Effect.sync(() => expect(command._tag).toBe(expected)))
		)
	).pipe(Effect.asVoid)
);

it.effect("rejects missing, duplicate, unknown, and malformed options", () =>
	Effect.forEach(
		[
			["audit", "textures", "project", "--rules"],
			["audit", "textures", "project", "--rules", "one", "--rules", "two"],
			["text", "scan", "project", "--wat", "value"],
			["authoring", "session", "show", "legacy.json"],
			[
				"authoring",
				"sessions",
				"set-cell",
				"draft",
				"/Game/Table",
				"Row",
				"Field",
				"{",
				"--project",
				"project"
			],
			[
				"authoring",
				"sessions",
				"add-row",
				"draft",
				"/Game/Table",
				"Beta",
				"--project",
				"project",
				"--index",
				"-1"
			],
			[
				"authoring",
				"sessions",
				"reorder-rows",
				"draft",
				"/Game/Table",
				"{}",
				"--project",
				"project"
			]
		],
		(args) =>
			parseCliCommand(args).pipe(
				Effect.exit,
				Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true)))
			)
	).pipe(Effect.asVoid)
);
