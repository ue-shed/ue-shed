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
	redo,
	saveDraftSession,
	undo,
	workingTable
} from "@ue-shed/authoring";
import { CURRENT_PROTOCOL_VERSION, decodeAuthoringValue } from "@ue-shed/protocol";
import { readSavedTable } from "@ue-shed/unreal-assets";
import { connectUnrealAuthoring } from "@ue-shed/unreal-connection";
import { Effect } from "effect";

const help = `UE Shed — External tools for Unreal Engine development.

Usage:
  ue-shed audit textures <project-root> --rules <rule-file> [--reader <path>]
  ue-shed authoring inspect <asset> [--reader <path>]
  ue-shed authoring live inspect <endpoint> <table>
  ue-shed authoring session create <asset> <session-file> [--reader <path>]
  ue-shed authoring session create-live <endpoint> <table> <session-file>
  ue-shed authoring session show <session-file>
  ue-shed authoring draft set-cell <session-file> <table> <row> <field> <value-json>
  ue-shed authoring draft undo <session-file>
  ue-shed authoring draft redo <session-file>
  ue-shed authoring apply <session-file> <endpoint>
  ue-shed authoring apply-status <endpoint> <operation-id>
  ue-shed authoring save <session-file> <endpoint>
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
		const next = acceptSaveResult(session, result, new Date().toISOString());
		await Effect.runPromise(saveDraftSession(sessionPath, next));
		printJson({ result, session: next });
		return;
	}
	throw new Error(`Unknown authoring command\n\n${help}`);
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
