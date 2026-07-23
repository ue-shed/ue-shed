import { AuthoringValue } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";

const Reader = { reader: Schema.optionalKey(Schema.String) };
const Project = { projectRoot: Schema.String };
const SessionProject = { projectRoot: Schema.String, sessionId: Schema.String };

export const CliCommand = Schema.TaggedUnion({
	Help: {},
	Version: {},
	Doctor: {},
	EditorPlaySession: {
		action: Schema.Literals(["status", "start", "simulate", "pause", "resume", "stop"]),
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
	TextScan: { ...Project, ...Reader },
	TextSearch: { ...Project, query: Schema.String, ...Reader },
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
	ReviewCapture: { endpoint: Schema.String, ...Project, reviewSetPath: Schema.String },
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

export class CliUsageError extends Schema.TaggedErrorClass<CliUsageError>()("CliUsageError", {
	message: Schema.String
}) {}

export const help = `UE Shed — External tools for Unreal Engine development.

Usage:
  ue-shed audit textures <project-root> --rules <rule-file> [--reader <path>]
  ue-shed authoring tables <project-root> [--reader <path>]
  ue-shed authoring relationships <project-root> [--reader <path>]
  ue-shed authoring join <project-root> <source-table> <reference-field> [--reader <path>]
  ue-shed authoring catalog <project-root> [--endpoint <url>] [--reader <path>]
  ue-shed authoring parity <project-root> <endpoint> [--reader <path>]
  ue-shed authoring inspect <asset> [--reader <path>]
  ue-shed authoring live tables <endpoint>
  ue-shed authoring live inspect <endpoint> <table>
  ue-shed authoring sessions list --project <project-root>
  ue-shed authoring sessions create <asset> --project <project-root> [--id <session-id>] [--reader <path>]
  ue-shed authoring sessions show|resume|close|discard|undo|redo <session-id> --project <project-root>
  ue-shed authoring sessions set-cell <session-id> <table> <row-id> <field> <value-json> --project <project-root>
  ue-shed authoring sessions add-row <session-id> <table> <row-name> --project <project-root> [--index <index>]
  ue-shed authoring sessions duplicate-row <session-id> <table> <source-row-id> <row-name> --project <project-root> [--index <index>]
  ue-shed authoring sessions remove-row <session-id> <table> <row-id> --project <project-root>
  ue-shed authoring sessions rename-row <session-id> <table> <row-id> <row-name> --project <project-root>
  ue-shed authoring sessions reorder-rows <session-id> <table> <row-ids-json> --project <project-root>
  ue-shed authoring sessions review|validate|diff <session-id> --project <project-root>
  ue-shed authoring sessions apply|reconcile|save <session-id> <endpoint> --project <project-root>
  ue-shed text scan <project-root> [--reader <path>]
  ue-shed text search <project-root> <query> [--reader <path>]
  ue-shed review sets validate <review-set>
	ue-shed review framing candidates <endpoint>
	ue-shed review framing approve <review-set> <endpoint> <view-id> <candidate-id>
	ue-shed review authoring bootstrap <project-root> <endpoint>
	ue-shed review authoring start <project-root> <review-set> <endpoint> <view-id>
	ue-shed review authoring show|discard <project-root> <session-id>
	ue-shed review authoring resume|reframe|approve <project-root> <session-id> <endpoint>
	ue-shed review capture <project-root> <review-set> <endpoint>
  ue-shed review history <project-root>
  ue-shed review show <run-json>
	  ue-shed plugins list <manifest> (or --manifest <manifest>)
	  ue-shed plugins verify <manifest> [--artifact <archive>]
  ue-shed plugins install --project <project-root-or-uproject> --manifest <manifest> [--artifact <archive>]
  ue-shed editor play status|start|simulate|pause|resume|stop <endpoint>
  ue-shed version
  ue-shed doctor
  ue-shed help

The reader defaults to UE_SHED_UASSET_EXECUTABLE or uasset on PATH.`;

interface ParsedOptions {
	readonly positionals: readonly string[];
	readonly values: Readonly<Record<string, string>>;
}

function usage(message: string): Effect.Effect<never, CliUsageError> {
	return Effect.fail(new CliUsageError({ message }));
}

function parseOptions(
	args: readonly string[],
	allowed: readonly string[]
): Effect.Effect<ParsedOptions, CliUsageError> {
	return Effect.gen(function* () {
		const values: Record<string, string> = {};
		const positionals: string[] = [];
		for (let index = 0; index < args.length; index += 1) {
			const value = args[index];
			if (value === undefined) continue;
			if (!value.startsWith("--")) {
				positionals.push(value);
				continue;
			}
			if (!allowed.includes(value)) return yield* usage(`Unknown option: ${value}`);
			if (values[value] !== undefined)
				return yield* usage(`${value} may only be provided once`);
			const optionValue = args[index + 1];
			if (optionValue === undefined || optionValue.startsWith("--")) {
				return yield* usage(`${value} requires a value`);
			}
			values[value] = optionValue;
			index += 1;
		}
		return { positionals, values };
	});
}

function exact(
	values: readonly string[],
	count: number,
	message: string
): Effect.Effect<readonly string[], CliUsageError> {
	return values.length === count ? Effect.succeed(values) : usage(message);
}

function present(value: string | undefined): string {
	if (value === undefined) throw new Error("CLI parser arity invariant was violated");
	return value;
}

function parseValue(valueJson: string): Effect.Effect<typeof AuthoringValue.Type, CliUsageError> {
	return Effect.try({
		try: () => JSON.parse(valueJson) as unknown,
		catch: (cause) => new CliUsageError({ message: `Invalid value JSON: ${String(cause)}` })
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(AuthoringValue)),
		Effect.mapError((cause) =>
			cause instanceof CliUsageError
				? cause
				: new CliUsageError({ message: `Invalid authoring value: ${String(cause)}` })
		)
	);
}

function parseIndex(value: string | undefined): Effect.Effect<number | undefined, CliUsageError> {
	if (value === undefined) return Effect.succeed(undefined);
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0
		? Effect.succeed(parsed)
		: usage(`Invalid non-negative row index: ${value}`);
}

function parseRowIds(value: string): Effect.Effect<readonly string[], CliUsageError> {
	return Effect.try({
		try: () => JSON.parse(value) as unknown,
		catch: (cause) => new CliUsageError({ message: `Invalid row IDs JSON: ${String(cause)}` })
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.String))),
		Effect.mapError((cause) =>
			cause instanceof CliUsageError
				? cause
				: new CliUsageError({ message: `Invalid row IDs: ${String(cause)}` })
		)
	);
}

function parseSessions(args: readonly string[]): Effect.Effect<CliCommand, CliUsageError> {
	return Effect.gen(function* () {
		const [action, ...rest] = args;
		const parsed = yield* parseOptions(rest, ["--project", "--id", "--index", "--reader"]);
		const projectRoot = parsed.values["--project"];
		if (!action || !projectRoot) return yield* usage(`sessions ${action} requires --project`);
		const p = parsed.positionals;
		if (action === "list") {
			yield* exact(p, 0, "sessions list has unexpected arguments");
			return CliCommand.cases.SessionsList.make({ projectRoot });
		}
		if (action === "create") {
			const [assetPath] = yield* exact(
				p,
				1,
				"sessions create requires exactly one saved DataTable asset"
			);
			return CliCommand.cases.SessionsCreate.make({
				assetPath: present(assetPath),
				projectRoot,
				...(parsed.values["--id"] ? { id: parsed.values["--id"] } : {}),
				...(parsed.values["--reader"] ? { reader: parsed.values["--reader"] } : {})
			});
		}
		if (["show", "resume", "close", "discard", "undo", "redo"].includes(action)) {
			const [sessionId] = yield* exact(
				p,
				1,
				`sessions ${action} requires exactly one session id`
			);
			const fields = { projectRoot, sessionId: present(sessionId) };
			switch (action) {
				case "show":
					return CliCommand.cases.SessionsShow.make(fields);
				case "resume":
					return CliCommand.cases.SessionsResume.make(fields);
				case "close":
					return CliCommand.cases.SessionsClose.make(fields);
				case "discard":
					return CliCommand.cases.SessionsDiscard.make(fields);
				case "undo":
					return CliCommand.cases.SessionsUndo.make(fields);
				default:
					return CliCommand.cases.SessionsRedo.make(fields);
			}
		}
		if (["review", "validate", "diff"].includes(action)) {
			const [sessionId] = yield* exact(
				p,
				1,
				`sessions ${action} requires exactly one session id`
			);
			const fields = { projectRoot, sessionId: present(sessionId) };
			return action === "review"
				? CliCommand.cases.SessionsReview.make(fields)
				: action === "validate"
					? CliCommand.cases.SessionsValidate.make(fields)
					: CliCommand.cases.SessionsDiff.make(fields);
		}
		if (action === "set-cell") {
			const [sessionId, tablePath, rowId, fieldName, valueJson] = yield* exact(
				p,
				5,
				"sessions set-cell requires session, table, row, field, and value JSON"
			);
			return CliCommand.cases.SessionsSetCell.make({
				fieldName: present(fieldName),
				projectRoot,
				rowId: present(rowId),
				sessionId: present(sessionId),
				tablePath: present(tablePath),
				value: yield* parseValue(present(valueJson))
			});
		}
		if (action === "add-row") {
			const [sessionId, tablePath, rowName] = yield* exact(
				p,
				3,
				"sessions add-row requires session, table, and row name"
			);
			const atIndex = yield* parseIndex(parsed.values["--index"]);
			return CliCommand.cases.SessionsAddRow.make({
				projectRoot,
				rowName: present(rowName),
				sessionId: present(sessionId),
				tablePath: present(tablePath),
				...(atIndex === undefined ? {} : { atIndex })
			});
		}
		if (action === "duplicate-row") {
			const [sessionId, tablePath, sourceRowId, rowName] = yield* exact(
				p,
				4,
				"sessions duplicate-row requires session, table, source row id, and row name"
			);
			const atIndex = yield* parseIndex(parsed.values["--index"]);
			return CliCommand.cases.SessionsDuplicateRow.make({
				projectRoot,
				rowName: present(rowName),
				sessionId: present(sessionId),
				sourceRowId: present(sourceRowId),
				tablePath: present(tablePath),
				...(atIndex === undefined ? {} : { atIndex })
			});
		}
		if (action === "remove-row") {
			const [sessionId, tablePath, rowId] = yield* exact(
				p,
				3,
				"sessions remove-row requires session, table, and row id"
			);
			return CliCommand.cases.SessionsRemoveRow.make({
				projectRoot,
				rowId: present(rowId),
				sessionId: present(sessionId),
				tablePath: present(tablePath)
			});
		}
		if (action === "rename-row") {
			const [sessionId, tablePath, rowId, rowName] = yield* exact(
				p,
				4,
				"sessions rename-row requires session, table, row id, and row name"
			);
			return CliCommand.cases.SessionsRenameRow.make({
				projectRoot,
				rowId: present(rowId),
				rowName: present(rowName),
				sessionId: present(sessionId),
				tablePath: present(tablePath)
			});
		}
		if (action === "reorder-rows") {
			const [sessionId, tablePath, rowIdsJson] = yield* exact(
				p,
				3,
				"sessions reorder-rows requires session, table, and row IDs JSON"
			);
			return CliCommand.cases.SessionsReorderRows.make({
				projectRoot,
				rowIds: yield* parseRowIds(present(rowIdsJson)),
				sessionId: present(sessionId),
				tablePath: present(tablePath)
			});
		}
		if (["apply", "reconcile", "save"].includes(action)) {
			const [sessionId, endpoint] = yield* exact(
				p,
				2,
				`sessions ${action} requires session id and endpoint`
			);
			const fields = {
				endpoint: present(endpoint),
				projectRoot,
				sessionId: present(sessionId)
			};
			return action === "apply"
				? CliCommand.cases.SessionsApply.make(fields)
				: action === "reconcile"
					? CliCommand.cases.SessionsReconcile.make(fields)
					: CliCommand.cases.SessionsSave.make(fields);
		}
		return yield* usage(`Unknown authoring sessions command: ${action}`);
	});
}

function parseAuthoring(args: readonly string[]): Effect.Effect<CliCommand, CliUsageError> {
	return Effect.gen(function* () {
		const [area, action, ...rest] = args;
		if (area === "sessions") return yield* parseSessions([action ?? "", ...rest]);
		const parsed = yield* parseOptions([action ?? "", ...rest], ["--reader", "--endpoint"]);
		const p = parsed.positionals.filter((value, index) => index > 0 || value !== "");
		const nested = p.slice(1);
		const reader = parsed.values["--reader"];
		const withReader = reader ? { reader } : {};
		if (area === "tables") {
			const [projectRoot] = yield* exact(p, 1, "authoring tables requires a project root");
			return CliCommand.cases.AuthoringTables.make({
				projectRoot: present(projectRoot),
				...withReader
			});
		}
		if (area === "relationships") {
			const [projectRoot] = yield* exact(
				p,
				1,
				"authoring relationships requires a project root"
			);
			return CliCommand.cases.AuthoringRelationships.make({
				projectRoot: present(projectRoot),
				...withReader
			});
		}
		if (area === "join") {
			const [projectRoot, sourceTableObjectPath, referenceFieldName] = yield* exact(
				p,
				3,
				"authoring join requires a project root, source table, and reference field"
			);
			return CliCommand.cases.AuthoringJoin.make({
				projectRoot: present(projectRoot),
				referenceFieldName: present(referenceFieldName),
				sourceTableObjectPath: present(sourceTableObjectPath),
				...withReader
			});
		}
		if (area === "catalog") {
			const [projectRoot] = yield* exact(p, 1, "authoring catalog requires a project root");
			return CliCommand.cases.AuthoringCatalog.make({
				projectRoot: present(projectRoot),
				...(parsed.values["--endpoint"] ? { endpoint: parsed.values["--endpoint"] } : {}),
				...withReader
			});
		}
		if (area === "parity") {
			const [projectRoot, endpoint] = yield* exact(
				p,
				2,
				"authoring parity requires a project root and live endpoint"
			);
			return CliCommand.cases.AuthoringParity.make({
				endpoint: present(endpoint),
				projectRoot: present(projectRoot),
				...withReader
			});
		}
		if (area === "inspect") {
			const [assetPath] = yield* exact(p, 1, "authoring inspect requires an asset path");
			return CliCommand.cases.AuthoringInspect.make({
				assetPath: present(assetPath),
				...withReader
			});
		}
		if (area === "live" && action === "tables") {
			const [endpoint] = yield* exact(nested, 1, "live tables requires an endpoint");
			return CliCommand.cases.AuthoringLiveTables.make({ endpoint: present(endpoint) });
		}
		if (area === "live" && action === "inspect") {
			const [endpoint, tablePath] = yield* exact(
				nested,
				2,
				"live inspect requires endpoint and table"
			);
			return CliCommand.cases.AuthoringLiveInspect.make({
				endpoint: present(endpoint),
				tablePath: present(tablePath)
			});
		}
		return yield* usage(`Unknown authoring command\n\n${help}`);
	});
}

function parsePlugins(args: readonly string[]): Effect.Effect<CliCommand, CliUsageError> {
	return Effect.gen(function* () {
		const [action, ...rest] = args;
		const parsed = yield* parseOptions(rest, ["--artifact", "--manifest", "--project"]);
		const [positional] = parsed.positionals;
		const manifestPath = parsed.values["--manifest"] ?? positional;
		if (parsed.values["--manifest"] !== undefined && positional !== undefined)
			return yield* usage(
				"plugins accepts the manifest either positionally or with --manifest, not both"
			);
		if (action === "list") {
			if (parsed.values["--artifact"] || parsed.values["--project"])
				return yield* usage("plugins list only accepts a manifest path");
			if (!manifestPath) return yield* usage("plugins list requires a manifest path");
			if (parsed.positionals.length > 1)
				return yield* usage("plugins list has unexpected arguments");
			return CliCommand.cases.PluginsList.make({ manifestPath });
		}
		if (action === "verify") {
			if (parsed.values["--project"])
				return yield* usage("plugins verify does not accept --project");
			if (!manifestPath) return yield* usage("plugins verify requires a manifest path");
			if (parsed.positionals.length > 1)
				return yield* usage("plugins verify has unexpected arguments");
			return CliCommand.cases.PluginsVerify.make({
				...(parsed.values["--artifact"]
					? { artifactPath: parsed.values["--artifact"] }
					: {}),
				manifestPath
			});
		}
		if (action === "install") {
			const projectRoot = parsed.values["--project"] ?? positional;
			if (parsed.values["--project"] !== undefined && positional !== undefined)
				return yield* usage(
					"plugins install accepts the project either positionally or with --project, not both"
				);
			if (!projectRoot)
				return yield* usage(
					"plugins install requires --project <project-root-or-uproject>"
				);
			if (!parsed.values["--manifest"])
				return yield* usage("plugins install requires --manifest <manifest>");
			if (parsed.positionals.length > 1)
				return yield* usage("plugins install has unexpected arguments");
			return CliCommand.cases.PluginsInstall.make({
				...(parsed.values["--artifact"]
					? { artifactPath: parsed.values["--artifact"] }
					: {}),
				manifestPath: parsed.values["--manifest"],
				projectRoot
			});
		}
		return yield* usage(`Unknown plugins command: ${action ?? ""}\n\n${help}`);
	});
}

export function parseCliCommand(args: readonly string[]): Effect.Effect<CliCommand, CliUsageError> {
	return Effect.gen(function* () {
		const [command, ...rest] = args;
		if (command === undefined || ["help", "--help", "-h"].includes(command))
			return CliCommand.cases.Help.make({});
		if (["version", "--version", "-v"].includes(command))
			return CliCommand.cases.Version.make({});
		if (command === "doctor") return CliCommand.cases.Doctor.make({});
		if (command === "editor") {
			const [area, action, endpoint, ...extra] = rest;
			if (
				area !== "play" ||
				!action ||
				!["status", "start", "simulate", "pause", "resume", "stop"].includes(action) ||
				!endpoint ||
				extra.length > 0
			) {
				return yield* usage(
					"editor play requires status, start, simulate, pause, resume, or stop and one endpoint"
				);
			}
			return CliCommand.cases.EditorPlaySession.make({
				action: yield* Schema.decodeUnknownEffect(
					CliCommand.cases.EditorPlaySession.fields.action
				)(action).pipe(
					Effect.mapError(
						() => new CliUsageError({ message: `Unknown play action: ${action}` })
					)
				),
				endpoint
			});
		}
		if (command === "authoring") return yield* parseAuthoring(rest);
		if (command === "plugins") return yield* parsePlugins(rest);
		if (command === "audit") {
			const [kind, projectRoot, ...flags] = rest;
			if (kind !== "textures" || !projectRoot)
				return yield* usage(`audit textures requires a project root\n\n${help}`);
			const parsed = yield* parseOptions(flags, ["--rules", "--reader"]);
			if (parsed.positionals.length > 0)
				return yield* usage(`Unknown audit option: ${parsed.positionals[0]}`);
			const ruleFile = parsed.values["--rules"];
			if (!ruleFile) return yield* usage("audit textures requires --rules <rule-file>");
			return CliCommand.cases.AuditTextures.make({
				projectRoot,
				ruleFile,
				...(parsed.values["--reader"] ? { reader: parsed.values["--reader"] } : {})
			});
		}
		if (command === "text") {
			const parsed = yield* parseOptions(rest, ["--reader"]);
			const [action, projectRoot, ...query] = parsed.positionals;
			if ((action !== "scan" && action !== "search") || !projectRoot)
				return yield* usage(
					"text requires scan <project-root> or search <project-root> <query>"
				);
			const withReader = parsed.values["--reader"]
				? { reader: parsed.values["--reader"] }
				: {};
			if (action === "scan") {
				yield* exact(query, 0, "text scan has unexpected arguments");
				return CliCommand.cases.TextScan.make({ projectRoot, ...withReader });
			}
			const value = query.join(" ").trim();
			if (!value) return yield* usage("text search requires a non-empty query");
			return CliCommand.cases.TextSearch.make({ projectRoot, query: value, ...withReader });
		}
		if (command === "review") {
			const [area, action, ...values] = rest;
			if (area === "sets" && action === "validate") {
				const [reviewSetPath] = yield* exact(
					values,
					1,
					"review sets validate requires exactly one Review Set path"
				);
				return CliCommand.cases.ReviewSetValidate.make({
					reviewSetPath: present(reviewSetPath)
				});
			}
			if (area === "framing" && action === "candidates") {
				const [endpoint] = yield* exact(
					values,
					1,
					"review framing candidates requires exactly one Remote Control endpoint"
				);
				return CliCommand.cases.ReviewFramingCandidates.make({
					endpoint: present(endpoint)
				});
			}
			if (area === "framing" && action === "approve") {
				const [reviewSetPath, endpoint, viewId, candidateId] = yield* exact(
					values,
					4,
					"review framing approve requires Review Set, endpoint, Review View ID, and candidate ID"
				);
				return CliCommand.cases.ReviewFramingApprove.make({
					candidateId: present(candidateId),
					endpoint: present(endpoint),
					reviewSetPath: present(reviewSetPath),
					viewId: present(viewId)
				});
			}
			if (area === "authoring" && action === "start") {
				const [projectRoot, reviewSetPath, endpoint, viewId] = yield* exact(
					values,
					4,
					"review authoring start requires project root, Review Set, endpoint, and Review View ID"
				);
				return CliCommand.cases.ReviewAuthoringStart.make({
					endpoint: present(endpoint),
					projectRoot: present(projectRoot),
					reviewSetPath: present(reviewSetPath),
					viewId: present(viewId)
				});
			}
			if (area === "authoring" && action === "bootstrap") {
				const [projectRoot, endpoint] = yield* exact(
					values,
					2,
					"review authoring bootstrap requires project root and Remote Control endpoint"
				);
				return CliCommand.cases.ReviewAuthoringBootstrap.make({
					endpoint: present(endpoint),
					projectRoot: present(projectRoot)
				});
			}
			if (area === "authoring" && (action === "show" || action === "discard")) {
				const [projectRoot, sessionId] = yield* exact(
					values,
					2,
					`review authoring ${action} requires project root and session ID`
				);
				const fields = { projectRoot: present(projectRoot), sessionId: present(sessionId) };
				return action === "show"
					? CliCommand.cases.ReviewAuthoringShow.make(fields)
					: CliCommand.cases.ReviewAuthoringDiscard.make(fields);
			}
			if (
				area === "authoring" &&
				(action === "resume" || action === "reframe" || action === "approve")
			) {
				const [projectRoot, sessionId, endpoint] = yield* exact(
					values,
					3,
					`review authoring ${action} requires project root, session ID, and endpoint`
				);
				const fields = {
					endpoint: present(endpoint),
					projectRoot: present(projectRoot),
					sessionId: present(sessionId)
				};
				return action === "resume"
					? CliCommand.cases.ReviewAuthoringResume.make(fields)
					: action === "reframe"
						? CliCommand.cases.ReviewAuthoringReframe.make(fields)
						: CliCommand.cases.ReviewAuthoringApprove.make(fields);
			}
			if (area === "capture") {
				const [projectRoot, reviewSetPath, endpoint] = yield* exact(
					[action ?? "", ...values],
					3,
					"review capture requires project root, Review Set path, and Remote Control endpoint"
				);
				return CliCommand.cases.ReviewCapture.make({
					endpoint: present(endpoint),
					projectRoot: present(projectRoot),
					reviewSetPath: present(reviewSetPath)
				});
			}
			if (area === "history") {
				const [projectRoot] = yield* exact(
					[action ?? "", ...values],
					1,
					"review history requires exactly one project root"
				);
				return CliCommand.cases.ReviewHistory.make({ projectRoot: present(projectRoot) });
			}
			if (area === "show") {
				const [runPath] = yield* exact(
					[action ?? "", ...values],
					1,
					"review show requires exactly one run.json path"
				);
				return CliCommand.cases.ReviewShow.make({ runPath: present(runPath) });
			}
			return yield* usage(`Unknown review command\n\n${help}`);
		}
		return yield* usage(`Unknown command: ${command}\n\n${help}`);
	});
}
