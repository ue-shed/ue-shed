import { NodeServices } from "@effect/platform-node";
import { AuthoringValue, CURRENT_PROTOCOL_VERSION } from "@ue-shed/protocol";
import { Argument, CliError, CliOutput, Command, Flag } from "effect/unstable/cli";
import { Cause, Console, Effect, Exit, Layer, Option, Schema } from "effect";
import { CliCommandError, CliRuntime, executeCommand } from "./application.js";

const Project = { projectRoot: Schema.String };
const Reader = { reader: Schema.optionalKey(Schema.String) };
const SessionProject = { projectRoot: Schema.String, sessionId: Schema.String };
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const EditorPlayAction = Schema.Literals([
	"status",
	"start",
	"simulate",
	"pause",
	"resume",
	"stop"
]);

export const CliCommand = Schema.TaggedUnion({
	Version: {},
	Doctor: {},
	EditorPlaySession: {
		action: EditorPlayAction,
		endpoint: Schema.String
	},
	AuditTextures: { ...Project, ruleFile: Schema.String, ...Reader },
	AuthoringTables: { ...Project, ...Reader },
	AuthoringRelationships: { ...Project, ...Reader },
	AuthoringJoin: {
		...Project,
		referenceFieldName: Schema.String,
		sourceTableObjectPath: Schema.String,
		...Reader
	},
	AuthoringCatalog: { ...Project, endpoint: Schema.optionalKey(Schema.String), ...Reader },
	AuthoringParity: { ...Project, endpoint: Schema.String, ...Reader },
	AuthoringInspect: { assetPath: Schema.String, ...Reader },
	AuthoringLiveTables: { endpoint: Schema.String },
	AuthoringLiveInspect: { endpoint: Schema.String, tablePath: Schema.String },
	SessionsList: { ...Project },
	SessionsCreate: {
		...Project,
		assetPath: Schema.String,
		id: Schema.optionalKey(Schema.String),
		...Reader
	},
	SessionsShow: { ...SessionProject },
	SessionsResume: { ...SessionProject },
	SessionsClose: { ...SessionProject },
	SessionsDiscard: { ...SessionProject },
	SessionsUndo: { ...SessionProject },
	SessionsRedo: { ...SessionProject },
	SessionsSetCell: {
		...SessionProject,
		fieldName: Schema.String,
		rowId: Schema.String,
		tablePath: Schema.String,
		value: AuthoringValue
	},
	SessionsAddRow: {
		...SessionProject,
		atIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		rowName: Schema.String,
		tablePath: Schema.String
	},
	SessionsDuplicateRow: {
		...SessionProject,
		atIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		rowName: Schema.String,
		sourceRowId: Schema.String,
		tablePath: Schema.String
	},
	SessionsRemoveRow: { ...SessionProject, rowId: Schema.String, tablePath: Schema.String },
	SessionsRenameRow: {
		...SessionProject,
		rowId: Schema.String,
		rowName: Schema.String,
		tablePath: Schema.String
	},
	SessionsReorderRows: {
		...SessionProject,
		rowIds: Schema.Array(Schema.String),
		tablePath: Schema.String
	},
	SessionsApply: { ...SessionProject, endpoint: Schema.String },
	SessionsReconcile: { ...SessionProject, endpoint: Schema.String },
	SessionsSave: { ...SessionProject, endpoint: Schema.String },
	SessionsReview: { ...SessionProject },
	SessionsValidate: { ...SessionProject },
	SessionsDiff: { ...SessionProject },
	AssetsScan: {
		classPrefixes: Schema.optionalKey(Schema.Array(Schema.String)),
		classes: Schema.optionalKey(Schema.Array(Schema.String)),
		full: Schema.optionalKey(Schema.Boolean),
		maximumAssets: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
		names: Schema.optionalKey(Schema.Array(Schema.String)),
		path: Schema.String,
		...Reader
	},
	TextScan: { ...Project, ...Reader },
	TextSearch: { ...Project, query: Schema.String, ...Reader },
	InputInspect: { path: Schema.String, ...Reader },
	MapHistory: {
		actorClass: Schema.optionalKey(Schema.String),
		actorGuid: Schema.optionalKey(Schema.String),
		actorPackage: Schema.optionalKey(Schema.String),
		actorPath: Schema.optionalKey(Schema.String),
		concurrency: Schema.optionalKey(PositiveInt),
		mapPath: Schema.String,
		maxChangelists: Schema.optionalKey(PositiveInt),
		maxDurationMs: Schema.optionalKey(PositiveInt),
		maxMaterializedFiles: Schema.optionalKey(PositiveInt),
		maxPackages: Schema.optionalKey(PositiveInt),
		mode: Schema.optionalKey(Schema.Literals(["deep", "fast"])),
		projectRoot: Schema.String,
		since: Schema.String,
		until: Schema.optionalKey(Schema.String)
	},
	ReviewSetValidate: { reviewSetPath: Schema.String },
	ReviewFramingCandidates: { endpoint: Schema.String },
	ReviewFramingApprove: {
		candidateId: Schema.String,
		endpoint: Schema.String,
		reviewSetPath: Schema.String,
		viewId: Schema.String
	},
	ReviewAuthoringStart: {
		endpoint: Schema.String,
		projectRoot: Schema.String,
		reviewSetPath: Schema.String,
		viewId: Schema.String
	},
	ReviewAuthoringBootstrap: { endpoint: Schema.String, ...Project },
	ReviewAuthoringShow: { ...SessionProject },
	ReviewAuthoringResume: { ...SessionProject, endpoint: Schema.String },
	ReviewAuthoringDiscard: { ...SessionProject },
	ReviewAuthoringReframe: { ...SessionProject, endpoint: Schema.String },
	ReviewAuthoringApprove: { ...SessionProject, endpoint: Schema.String },
	ReviewCapture: {
		cause: Schema.optionalKey(Schema.Literal("external_automation")),
		correlationId: Schema.optionalKey(Schema.String),
		endpoint: Schema.String,
		...Project,
		reviewSetPath: Schema.String
	},
	ReviewHistory: { ...Project },
	ReviewShow: { runPath: Schema.String },
	PluginsList: { manifestPath: Schema.String },
	PluginsVerify: { artifactPath: Schema.optionalKey(Schema.String), manifestPath: Schema.String },
	PluginsInstall: {
		artifactPath: Schema.optionalKey(Schema.String),
		manifestPath: Schema.String,
		...Project
	}
});

export type CliCommand = typeof CliCommand.Type;

function optionalFlag(name: string) {
	return Flag.string(name).pipe(Flag.optional);
}

function optionalValue<A>(value: Option.Option<A>): A | undefined {
	return Option.isSome(value) ? value.value : undefined;
}

function readerFields(reader: Option.Option<string>) {
	const value = optionalValue(reader);
	return value === undefined ? {} : { reader: value };
}

function repeatedStringFlag(name: string) {
	return Flag.string(name).pipe(Flag.atMost(Number.MAX_SAFE_INTEGER));
}

function positiveIntegerFlag(name: string, message: string) {
	return Flag.integer(name).pipe(
		Flag.filter(
			(value) => value > 0,
			() => message
		)
	);
}

function nonNegativeIntegerFlag(name: string, message: string) {
	return Flag.integer(name).pipe(
		Flag.filter(
			(value) => value >= 0,
			() => message
		)
	);
}

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

function runModel(command: CliCommand): Effect.Effect<void, CliCommandError, CliRuntime> {
	return executeCommand(command);
}

const version = `0.0.0 (protocol ${CURRENT_PROTOCOL_VERSION.major}.${CURRENT_PROTOCOL_VERSION.minor})`;

const versionCommand = Command.make("version", {}, () =>
	runModel(CliCommand.cases.Version.make({}))
).pipe(Command.withDescription("Print the UE Shed and protocol versions."));

const doctorCommand = Command.make("doctor", {}, () =>
	runModel(CliCommand.cases.Doctor.make({}))
).pipe(Command.withDescription("Report local service and capability health."));

const playActions = ["status", "start", "simulate", "pause", "resume", "stop"] as const;
type PlayAction = (typeof playActions)[number];

function makePlayCommand(action: PlayAction) {
	return Command.make(action, { endpoint: Argument.string("endpoint") }, ({ endpoint }) =>
		runModel(
			CliCommand.cases.EditorPlaySession.make({
				action,
				endpoint
			})
		)
	).pipe(Command.withDescription(`Run the editor play-session ${action} operation.`));
}

const editorCommand = Command.make("editor").pipe(
	Command.withDescription("Control a connected Unreal Editor session."),
	Command.withSubcommands([
		Command.make("play").pipe(
			Command.withDescription("Inspect or control Play In Editor."),
			Command.withSubcommands(playActions.map(makePlayCommand))
		)
	])
);

const readerFlag = optionalFlag("reader");

const auditTexturesCommand = Command.make(
	"textures",
	{
		projectRoot: Argument.string("project-root"),
		ruleFile: Flag.string("rules"),
		reader: readerFlag
	},
	({ projectRoot, ruleFile, reader }) =>
		runModel(
			CliCommand.cases.AuditTextures.make({
				projectRoot,
				ruleFile,
				...readerFields(reader)
			})
		)
).pipe(Command.withDescription("Audit saved Texture2D assets against rule definitions."));

const auditCommand = Command.make("audit").pipe(
	Command.withDescription("Run saved-asset audits."),
	Command.withSubcommands([auditTexturesCommand])
);

const authoringTablesCommand = Command.make(
	"tables",
	{ projectRoot: Argument.string("project-root"), reader: readerFlag },
	({ projectRoot, reader }) =>
		runModel(CliCommand.cases.AuthoringTables.make({ projectRoot, ...readerFields(reader) }))
).pipe(Command.withDescription("Discover saved DataTables."));

const authoringRelationshipsCommand = Command.make(
	"relationships",
	{ projectRoot: Argument.string("project-root"), reader: readerFlag },
	({ projectRoot, reader }) =>
		runModel(
			CliCommand.cases.AuthoringRelationships.make({ projectRoot, ...readerFields(reader) })
		)
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
		runModel(
			CliCommand.cases.AuthoringJoin.make({
				projectRoot,
				referenceFieldName,
				sourceTableObjectPath,
				...readerFields(reader)
			})
		)
).pipe(Command.withDescription("Build a read-only joined DataTable view."));

const authoringCatalogCommand = Command.make(
	"catalog",
	{
		projectRoot: Argument.string("project-root"),
		endpoint: optionalFlag("endpoint"),
		reader: readerFlag
	},
	({ projectRoot, endpoint, reader }) =>
		Effect.gen(function* () {
			const endpointValue = optionalValue(endpoint);
			return yield* runModel(
				CliCommand.cases.AuthoringCatalog.make({
					projectRoot,
					...(endpointValue === undefined ? {} : { endpoint: endpointValue }),
					...readerFields(reader)
				})
			);
		})
).pipe(Command.withDescription("Discover saved and optionally live DataTables."));

const authoringParityCommand = Command.make(
	"parity",
	{
		projectRoot: Argument.string("project-root"),
		endpoint: Argument.string("endpoint"),
		reader: readerFlag
	},
	({ projectRoot, endpoint, reader }) =>
		runModel(
			CliCommand.cases.AuthoringParity.make({
				endpoint,
				projectRoot,
				...readerFields(reader)
			})
		)
).pipe(Command.withDescription("Compare saved and live authoring snapshots."));

const authoringInspectCommand = Command.make(
	"inspect",
	{ assetPath: Argument.string("asset"), reader: readerFlag },
	({ assetPath, reader }) =>
		runModel(CliCommand.cases.AuthoringInspect.make({ assetPath, ...readerFields(reader) }))
).pipe(Command.withDescription("Inspect one saved DataTable."));

const authoringLiveTablesCommand = Command.make(
	"tables",
	{ endpoint: Argument.string("endpoint") },
	({ endpoint }) => runModel(CliCommand.cases.AuthoringLiveTables.make({ endpoint }))
).pipe(Command.withDescription("List live DataTables from Unreal."));

const authoringLiveInspectCommand = Command.make(
	"inspect",
	{
		endpoint: Argument.string("endpoint"),
		tablePath: Argument.string("table")
	},
	({ endpoint, tablePath }) =>
		runModel(CliCommand.cases.AuthoringLiveInspect.make({ endpoint, tablePath }))
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
	({ projectRoot }) => runModel(CliCommand.cases.SessionsList.make({ projectRoot }))
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
	({ assetPath, projectRoot, id, reader }) =>
		Effect.gen(function* () {
			const idValue = optionalValue(id);
			return yield* runModel(
				CliCommand.cases.SessionsCreate.make({
					assetPath,
					projectRoot,
					...(idValue === undefined ? {} : { id: idValue }),
					...readerFields(reader)
				})
			);
		})
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
					return runModel(CliCommand.cases.SessionsShow.make(fields));
				case "resume":
					return runModel(CliCommand.cases.SessionsResume.make(fields));
				case "close":
					return runModel(CliCommand.cases.SessionsClose.make(fields));
				case "discard":
					return runModel(CliCommand.cases.SessionsDiscard.make(fields));
				case "undo":
					return runModel(CliCommand.cases.SessionsUndo.make(fields));
				default:
					return runModel(CliCommand.cases.SessionsRedo.make(fields));
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
				? runModel(CliCommand.cases.SessionsReview.make(fields))
				: action === "validate"
					? runModel(CliCommand.cases.SessionsValidate.make(fields))
					: runModel(CliCommand.cases.SessionsDiff.make(fields));
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
				runModel(
					CliCommand.cases.SessionsSetCell.make({
						fieldName,
						projectRoot,
						rowId,
						sessionId,
						tablePath,
						value
					})
				)
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
		return runModel(
			CliCommand.cases.SessionsAddRow.make({
				projectRoot,
				rowName,
				sessionId,
				tablePath,
				...(atIndex === undefined ? {} : { atIndex })
			})
		);
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
		return runModel(
			CliCommand.cases.SessionsDuplicateRow.make({
				projectRoot,
				rowName,
				sessionId,
				sourceRowId,
				tablePath,
				...(atIndex === undefined ? {} : { atIndex })
			})
		);
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
		runModel(
			CliCommand.cases.SessionsRemoveRow.make({ projectRoot, rowId, sessionId, tablePath })
		)
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
		runModel(
			CliCommand.cases.SessionsRenameRow.make({
				projectRoot,
				rowId,
				rowName,
				sessionId,
				tablePath
			})
		)
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
				runModel(
					CliCommand.cases.SessionsReorderRows.make({
						projectRoot,
						rowIds,
						sessionId,
						tablePath
					})
				)
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
				? runModel(CliCommand.cases.SessionsApply.make(fields))
				: action === "reconcile"
					? runModel(CliCommand.cases.SessionsReconcile.make(fields))
					: runModel(CliCommand.cases.SessionsSave.make(fields));
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

const authoringCommand = Command.make("authoring").pipe(
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

const assetsScanCommand = Command.make(
	"scan",
	{
		path: Argument.string("path"),
		classPrefixes: repeatedStringFlag("class-prefix"),
		classes: repeatedStringFlag("class"),
		names: repeatedStringFlag("name"),
		maximumAssets: positiveIntegerFlag(
			"maximum-assets",
			"--maximum-assets requires a positive integer"
		).pipe(Flag.optional),
		full: Flag.boolean("full").pipe(Flag.optional),
		reader: readerFlag
	},
	({ path, classPrefixes, classes, names, maximumAssets, full, reader }) => {
		const maximumAssetsValue = optionalValue(maximumAssets);
		const fullValue = optionalValue(full);
		return runModel(
			CliCommand.cases.AssetsScan.make({
				path,
				...(classPrefixes.length === 0 ? {} : { classPrefixes }),
				...(classes.length === 0 ? {} : { classes }),
				...(names.length === 0 ? {} : { names }),
				...(maximumAssetsValue === undefined ? {} : { maximumAssets: maximumAssetsValue }),
				...(fullValue === undefined ? {} : { full: fullValue }),
				...readerFields(reader)
			})
		);
	}
).pipe(Command.withDescription("Scan saved assets under a project or explicit path."));

const assetsCommand = Command.make("assets").pipe(
	Command.withDescription("Inspect saved Unreal assets."),
	Command.withSubcommands([assetsScanCommand])
);

const textScanCommand = Command.make(
	"scan",
	{ projectRoot: Argument.string("project-root"), reader: readerFlag },
	({ projectRoot, reader }) =>
		runModel(CliCommand.cases.TextScan.make({ projectRoot, ...readerFields(reader) }))
).pipe(Command.withDescription("Build the saved player-facing text corpus."));

const textSearchCommand = Command.make(
	"search",
	{
		projectRoot: Argument.string("project-root"),
		query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
		reader: readerFlag
	},
	({ projectRoot, query, reader }) => {
		const value = query.join(" ").trim();
		return value.length === 0
			? Effect.fail(
					new CliCommandError({ message: "text search requires a non-empty query" })
				)
			: runModel(
					CliCommand.cases.TextSearch.make({
						projectRoot,
						query: value,
						...readerFields(reader)
					})
				);
	}
).pipe(Command.withDescription("Search the saved player-facing text corpus."));

const textCommand = Command.make("text").pipe(
	Command.withDescription("Inspect and search saved player-facing text."),
	Command.withSubcommands([textScanCommand, textSearchCommand])
);

const inputInspectCommand = Command.make(
	"inspect",
	{ path: Argument.string("asset-or-project"), reader: readerFlag },
	({ path, reader }) =>
		runModel(CliCommand.cases.InputInspect.make({ path, ...readerFields(reader) }))
).pipe(Command.withDescription("Inspect saved Enhanced Input assets."));

const inputCommand = Command.make("input").pipe(
	Command.withDescription("Inspect saved Enhanced Input assets."),
	Command.withSubcommands([inputInspectCommand])
);

const mapHistoryCommand = Command.make(
	"history",
	{
		projectRoot: Argument.string("project-root"),
		mapPath: Argument.string("map-path"),
		since: Flag.string("since"),
		until: optionalFlag("until"),
		mode: Flag.choice("mode", ["deep", "fast"]).pipe(Flag.optional),
		actorGuid: optionalFlag("actor-guid"),
		actorPackage: optionalFlag("actor-package"),
		actorPath: optionalFlag("actor-path"),
		actorClass: optionalFlag("actor-class"),
		maxChangelists: positiveIntegerFlag(
			"max-changelists",
			"--max-changelists requires a positive integer"
		).pipe(Flag.optional),
		maxPackages: positiveIntegerFlag(
			"max-packages",
			"--max-packages requires a positive integer"
		).pipe(Flag.optional),
		maxMaterializedFiles: positiveIntegerFlag(
			"max-materialized-files",
			"--max-materialized-files requires a positive integer"
		).pipe(Flag.optional),
		concurrency: positiveIntegerFlag(
			"concurrency",
			"--concurrency requires a positive integer"
		).pipe(Flag.optional),
		maxDurationMs: positiveIntegerFlag(
			"max-duration-ms",
			"--max-duration-ms requires a positive integer"
		).pipe(Flag.optional)
	},
	({
		projectRoot,
		mapPath,
		since,
		until,
		mode,
		actorGuid,
		actorPackage,
		actorPath,
		actorClass,
		maxChangelists,
		maxPackages,
		maxMaterializedFiles,
		concurrency,
		maxDurationMs
	}) => {
		const modeValue = optionalValue(mode);
		const actorGuidValue = optionalValue(actorGuid);
		const actorPackageValue = optionalValue(actorPackage);
		const actorPathValue = optionalValue(actorPath);
		const actorClassValue = optionalValue(actorClass);
		const untilValue = optionalValue(until);
		const concurrencyValue = optionalValue(concurrency);
		const maxChangelistsValue = optionalValue(maxChangelists);
		const maxDurationMsValue = optionalValue(maxDurationMs);
		const maxMaterializedFilesValue = optionalValue(maxMaterializedFiles);
		const maxPackagesValue = optionalValue(maxPackages);
		const hasActorTarget =
			actorGuidValue !== undefined ||
			actorPackageValue !== undefined ||
			actorPathValue !== undefined ||
			actorClassValue !== undefined;
		if ((modeValue ?? "deep") === "deep" && hasActorTarget) {
			return Effect.fail(
				new CliCommandError({
					message: "map history Investigation Target flags require --mode fast"
				})
			);
		}
		if (modeValue === "fast") {
			const hasGuidTarget = actorGuidValue !== undefined;
			const hasPathTarget = actorPackageValue !== undefined || actorPathValue !== undefined;
			const hasCompletePathTarget =
				actorPackageValue !== undefined && actorPathValue !== undefined;
			const targetKinds =
				Number(hasGuidTarget) +
				Number(hasCompletePathTarget) +
				Number(actorClassValue !== undefined);
			if (targetKinds !== 1 || (hasPathTarget && !hasCompletePathTarget)) {
				return Effect.fail(
					new CliCommandError({
						message:
							"map history --mode fast requires exactly one target: --actor-guid <guid>, --actor-package <package> with --actor-path <path>, or --actor-class <class-path>"
					})
				);
			}
		}
		return runModel(
			CliCommand.cases.MapHistory.make({
				...(actorClassValue === undefined ? {} : { actorClass: actorClassValue }),
				...(actorGuidValue === undefined ? {} : { actorGuid: actorGuidValue }),
				...(actorPackageValue === undefined ? {} : { actorPackage: actorPackageValue }),
				...(actorPathValue === undefined ? {} : { actorPath: actorPathValue }),
				...(concurrencyValue === undefined ? {} : { concurrency: concurrencyValue }),
				mapPath,
				...(maxChangelistsValue === undefined
					? {}
					: { maxChangelists: maxChangelistsValue }),
				...(maxDurationMsValue === undefined ? {} : { maxDurationMs: maxDurationMsValue }),
				...(maxMaterializedFilesValue === undefined
					? {}
					: { maxMaterializedFiles: maxMaterializedFilesValue }),
				...(maxPackagesValue === undefined ? {} : { maxPackages: maxPackagesValue }),
				...(modeValue === undefined ? {} : { mode: modeValue }),
				projectRoot,
				since,
				...(untilValue === undefined ? {} : { until: untilValue })
			})
		);
	}
).pipe(Command.withDescription("Read Perforce-backed saved map history."));

const mapCommand = Command.make("map").pipe(
	Command.withDescription("Inspect saved map history."),
	Command.withSubcommands([mapHistoryCommand])
);

const reviewSetValidateCommand = Command.make(
	"validate",
	{ reviewSetPath: Argument.string("review-set") },
	({ reviewSetPath }) => runModel(CliCommand.cases.ReviewSetValidate.make({ reviewSetPath }))
).pipe(Command.withDescription("Validate a Review Set document."));

const reviewFramingCandidatesCommand = Command.make(
	"candidates",
	{ endpoint: Argument.string("endpoint") },
	({ endpoint }) => runModel(CliCommand.cases.ReviewFramingCandidates.make({ endpoint }))
).pipe(Command.withDescription("List live framing candidates."));

const reviewFramingApproveCommand = Command.make(
	"approve",
	{
		reviewSetPath: Argument.string("review-set"),
		endpoint: Argument.string("endpoint"),
		viewId: Argument.string("view-id"),
		candidateId: Argument.string("candidate-id")
	},
	({ reviewSetPath, endpoint, viewId, candidateId }) =>
		runModel(
			CliCommand.cases.ReviewFramingApprove.make({
				candidateId,
				endpoint,
				reviewSetPath,
				viewId
			})
		)
).pipe(Command.withDescription("Approve a live framing candidate."));

const reviewAuthoringBootstrapCommand = Command.make(
	"bootstrap",
	{ projectRoot: Argument.string("project-root"), endpoint: Argument.string("endpoint") },
	({ projectRoot, endpoint }) =>
		runModel(CliCommand.cases.ReviewAuthoringBootstrap.make({ endpoint, projectRoot }))
).pipe(Command.withDescription("Bootstrap a Review authoring session."));

const reviewAuthoringStartCommand = Command.make(
	"start",
	{
		projectRoot: Argument.string("project-root"),
		reviewSetPath: Argument.string("review-set"),
		endpoint: Argument.string("endpoint"),
		viewId: Argument.string("view-id")
	},
	({ projectRoot, reviewSetPath, endpoint, viewId }) =>
		runModel(
			CliCommand.cases.ReviewAuthoringStart.make({
				endpoint,
				projectRoot,
				reviewSetPath,
				viewId
			})
		)
).pipe(Command.withDescription("Start Review authoring for one View."));

function makeReviewAuthoringLocalCommand(action: "show" | "discard") {
	return Command.make(
		action,
		{
			projectRoot: Argument.string("project-root"),
			sessionId: Argument.string("session-id")
		},
		({ projectRoot, sessionId }) => {
			const fields = { projectRoot, sessionId };
			return action === "show"
				? runModel(CliCommand.cases.ReviewAuthoringShow.make(fields))
				: runModel(CliCommand.cases.ReviewAuthoringDiscard.make(fields));
		}
	).pipe(Command.withDescription(`Run Review authoring ${action}.`));
}

function makeReviewAuthoringLiveCommand(action: "resume" | "reframe" | "approve") {
	return Command.make(
		action,
		{
			projectRoot: Argument.string("project-root"),
			sessionId: Argument.string("session-id"),
			endpoint: Argument.string("endpoint")
		},
		({ projectRoot, sessionId, endpoint }) => {
			const fields = { endpoint, projectRoot, sessionId };
			return action === "resume"
				? runModel(CliCommand.cases.ReviewAuthoringResume.make(fields))
				: action === "reframe"
					? runModel(CliCommand.cases.ReviewAuthoringReframe.make(fields))
					: runModel(CliCommand.cases.ReviewAuthoringApprove.make(fields));
		}
	).pipe(Command.withDescription(`Run Review authoring ${action}.`));
}

const reviewCaptureCommand = Command.make(
	"capture",
	{
		projectRoot: Argument.string("project-root"),
		reviewSetPath: Argument.string("review-set"),
		endpoint: Argument.string("endpoint"),
		cause: Flag.choice("cause", ["external_automation"]).pipe(Flag.optional),
		correlationId: optionalFlag("correlation")
	},
	({ projectRoot, reviewSetPath, endpoint, cause, correlationId }) => {
		const causeValue = optionalValue(cause);
		const correlationValue = optionalValue(correlationId);
		if (correlationValue !== undefined && causeValue === undefined) {
			return Effect.fail(
				new CliCommandError({
					message: "review capture --correlation requires --cause external_automation"
				})
			);
		}
		return runModel(
			CliCommand.cases.ReviewCapture.make({
				endpoint,
				projectRoot,
				reviewSetPath,
				...(causeValue === undefined ? {} : { cause: causeValue }),
				...(correlationValue === undefined ? {} : { correlationId: correlationValue })
			})
		);
	}
).pipe(Command.withDescription("Capture a Review Set run."));

const reviewHistoryCommand = Command.make(
	"history",
	{ projectRoot: Argument.string("project-root") },
	({ projectRoot }) => runModel(CliCommand.cases.ReviewHistory.make({ projectRoot }))
).pipe(Command.withDescription("List local Review capture history."));

const reviewShowCommand = Command.make(
	"show",
	{ runPath: Argument.string("run-json") },
	({ runPath }) => runModel(CliCommand.cases.ReviewShow.make({ runPath }))
).pipe(Command.withDescription("Show one Review capture run."));

const reviewCommand = Command.make("review").pipe(
	Command.withDescription("Author and inspect Map Review evidence."),
	Command.withSubcommands([
		Command.make("sets").pipe(
			Command.withDescription("Validate Review Set documents."),
			Command.withSubcommands([reviewSetValidateCommand])
		),
		Command.make("framing").pipe(
			Command.withDescription("Inspect and approve live framing."),
			Command.withSubcommands([reviewFramingCandidatesCommand, reviewFramingApproveCommand])
		),
		Command.make("authoring").pipe(
			Command.withDescription("Manage Review authoring sessions."),
			Command.withSubcommands([
				reviewAuthoringStartCommand,
				reviewAuthoringBootstrapCommand,
				...(["show", "discard"] as const).map(makeReviewAuthoringLocalCommand),
				...(["resume", "reframe", "approve"] as const).map(makeReviewAuthoringLiveCommand)
			])
		),
		reviewCaptureCommand,
		reviewHistoryCommand,
		reviewShowCommand
	])
);

const pluginManifestArgument = Argument.string("manifest").pipe(Argument.optional);
const pluginManifestFlag = optionalFlag("manifest");
const pluginArtifactFlag = optionalFlag("artifact");
const pluginProjectFlag = optionalFlag("project");

function resolvePluginPath(
	positional: Option.Option<string>,
	flag: Option.Option<string>,
	message: string
) {
	const positionalValue = optionalValue(positional);
	const flagValue = optionalValue(flag);
	if (positionalValue !== undefined && flagValue !== undefined) {
		return Effect.fail(new CliCommandError({ message }));
	}
	const value = positionalValue ?? flagValue;
	return value === undefined
		? Effect.fail(new CliCommandError({ message }))
		: Effect.succeed(value);
}

const pluginsListCommand = Command.make(
	"list",
	{
		manifest: pluginManifestArgument,
		manifestFlag: pluginManifestFlag,
		artifact: pluginArtifactFlag,
		project: pluginProjectFlag
	},
	({ manifest, manifestFlag, artifact, project }) =>
		Effect.gen(function* () {
			if (optionalValue(artifact) !== undefined || optionalValue(project) !== undefined) {
				return yield* Effect.fail(
					new CliCommandError({ message: "plugins list only accepts a manifest path" })
				);
			}
			const manifestPath = yield* resolvePluginPath(
				manifest,
				manifestFlag,
				"plugins list requires a manifest path"
			);
			return yield* runModel(CliCommand.cases.PluginsList.make({ manifestPath }));
		})
).pipe(Command.withDescription("List plugins in a release manifest."));

const pluginsVerifyCommand = Command.make(
	"verify",
	{
		manifest: pluginManifestArgument,
		manifestFlag: pluginManifestFlag,
		artifact: pluginArtifactFlag,
		project: pluginProjectFlag
	},
	({ manifest, manifestFlag, artifact, project }) =>
		Effect.gen(function* () {
			const projectValue = optionalValue(project);
			const artifactValue = optionalValue(artifact);
			if (projectValue !== undefined) {
				return yield* Effect.fail(
					new CliCommandError({ message: "plugins verify does not accept --project" })
				);
			}
			const manifestPath = yield* resolvePluginPath(
				manifest,
				manifestFlag,
				"plugins verify requires a manifest path"
			);
			return yield* runModel(
				CliCommand.cases.PluginsVerify.make({
					manifestPath,
					...(artifactValue === undefined ? {} : { artifactPath: artifactValue })
				})
			);
		})
).pipe(Command.withDescription("Verify a plugin release manifest and artifact."));

const pluginsInstallCommand = Command.make(
	"install",
	{
		project: Argument.string("project").pipe(Argument.optional),
		projectFlag: pluginProjectFlag,
		manifest: Flag.string("manifest"),
		artifact: pluginArtifactFlag
	},
	({ project, projectFlag, manifest, artifact }) =>
		Effect.gen(function* () {
			const projectRoot = yield* resolvePluginPath(
				project,
				projectFlag,
				"plugins install requires --project <project-root-or-uproject>"
			);
			const artifactValue = optionalValue(artifact);
			return yield* runModel(
				CliCommand.cases.PluginsInstall.make({
					manifestPath: manifest,
					projectRoot,
					...(artifactValue === undefined ? {} : { artifactPath: artifactValue })
				})
			);
		})
).pipe(Command.withDescription("Install a plugin bundle into a project."));

const pluginsCommand = Command.make("plugins").pipe(
	Command.withDescription("Inspect, verify, and install plugin bundles."),
	Command.withSubcommands([pluginsListCommand, pluginsVerifyCommand, pluginsInstallCommand])
);

export const cliCommand = Command.make("ue-shed").pipe(
	Command.withDescription("UE Shed — External tools for Unreal Engine development."),
	Command.withSubcommands([
		versionCommand,
		doctorCommand,
		editorCommand,
		auditCommand,
		authoringCommand,
		assetsCommand,
		textCommand,
		inputCommand,
		mapCommand,
		reviewCommand,
		pluginsCommand
	])
);

const cliFormatter = (() => {
	const formatter = CliOutput.defaultFormatter({ colors: false });
	return CliOutput.layer({
		...formatter,
		formatErrors: (errors) =>
			errors.map((error) => `ue-shed: ${formatter.formatCliError(error)}`).join("\n"),
		formatVersion: (name, value) => `${name} ${value}`
	});
})();

function makeBufferedConsole(help: string[], errors: string[]): Console.Console {
	return {
		...globalThis.console,
		log: (...args) => help.push(args.map(String).join(" ")),
		error: (...args) => errors.push(args.map(String).join(" "))
	};
}

function normalizeArgs(args: readonly string[]): ReadonlyArray<string> {
	return args.length === 0 || args[0] === "help" ? ["--help"] : args;
}

export function runCli(args: readonly string[]): Effect.Effect<void, CliCommandError, CliRuntime> {
	return Effect.gen(function* () {
		const runtime = yield* CliRuntime;
		const help = [] as string[];
		const errors = [] as string[];
		const consoleLayer = Layer.succeed(Console.Console, makeBufferedConsole(help, errors));
		const result = yield* Effect.exit(
			Command.runWith(cliCommand, { version })(normalizeArgs(args)).pipe(
				Effect.provide(cliFormatter),
				Effect.provide(consoleLayer),
				Effect.provide(NodeServices.layer)
			)
		);
		if (Exit.isSuccess(result)) {
			for (const message of help) yield* runtime.print(`${message}\n`);
			return;
		}
		const error = Cause.findErrorOption(result.cause);
		if (Option.isSome(error) && CliError.isCliError(error.value)) {
			if (errors.length > 0) {
				yield* runtime.printError(`${errors.join("\n")}\n`);
			} else {
				yield* runtime.printError(`ue-shed: ${error.value.message}\n`);
			}
			yield* runtime.setExitCode(2);
			return;
		}
		if (Option.isSome(error) && error.value instanceof CliCommandError) {
			return yield* Effect.fail<CliCommandError>(error.value);
		}
		return yield* Effect.die(error);
	});
}
