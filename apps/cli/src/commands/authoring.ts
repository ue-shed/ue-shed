import { AuthoringValue } from "@ue-shed/protocol";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Schema } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import {
	runAuthoringCatalog,
	runAuthoringInspect,
	runAuthoringJoin,
	runAuthoringLiveInspect,
	runAuthoringLiveTables,
	runAuthoringParity,
	runAuthoringRelationships,
	runAuthoringSession,
	runAuthoringTables
} from "../workflows/authoring.js";
import { nonNegativeIntegerFlag, optionalFlag, optionalValue, readerFields } from "./options.js";

function parseAuthoringValue(valueJson: string) {
	return Effect.try({
		try: () => JSON.parse(valueJson) as unknown,
		catch: (cause) => new CliCommandError({ message: `Invalid value JSON: ${String(cause)}` })
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(AuthoringValue)),
		Effect.mapError((cause) =>
			cause instanceof CliCommandError
				? cause
				: new CliCommandError({ message: `Invalid authoring value: ${String(cause)}` })
		)
	);
}

function parseRowIds(value: string) {
	return Effect.try({
		try: () => JSON.parse(value) as unknown,
		catch: (cause) => new CliCommandError({ message: `Invalid row IDs JSON: ${String(cause)}` })
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.String))),
		Effect.mapError((cause) =>
			cause instanceof CliCommandError
				? cause
				: new CliCommandError({ message: `Invalid row IDs: ${String(cause)}` })
		)
	);
}

const readerFlag = optionalFlag("reader");

const authoringTablesCommand = Command.make(
	"tables",
	{ projectRoot: Argument.string("project-root"), reader: readerFlag },
	({ projectRoot, reader }) =>
		runAuthoringTables({ _tag: "AuthoringTables", projectRoot, ...readerFields(reader) })
).pipe(Command.withDescription("Discover saved DataTables."));

const authoringRelationshipsCommand = Command.make(
	"relationships",
	{ projectRoot: Argument.string("project-root"), reader: readerFlag },
	({ projectRoot, reader }) =>
		runAuthoringRelationships({
			_tag: "AuthoringRelationships",
			projectRoot,
			...readerFields(reader)
		})
).pipe(Command.withDescription("Resolve saved DataTable row references."));

const authoringJoinCommand = Command.make(
	"join",
	{
		projectRoot: Argument.string("project-root"),
		sourceTableObjectPath: Argument.string("source-table"),
		referenceFieldName: Argument.string("reference-field"),
		reader: readerFlag
	},
	({ projectRoot, sourceTableObjectPath, referenceFieldName, reader }) =>
		runAuthoringJoin({
			_tag: "AuthoringJoin",
			projectRoot,
			referenceFieldName,
			sourceTableObjectPath,
			...readerFields(reader)
		})
).pipe(Command.withDescription("Build a read-only joined DataTable view."));

const authoringCatalogCommand = Command.make(
	"catalog",
	{
		projectRoot: Argument.string("project-root"),
		endpoint: optionalFlag("endpoint"),
		reader: readerFlag
	},
	({ projectRoot, endpoint, reader }) => {
		const endpointValue = optionalValue(endpoint);
		return runAuthoringCatalog({
			_tag: "AuthoringCatalog",
			projectRoot,
			...(endpointValue === undefined ? {} : { endpoint: endpointValue }),
			...readerFields(reader)
		});
	}
).pipe(Command.withDescription("Discover saved and optionally live DataTables."));

const authoringParityCommand = Command.make(
	"parity",
	{
		projectRoot: Argument.string("project-root"),
		endpoint: Argument.string("endpoint"),
		reader: readerFlag
	},
	({ projectRoot, endpoint, reader }) =>
		runAuthoringParity({
			_tag: "AuthoringParity",
			endpoint,
			projectRoot,
			...readerFields(reader)
		})
).pipe(Command.withDescription("Compare saved and live authoring snapshots."));

const authoringInspectCommand = Command.make(
	"inspect",
	{ assetPath: Argument.string("asset"), reader: readerFlag },
	({ assetPath, reader }) =>
		runAuthoringInspect({ _tag: "AuthoringInspect", assetPath, ...readerFields(reader) })
).pipe(Command.withDescription("Inspect one saved DataTable."));

const authoringLiveTablesCommand = Command.make(
	"tables",
	{ endpoint: Argument.string("endpoint") },
	({ endpoint }) => runAuthoringLiveTables({ _tag: "AuthoringLiveTables", endpoint })
).pipe(Command.withDescription("List live DataTables from Unreal."));

const authoringLiveInspectCommand = Command.make(
	"inspect",
	{ endpoint: Argument.string("endpoint"), tablePath: Argument.string("table") },
	({ endpoint, tablePath }) =>
		runAuthoringLiveInspect({ _tag: "AuthoringLiveInspect", endpoint, tablePath })
).pipe(Command.withDescription("Inspect one live DataTable."));

const sessionProjectFlag = Flag.string("project");
const sessionIdOption = optionalFlag("id");
const sessionIndexOption = nonNegativeIntegerFlag("index", "Invalid non-negative row index").pipe(
	Flag.optional
);
const sessionReaderOption = optionalFlag("reader");

const sessionsListCommand = Command.make(
	"list",
	{
		projectRoot: sessionProjectFlag,
		id: sessionIdOption,
		index: sessionIndexOption,
		reader: sessionReaderOption
	},
	({ projectRoot }) => runAuthoringSession({ _tag: "SessionsList", projectRoot })
).pipe(Command.withDescription("List durable authoring sessions."));

const sessionsCreateCommand = Command.make(
	"create",
	{
		assetPath: Argument.string("asset"),
		projectRoot: sessionProjectFlag,
		id: sessionIdOption,
		index: sessionIndexOption,
		reader: sessionReaderOption
	},
	({ assetPath, projectRoot, id, reader }) => {
		const idValue = optionalValue(id);
		return runAuthoringSession({
			_tag: "SessionsCreate",
			assetPath,
			projectRoot,
			...(idValue === undefined ? {} : { id: idValue }),
			...readerFields(reader)
		});
	}
).pipe(Command.withDescription("Create a durable authoring session."));

function makeSessionLifecycleCommand(
	action: "show" | "resume" | "close" | "discard" | "undo" | "redo"
) {
	return Command.make(
		action,
		{
			sessionId: Argument.string("session-id"),
			projectRoot: sessionProjectFlag,
			id: sessionIdOption,
			index: sessionIndexOption,
			reader: sessionReaderOption
		},
		({ sessionId, projectRoot }) => {
			const fields = { projectRoot, sessionId };
			switch (action) {
				case "show":
					return runAuthoringSession({ _tag: "SessionsShow", ...fields });
				case "resume":
					return runAuthoringSession({ _tag: "SessionsResume", ...fields });
				case "close":
					return runAuthoringSession({ _tag: "SessionsClose", ...fields });
				case "discard":
					return runAuthoringSession({ _tag: "SessionsDiscard", ...fields });
				case "undo":
					return runAuthoringSession({ _tag: "SessionsUndo", ...fields });
				default:
					return runAuthoringSession({ _tag: "SessionsRedo", ...fields });
			}
		}
	).pipe(Command.withDescription(`Run the authoring session ${action} operation.`));
}

function makeSessionReviewCommand(action: "review" | "validate" | "diff") {
	return Command.make(
		action,
		{
			sessionId: Argument.string("session-id"),
			projectRoot: sessionProjectFlag,
			id: sessionIdOption,
			index: sessionIndexOption,
			reader: sessionReaderOption
		},
		({ sessionId, projectRoot }) => {
			const fields = { projectRoot, sessionId };
			return action === "review"
				? runAuthoringSession({ _tag: "SessionsReview", ...fields })
				: action === "validate"
					? runAuthoringSession({ _tag: "SessionsValidate", ...fields })
					: runAuthoringSession({ _tag: "SessionsDiff", ...fields });
		}
	).pipe(Command.withDescription(`Run the authoring session ${action} operation.`));
}

const sessionsSetCellCommand = Command.make(
	"set-cell",
	{
		sessionId: Argument.string("session-id"),
		tablePath: Argument.string("table"),
		rowId: Argument.string("row-id"),
		fieldName: Argument.string("field"),
		valueJson: Argument.string("value-json"),
		projectRoot: sessionProjectFlag,
		id: sessionIdOption,
		index: sessionIndexOption,
		reader: sessionReaderOption
	},
	({ sessionId, tablePath, rowId, fieldName, valueJson, projectRoot }) =>
		parseAuthoringValue(valueJson).pipe(
			Effect.flatMap((value) =>
				runAuthoringSession({
					_tag: "SessionsSetCell",
					fieldName,
					projectRoot,
					rowId,
					sessionId,
					tablePath,
					value
				})
			)
		)
).pipe(Command.withDescription("Set one authoring session cell."));

const sessionsAddRowCommand = Command.make(
	"add-row",
	{
		sessionId: Argument.string("session-id"),
		tablePath: Argument.string("table"),
		rowName: Argument.string("row-name"),
		projectRoot: sessionProjectFlag,
		index: sessionIndexOption,
		id: sessionIdOption,
		reader: sessionReaderOption
	},
	({ sessionId, tablePath, rowName, projectRoot, index }) => {
		const atIndex = optionalValue(index);
		return runAuthoringSession({
			_tag: "SessionsAddRow",
			projectRoot,
			rowName,
			sessionId,
			tablePath,
			...(atIndex === undefined ? {} : { atIndex })
		});
	}
).pipe(Command.withDescription("Add a row to an authoring session."));

const sessionsDuplicateRowCommand = Command.make(
	"duplicate-row",
	{
		sessionId: Argument.string("session-id"),
		tablePath: Argument.string("table"),
		sourceRowId: Argument.string("source-row-id"),
		rowName: Argument.string("row-name"),
		projectRoot: sessionProjectFlag,
		index: sessionIndexOption,
		id: sessionIdOption,
		reader: sessionReaderOption
	},
	({ sessionId, tablePath, sourceRowId, rowName, projectRoot, index }) => {
		const atIndex = optionalValue(index);
		return runAuthoringSession({
			_tag: "SessionsDuplicateRow",
			projectRoot,
			rowName,
			sessionId,
			sourceRowId,
			tablePath,
			...(atIndex === undefined ? {} : { atIndex })
		});
	}
).pipe(Command.withDescription("Duplicate a row in an authoring session."));

const sessionsRemoveRowCommand = Command.make(
	"remove-row",
	{
		sessionId: Argument.string("session-id"),
		tablePath: Argument.string("table"),
		rowId: Argument.string("row-id"),
		projectRoot: sessionProjectFlag,
		id: sessionIdOption,
		index: sessionIndexOption,
		reader: sessionReaderOption
	},
	({ sessionId, tablePath, rowId, projectRoot }) =>
		runAuthoringSession({
			_tag: "SessionsRemoveRow",
			projectRoot,
			rowId,
			sessionId,
			tablePath
		})
).pipe(Command.withDescription("Remove a row from an authoring session."));

const sessionsRenameRowCommand = Command.make(
	"rename-row",
	{
		sessionId: Argument.string("session-id"),
		tablePath: Argument.string("table"),
		rowId: Argument.string("row-id"),
		rowName: Argument.string("row-name"),
		projectRoot: sessionProjectFlag,
		id: sessionIdOption,
		index: sessionIndexOption,
		reader: sessionReaderOption
	},
	({ sessionId, tablePath, rowId, rowName, projectRoot }) =>
		runAuthoringSession({
			_tag: "SessionsRenameRow",
			projectRoot,
			rowId,
			rowName,
			sessionId,
			tablePath
		})
).pipe(Command.withDescription("Rename a row in an authoring session."));

const sessionsReorderRowsCommand = Command.make(
	"reorder-rows",
	{
		sessionId: Argument.string("session-id"),
		tablePath: Argument.string("table"),
		rowIdsJson: Argument.string("row-ids-json"),
		projectRoot: sessionProjectFlag,
		id: sessionIdOption,
		index: sessionIndexOption,
		reader: sessionReaderOption
	},
	({ sessionId, tablePath, rowIdsJson, projectRoot }) =>
		parseRowIds(rowIdsJson).pipe(
			Effect.flatMap((rowIds) =>
				runAuthoringSession({
					_tag: "SessionsReorderRows",
					projectRoot,
					rowIds,
					sessionId,
					tablePath
				})
			)
		)
).pipe(Command.withDescription("Reorder rows in an authoring session."));

function makeSessionLiveCommand(action: "apply" | "reconcile" | "save") {
	return Command.make(
		action,
		{
			sessionId: Argument.string("session-id"),
			endpoint: Argument.string("endpoint"),
			projectRoot: sessionProjectFlag,
			id: sessionIdOption,
			index: sessionIndexOption,
			reader: sessionReaderOption
		},
		({ sessionId, endpoint, projectRoot }) => {
			const fields = { endpoint, projectRoot, sessionId };
			return action === "apply"
				? runAuthoringSession({ _tag: "SessionsApply", ...fields })
				: action === "reconcile"
					? runAuthoringSession({ _tag: "SessionsReconcile", ...fields })
					: runAuthoringSession({ _tag: "SessionsSave", ...fields });
		}
	).pipe(Command.withDescription(`Run the authoring session ${action} operation.`));
}

const sessionsCommand = Command.make("sessions").pipe(
	Command.withDescription("Create and operate durable authoring sessions."),
	Command.withSubcommands([
		sessionsListCommand,
		sessionsCreateCommand,
		...(["show", "resume", "close", "discard", "undo", "redo"] as const).map(
			makeSessionLifecycleCommand
		),
		sessionsSetCellCommand,
		sessionsAddRowCommand,
		sessionsDuplicateRowCommand,
		sessionsRemoveRowCommand,
		sessionsRenameRowCommand,
		sessionsReorderRowsCommand,
		...(["review", "validate", "diff"] as const).map(makeSessionReviewCommand),
		...(["apply", "reconcile", "save"] as const).map(makeSessionLiveCommand)
	])
);

export const authoringCommand = Command.make("authoring").pipe(
	Command.withDescription("Inspect, compare, and author DataTables."),
	Command.withSubcommands([
		authoringTablesCommand,
		authoringRelationshipsCommand,
		authoringJoinCommand,
		authoringCatalogCommand,
		authoringParityCommand,
		authoringInspectCommand,
		Command.make("live").pipe(
			Command.withDescription("Read live authoring state from Unreal."),
			Command.withSubcommands([authoringLiveTablesCommand, authoringLiveInspectCommand])
		),
		sessionsCommand
	])
);
