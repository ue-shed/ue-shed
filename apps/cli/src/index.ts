import { randomUUID } from "node:crypto";
import { scanTextureAudit } from "@ue-shed/asset-audits";
import {
	appendCommandGroup,
	acceptSaveResult,
	buildSaveRequest,
	buildSetCellCommand,
	createDraftSession,
	dispatchApply,
	fingerprintTable,
	loadDraftSession,
	makeAuthoringSessionService,
	redo,
	saveDraftSession,
	undo,
	workingTable
} from "@ue-shed/authoring";
import { discoverAuthoringProjectCatalog } from "@ue-shed/authoring-catalog";
import { scanTextCorpus, searchTextCorpus } from "@ue-shed/game-text";
import { CURRENT_PROTOCOL_VERSION, decodeAuthoringValue } from "@ue-shed/protocol";
import { discoverSavedTables, readSavedTable } from "@ue-shed/unreal-assets";
import { connectUnrealAuthoring } from "@ue-shed/unreal-connection";
import { Effect } from "effect";

const help = `UE Shed — External tools for Unreal Engine development.

Usage:
  ue-shed audit textures <project-root> --rules <rule-file> [--reader <path>]
  ue-shed authoring tables <project-root> [--reader <path>]
  ue-shed authoring catalog <project-root> [--endpoint <url>] [--reader <path>]
  ue-shed authoring parity <project-root> <endpoint> [--reader <path>]
  ue-shed authoring inspect <asset> [--reader <path>]
  ue-shed authoring live tables <endpoint>
  ue-shed authoring live inspect <endpoint> <table>
  ue-shed authoring sessions list --project <project-root>
  ue-shed authoring sessions create <asset> --project <project-root> [--id <session-id>] [--reader <path>]
  ue-shed authoring sessions show|resume|close|discard|undo|redo <session-id> --project <project-root>
  ue-shed authoring sessions set-cell <session-id> <table> <row> <field> <value-json> --project <project-root>
  ue-shed authoring sessions apply|reconcile|save <session-id> <endpoint> --project <project-root>
  ue-shed authoring session create <asset> <session-file> [--reader <path>]
  ue-shed authoring session create-live <endpoint> <table> <session-file>
  ue-shed authoring session show <session-file>
  ue-shed authoring draft set-cell <session-file> <table> <row> <field> <value-json>
  ue-shed authoring draft undo <session-file>
  ue-shed authoring draft redo <session-file>
  ue-shed authoring apply <session-file> <endpoint>
  ue-shed authoring apply-status <endpoint> <operation-id>
  ue-shed authoring save <session-file> <endpoint>
  ue-shed text scan <project-root> [--reader <path>]
  ue-shed text search <project-root> <query> [--reader <path>]
  ue-shed version
  ue-shed help

The reader defaults to UE_SHED_UASSET_EXECUTABLE or uasset on PATH.`;

function takeReader(args: readonly string[]): { args: string[]; reader?: string } {
	const remaining = [...args];
	const index = remaining.indexOf("--reader");
	if (index === -1) return { args: remaining };
	const reader = remaining[index + 1];
	if (!reader) throw new Error("--reader requires an executable path");
	remaining.splice(index, 2);
	return { args: remaining, reader };
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, "\t")}\n`);
}

function takeOption(args: readonly string[], option: string): { args: string[]; value?: string } {
	const remaining = [...args];
	const index = remaining.indexOf(option);
	if (index === -1) return { args: remaining };
	const value = remaining[index + 1];
	if (!value) throw new Error(`${option} requires a value`);
	remaining.splice(index, 2);
	return { args: remaining, value };
}

async function audit(args: readonly string[]): Promise<void> {
	const [kind, projectRoot, ...flags] = args;
	if (kind !== "textures" || !projectRoot) {
		throw new Error("audit textures requires a project root\n\n" + help);
	}
	let ruleFile: string | undefined;
	let reader: string | undefined;
	for (let index = 0; index < flags.length; index += 2) {
		const flag = flags[index];
		const value = flags[index + 1];
		if (!flag || !value) throw new Error(`${flag ?? "Audit flag"} requires a value`);
		if (flag === "--rules") {
			if (ruleFile) throw new Error("--rules may only be provided once");
			ruleFile = value;
		} else if (flag === "--reader") {
			if (reader) throw new Error("--reader may only be provided once");
			reader = value;
		} else {
			throw new Error(`Unknown audit option: ${flag}`);
		}
	}
	if (!ruleFile) throw new Error("audit textures requires --rules <rule-file>");
	const report = await Effect.runPromise(
		scanTextureAudit({
			projectRoot,
			ruleFile,
			...(reader ? { readerExecutable: reader } : {})
		})
	);
	printJson(report);
}

async function authoring(args: readonly string[]): Promise<void> {
	const parsed = takeReader(args);
	const [area, action, ...rest] = parsed.args;
	if (area === "tables") {
		const projectRoot = action;
		if (!projectRoot) throw new Error("authoring tables requires a project root");
		const catalog = await Effect.runPromise(
			discoverSavedTables({
				projectRoot,
				...(parsed.reader ? { executable: parsed.reader } : {})
			})
		);
		printJson(catalog);
		return;
	}
	if (area === "catalog") {
		const projectRoot = action;
		if (!projectRoot) throw new Error("authoring catalog requires a project root");
		let endpoint: string | undefined;
		for (let index = 0; index < rest.length; index += 2) {
			const flag = rest[index];
			const value = rest[index + 1];
			if (flag !== "--endpoint" || !value) {
				throw new Error(
					`Unknown or incomplete authoring catalog option: ${flag ?? "missing"}`
				);
			}
			if (endpoint) throw new Error("--endpoint may only be provided once");
			endpoint = value;
		}
		const live = endpoint
			? await Effect.runPromise(connectUnrealAuthoring(endpoint))
			: undefined;
		printJson(
			await Effect.runPromise(
				discoverAuthoringProjectCatalog({
					...(live ? { live } : {}),
					projectRoot,
					...(parsed.reader ? { readerExecutable: parsed.reader } : {})
				})
			)
		);
		return;
	}
	if (area === "parity") {
		const projectRoot = action;
		const [endpoint] = rest;
		if (!projectRoot || !endpoint) {
			throw new Error("authoring parity requires a project root and live endpoint");
		}
		const live = await Effect.runPromise(connectUnrealAuthoring(endpoint));
		const catalog = await Effect.runPromise(
			discoverAuthoringProjectCatalog({
				live,
				projectRoot,
				...(parsed.reader ? { readerExecutable: parsed.reader } : {})
			})
		);
		const missingAuthorities = catalog.tables
			.filter(
				(table) =>
					!table.authorities.some(({ authority }) => authority === "saved") ||
					!table.authorities.some(({ authority }) => authority === "live")
			)
			.map(({ objectPath }) => objectPath);
		const diverged = catalog.tables.flatMap((table) =>
			table.divergence.status === "detected"
				? [{ fields: table.divergence.fields, objectPath: table.objectPath }]
				: []
		);
		const schemaGaps = catalog.tables.flatMap((table) => {
			const unavailable = table.authorities
				.filter(({ schema }) => schema.status === "unavailable")
				.map(({ authority }) => authority);
			return unavailable.length > 0
				? [{ authorities: unavailable, objectPath: table.objectPath }]
				: [];
		});
		const savedTables = await Effect.runPromise(
			discoverSavedTables({
				projectRoot,
				...(parsed.reader ? { executable: parsed.reader } : {})
			})
		);
		const savedSnapshots = await Effect.runPromise(
			Effect.forEach(
				savedTables.tables,
				(table) =>
					readSavedTable({
						assetPath: table.assetPath,
						...(parsed.reader ? { executable: parsed.reader } : {})
					}),
				{ concurrency: 4 }
			)
		);
		const liveSnapshots = await Effect.runPromise(
			live
				.listTableObjectPaths()
				.pipe(
					Effect.flatMap((objectPaths) =>
						Effect.forEach(
							objectPaths,
							(objectPath) => live.getTableSnapshot(objectPath),
							{ concurrency: 4 }
						)
					)
				)
		);
		const liveByPath = new Map(
			liveSnapshots.map((snapshot) => [snapshot.table.objectPath, snapshot])
		);
		const semanticMismatches = savedSnapshots.flatMap((savedSnapshot) => {
			const liveSnapshot = liveByPath.get(savedSnapshot.table.objectPath);
			if (!liveSnapshot) return [];
			const savedFingerprint = fingerprintTable(savedSnapshot);
			const liveFingerprint = fingerprintTable(liveSnapshot);
			return savedFingerprint === liveFingerprint
				? []
				: [
						{
							liveFingerprint,
							objectPath: savedSnapshot.table.objectPath,
							savedFingerprint
						}
					];
		});
		const status =
			catalog.diagnostics.length === 0 &&
			missingAuthorities.length === 0 &&
			diverged.length === 0 &&
			semanticMismatches.length === 0
				? "conformant"
				: "nonconformant";
		printJson({
			contract: { name: "unreal-authoring-parity", version: { major: 1, minor: 0 } },
			diagnostics: catalog.diagnostics,
			diverged,
			missingAuthorities,
			schemaGaps,
			semanticMismatches,
			status
		});
		if (status === "nonconformant") {
			throw new Error("Saved/live authoring parity did not pass");
		}
		return;
	}
	if (area === "inspect") {
		const [assetPath] = [action, ...rest];
		if (!assetPath) throw new Error("authoring inspect requires an asset path");
		const snapshot = await Effect.runPromise(
			readSavedTable({ assetPath, ...(parsed.reader ? { executable: parsed.reader } : {}) })
		);
		printJson({ fingerprint: fingerprintTable(snapshot), snapshot });
		return;
	}
	if (area === "live" && action === "inspect") {
		const [endpoint, tablePath] = rest;
		if (!endpoint || !tablePath) throw new Error("live inspect requires endpoint and table");
		const connection = await Effect.runPromise(connectUnrealAuthoring(endpoint));
		const snapshot = await Effect.runPromise(connection.getTableSnapshot(tablePath));
		printJson({ fingerprint: fingerprintTable(snapshot), snapshot });
		return;
	}
	if (area === "live" && action === "tables") {
		const [endpoint] = rest;
		if (!endpoint) throw new Error("live tables requires an endpoint");
		const live = await Effect.runPromise(connectUnrealAuthoring(endpoint));
		printJson(await Effect.runPromise(discoverAuthoringProjectCatalog({ live })));
		return;
	}
	if (area === "sessions") {
		const projectOption = takeOption(rest, "--project");
		if (!projectOption.value) throw new Error(`sessions ${action} requires --project`);
		const idOption = takeOption(projectOption.args, "--id");
		const service = Effect.runSync(
			makeAuthoringSessionService({ projectRoot: projectOption.value })
		);
		if (action === "list") {
			if (idOption.args.length > 0) throw new Error("sessions list has unexpected arguments");
			printJson(await Effect.runPromise(service.list()));
			return;
		}
		if (action === "create") {
			const [assetPath, ...unexpected] = idOption.args;
			if (!assetPath || unexpected.length > 0) {
				throw new Error("sessions create requires exactly one saved DataTable asset");
			}
			const snapshot = await Effect.runPromise(
				readSavedTable({
					assetPath,
					...(parsed.reader ? { executable: parsed.reader } : {})
				})
			);
			printJson(
				await Effect.runPromise(
					service.create([snapshot], idOption.value ? { id: idOption.value } : undefined)
				)
			);
			return;
		}
		if (action === "show" || action === "resume" || action === "close") {
			const [sessionId, ...unexpected] = idOption.args;
			if (!sessionId || unexpected.length > 0) {
				throw new Error(`sessions ${action} requires exactly one session id`);
			}
			const operation =
				action === "show"
					? service.open
					: action === "resume"
						? service.resume
						: service.close;
			printJson(await Effect.runPromise(operation(sessionId)));
			return;
		}
		if (action === "discard") {
			const [sessionId, ...unexpected] = idOption.args;
			if (!sessionId || unexpected.length > 0) {
				throw new Error("sessions discard requires exactly one session id");
			}
			await Effect.runPromise(service.discard(sessionId));
			printJson({ id: sessionId, status: "discarded" });
			return;
		}
		if (action === "undo" || action === "redo") {
			const [sessionId, ...unexpected] = idOption.args;
			if (!sessionId || unexpected.length > 0) {
				throw new Error(`sessions ${action} requires exactly one session id`);
			}
			printJson(
				await Effect.runPromise(
					action === "undo" ? service.undo(sessionId) : service.redo(sessionId)
				)
			);
			return;
		}
		if (action === "set-cell") {
			const [sessionId, tablePath, rowName, fieldName, valueJson, ...unexpected] =
				idOption.args;
			if (
				!sessionId ||
				!tablePath ||
				!rowName ||
				!fieldName ||
				!valueJson ||
				unexpected.length > 0
			) {
				throw new Error(
					"sessions set-cell requires session, table, row, field, and value JSON"
				);
			}
			const document = await Effect.runPromise(service.open(sessionId));
			const command = buildSetCellCommand({
				authoredAt: new Date().toISOString(),
				commandId: randomUUID(),
				fieldName,
				groupId: randomUUID(),
				rowName,
				session: document.draft,
				tableObjectPath: tablePath,
				value: decodeAuthoringValue(JSON.parse(valueJson))
			});
			const next = await Effect.runPromise(service.append(sessionId, [command]));
			printJson({
				session: next,
				working: workingTable(next.draft, tablePath)
			});
			return;
		}
		if (action === "apply") {
			const [sessionId, endpoint, ...unexpected] = idOption.args;
			if (!sessionId || !endpoint || unexpected.length > 0) {
				throw new Error("sessions apply requires session id and endpoint");
			}
			const connection = await Effect.runPromise(connectUnrealAuthoring(endpoint));
			const limits = connection.manifest.authoringLimits;
			if (!limits) throw new Error("Editor did not negotiate authoring mutation limits");
			const prepared = await Effect.runPromise(service.prepareApply(sessionId, limits));
			if (prepared.pendingOperation.kind !== "apply")
				throw new Error("Apply was not prepared");
			try {
				const result = await Effect.runPromise(
					connection.apply(prepared.pendingOperation.request)
				);
				printJson({
					result,
					session: await Effect.runPromise(service.completeApply(sessionId, result))
				});
			} catch (cause) {
				await Effect.runPromise(service.markApplyIndeterminate(sessionId, String(cause)));
				throw cause;
			}
			return;
		}
		if (action === "reconcile") {
			const [sessionId, endpoint, ...unexpected] = idOption.args;
			if (!sessionId || !endpoint || unexpected.length > 0) {
				throw new Error("sessions reconcile requires session id and endpoint");
			}
			const document = await Effect.runPromise(service.open(sessionId));
			if (document.pendingOperation.kind !== "apply") {
				throw new Error("Session has no unresolved Apply operation");
			}
			const connection = await Effect.runPromise(connectUnrealAuthoring(endpoint));
			const result = await Effect.runPromise(
				connection.lookupApplyResult(document.pendingOperation.request.operationId)
			);
			printJson({
				result,
				session: await Effect.runPromise(service.completeApply(sessionId, result))
			});
			return;
		}
		if (action === "save") {
			const [sessionId, endpoint, ...unexpected] = idOption.args;
			if (!sessionId || !endpoint || unexpected.length > 0) {
				throw new Error("sessions save requires session id and endpoint");
			}
			const existing = await Effect.runPromise(service.open(sessionId));
			const prepared =
				existing.pendingOperation.kind === "save" &&
				existing.pendingOperation.status === "indeterminate"
					? existing
					: await Effect.runPromise(service.prepareSave(sessionId));
			if (prepared.pendingOperation.kind !== "save") throw new Error("Save was not prepared");
			const connection = await Effect.runPromise(connectUnrealAuthoring(endpoint));
			try {
				const result = await Effect.runPromise(
					connection.save(prepared.pendingOperation.request)
				);
				printJson({
					result,
					session: await Effect.runPromise(service.completeSave(sessionId, result))
				});
			} catch (cause) {
				await Effect.runPromise(service.markSaveIndeterminate(sessionId, String(cause)));
				throw cause;
			}
			return;
		}
		throw new Error(`Unknown authoring sessions command: ${action}`);
	}
	if (area === "session" && action === "create") {
		const [assetPath, sessionPath] = rest;
		if (!assetPath || !sessionPath) {
			throw new Error("session create requires an asset and session file");
		}
		const snapshot = await Effect.runPromise(
			readSavedTable({ assetPath, ...(parsed.reader ? { executable: parsed.reader } : {}) })
		);
		const session = createDraftSession(randomUUID(), [snapshot], fingerprintTable);
		await Effect.runPromise(saveDraftSession(sessionPath, session));
		printJson(session);
		return;
	}
	if (area === "session" && action === "show") {
		const [sessionPath] = rest;
		if (!sessionPath) throw new Error("session show requires a session file");
		printJson(await Effect.runPromise(loadDraftSession(sessionPath)));
		return;
	}
	if (area === "session" && action === "create-live") {
		const [endpoint, tablePath, sessionPath] = rest;
		if (!endpoint || !tablePath || !sessionPath) {
			throw new Error("session create-live requires endpoint, table, and session file");
		}
		const connection = await Effect.runPromise(connectUnrealAuthoring(endpoint));
		const snapshot = await Effect.runPromise(connection.getTableSnapshot(tablePath));
		const session = createDraftSession(randomUUID(), [snapshot], fingerprintTable);
		await Effect.runPromise(saveDraftSession(sessionPath, session));
		printJson(session);
		return;
	}
	if (area === "draft" && action === "set-cell") {
		const [sessionPath, tablePath, rowName, fieldName, valueJson] = rest;
		if (!sessionPath || !tablePath || !rowName || !fieldName || !valueJson) {
			throw new Error("draft set-cell requires session, table, row, field, and value JSON");
		}
		const session = await Effect.runPromise(loadDraftSession(sessionPath));
		const command = buildSetCellCommand({
			authoredAt: new Date().toISOString(),
			commandId: randomUUID(),
			fieldName,
			groupId: randomUUID(),
			rowName,
			session,
			tableObjectPath: tablePath,
			value: decodeAuthoringValue(JSON.parse(valueJson))
		});
		const next = appendCommandGroup(session, [command]);
		await Effect.runPromise(saveDraftSession(sessionPath, next));
		printJson({ session: next, working: workingTable(next, tablePath) });
		return;
	}
	if (area === "draft" && (action === "undo" || action === "redo")) {
		const [sessionPath] = rest;
		if (!sessionPath) throw new Error(`draft ${action} requires a session file`);
		const session = await Effect.runPromise(loadDraftSession(sessionPath));
		const next = action === "undo" ? undo(session) : redo(session);
		await Effect.runPromise(saveDraftSession(sessionPath, next));
		printJson(next);
		return;
	}
	if (area === "apply") {
		const [sessionPath, endpoint] = [action, ...rest];
		if (!sessionPath || !endpoint) throw new Error("apply requires session and endpoint");
		const session = await Effect.runPromise(loadDraftSession(sessionPath));
		const connection = await Effect.runPromise(connectUnrealAuthoring(endpoint));
		const outcome = await Effect.runPromise(
			dispatchApply({
				appliedAt: new Date().toISOString(),
				operationId: randomUUID(),
				port: connection,
				session
			})
		);
		await Effect.runPromise(saveDraftSession(sessionPath, outcome.session));
		printJson(outcome);
		return;
	}
	if (area === "apply-status") {
		const [endpoint, operationId] = [action, ...rest];
		if (!endpoint || !operationId) {
			throw new Error("apply-status requires endpoint and operation ID");
		}
		const connection = await Effect.runPromise(connectUnrealAuthoring(endpoint));
		printJson(await Effect.runPromise(connection.lookupApplyResult(operationId)));
		return;
	}
	if (area === "save") {
		const [sessionPath, endpoint] = [action, ...rest];
		if (!sessionPath || !endpoint) throw new Error("save requires session and endpoint");
		const session = await Effect.runPromise(loadDraftSession(sessionPath));
		const connection = await Effect.runPromise(connectUnrealAuthoring(endpoint));
		const request = buildSaveRequest(session, randomUUID());
		const result = await Effect.runPromise(connection.save(request));
		const next = acceptSaveResult(session, request, result, new Date().toISOString());
		await Effect.runPromise(saveDraftSession(sessionPath, next));
		printJson({ result, session: next });
		return;
	}
	throw new Error(`Unknown authoring command\n\n${help}`);
}

async function textCorpus(args: readonly string[]): Promise<void> {
	const parsed = takeReader(args);
	const [action, projectRoot, ...queryParts] = parsed.args;
	if ((action !== "scan" && action !== "search") || !projectRoot) {
		throw new Error("text requires scan <project-root> or search <project-root> <query>");
	}
	const corpus = await Effect.runPromise(
		scanTextCorpus({
			projectRoot,
			...(parsed.reader ? { readerExecutable: parsed.reader } : {})
		})
	);
	if (action === "scan") {
		printJson(corpus);
		return;
	}
	const query = queryParts.join(" ").trim();
	if (!query) throw new Error("text search requires a non-empty query");
	printJson({
		schemaVersion: corpus.schemaVersion,
		status: corpus.status,
		query,
		coverage: corpus.coverage,
		matches: searchTextCorpus(corpus, query),
		diagnostics: corpus.diagnostics
	});
}

async function main(args: readonly string[]): Promise<void> {
	const [command, ...rest] = args;
	switch (command) {
		case "audit":
			await audit(rest);
			return;
		case "authoring":
			await authoring(rest);
			return;
		case "text":
			await textCorpus(rest);
			return;
		case "version":
		case "--version":
		case "-v":
			process.stdout.write(
				`ue-shed 0.0.0 (protocol ${CURRENT_PROTOCOL_VERSION.major}.${CURRENT_PROTOCOL_VERSION.minor})\n`
			);
			return;
		case undefined:
		case "help":
		case "--help":
		case "-h":
			process.stdout.write(`${help}\n`);
			return;
		default:
			throw new Error(`Unknown command: ${command}\n\n${help}`);
	}
}

main(process.argv.slice(2)).catch((cause: unknown) => {
	process.stderr.write(`ue-shed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exitCode = 2;
});
