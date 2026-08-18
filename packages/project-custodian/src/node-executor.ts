import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
	appendFile,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import trash from "trash";
import { scanCustodian } from "./node-scanner.js";
import {
	CustodianProposal,
	CustodianProposalId,
	type CustodianExecutionEntry,
	type CustodianExecutionRefusal,
	type CustodianPrepareRequest,
	type CustodianProposalTarget,
	type CustodianReceipt,
	type CustodianTarget
} from "./schema.js";

interface RunningProcess {
	readonly pid: number;
	readonly name: string;
	readonly command?: string;
	readonly path?: string;
}

export interface CustodianExecutorDependencies {
	readonly now: () => Date;
	readonly newId: () => string;
	readonly runningProcesses: () => Promise<readonly RunningProcess[]>;
	readonly moveToTrash: (path: string) => Promise<void>;
	readonly removePermanently: (path: string) => Promise<void>;
}

function executeFile(file: string, args: readonly string[]): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		execFile(
			file,
			[...args],
			{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				if (error) reject(error);
				else resolveOutput(stdout);
			}
		);
	});
}

function decodeTasklist(output: string): readonly RunningProcess[] {
	return output.split(/\r?\n/u).flatMap((line) => {
		const fields = line.match(/^"((?:[^"]|"")*)","(\d+)"/u);
		if (fields === null) return [];
		const name = fields[1]?.replaceAll('""', '"');
		const pid = Number.parseInt(fields[2] ?? "", 10);
		return name === undefined || !Number.isInteger(pid) ? [] : [{ name, pid }];
	});
}

function decodePs(output: string): readonly RunningProcess[] {
	return output.split(/\r?\n/u).flatMap((line) => {
		const fields = line.match(/^\s*(\d+)\s+(\S+)(?:\s+(.*))?$/u);
		if (fields === null) return [];
		const pid = Number.parseInt(fields[1] ?? "", 10);
		const name = fields[2];
		const command = fields[3];
		return name === undefined || !Number.isInteger(pid)
			? []
			: [{ pid, name, ...(command === undefined ? undefined : { command }) }];
	});
}

async function listRunningProcesses(): Promise<readonly RunningProcess[]> {
	return process.platform === "win32"
		? decodeTasklist(await executeFile("tasklist.exe", ["/FO", "CSV", "/NH"]))
		: decodePs(await executeFile("ps", ["-A", "-o", "pid=", "-o", "comm=", "-o", "args="]));
}

const defaultDependencies: CustodianExecutorDependencies = {
	now: () => new Date(),
	newId: randomUUID,
	runningProcesses: listRunningProcesses,
	moveToTrash: async (path) => trash(path, { glob: false }),
	removePermanently: async (path) => rm(path, { force: true, recursive: true })
};

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Project Custodian cleanup was cancelled.");
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortReason(signal);
}

function isWithin(path: string, root: string): boolean {
	const fromRoot = relative(root, path);
	return (
		fromRoot === "" ||
		(!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
	);
}

function flattenPlanTargets(
	items: readonly {
		readonly kind: "project" | "engine";
		readonly name: string;
		readonly root: string;
		readonly targets: readonly CustodianTarget[];
	}[]
): readonly CustodianProposalTarget[] {
	return items.flatMap((item) =>
		item.targets.map((target) => ({
			kind: item.kind,
			name: item.name,
			root: item.root,
			target
		}))
	);
}

function proposalId(seed: string) {
	return CustodianProposalId.make(
		`proposal-${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`
	);
}

async function writeJsonAtomic<Value>(path: string, value: Value): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, {
			encoding: "utf8",
			flag: "wx"
		});
		await rename(temporaryPath, path);
	} catch (cause) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw cause;
	}
}

async function appendLog(
	proposal: CustodianProposal,
	entry: Schema.JsonObject,
	dependencies: CustodianExecutorDependencies
): Promise<void> {
	await mkdir(dirname(proposal.logPath), { recursive: true });
	await appendFile(
		proposal.logPath,
		`${JSON.stringify({ at: dependencies.now().toISOString(), ...entry })}\n`,
		"utf8"
	);
}

export async function readCustodianProposalDocument(path: string): Promise<Schema.Json> {
	return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(await readFile(resolve(path), "utf8")));
}

export function custodianProposalStorageIsValid(
	proposal: CustodianProposal,
	sourcePath: string
): boolean {
	const directory = dirname(resolve(sourcePath));
	return (
		resolve(proposal.proposalPath) === resolve(sourcePath) &&
		resolve(proposal.receiptPath) === join(directory, `${proposal.id}.receipt.json`) &&
		resolve(proposal.logPath) === join(directory, `${proposal.id}.events.jsonl`)
	);
}

export async function prepareCustodianProposal(
	request: CustodianPrepareRequest,
	signal: AbortSignal,
	dependencies: CustodianExecutorDependencies = defaultDependencies
): Promise<CustodianProposal> {
	throwIfAborted(signal);
	const report = await scanCustodian(
		{ root: request.root, ignorePressure: request.ignorePressure ?? false },
		signal
	);
	const requestedIds = new Set(request.targetIds);
	if (requestedIds.size !== request.targetIds.length) {
		throw new Error("Custodian target selection contains duplicate target IDs.");
	}
	const selected = flattenPlanTargets(report.plan.items).filter(({ target }) =>
		requestedIds.has(target.id)
	);
	if (selected.length !== requestedIds.size) {
		throw new Error(
			"Custodian target selection is not an exact subset of the current cleanup plan."
		);
	}
	const createdAt = dependencies.now().toISOString();
	const id = proposalId(
		JSON.stringify([
			report.root,
			createdAt,
			dependencies.newId(),
			request.mode,
			selected.map(({ target }) => target.id)
		])
	);
	const proposalDirectory = resolve(request.proposalDirectory);
	const proposalPath = join(proposalDirectory, `${id}.proposal.json`);
	const receiptPath = join(proposalDirectory, `${id}.receipt.json`);
	const logPath = join(proposalDirectory, `${id}.events.jsonl`);
	const proposal = CustodianProposal.make({
		schemaVersion: 1,
		id,
		createdAt,
		root: report.root,
		ignorePressure: request.ignorePressure ?? false,
		mode: request.mode,
		proposalPath,
		receiptPath,
		logPath,
		approvalPhrase: `RECLAIM ${id}`,
		bytes: selected.reduce((total, { target }) => total + target.bytes, 0),
		targets: selected
	});
	await writeJsonAtomic(proposalPath, proposal);
	await appendLog(
		proposal,
		{ event: "proposal_created", targetCount: selected.length },
		dependencies
	);
	return proposal;
}

function refusalReceipt(options: {
	readonly proposal: CustodianProposal;
	readonly refusal: CustodianExecutionRefusal;
	readonly startedAt: string;
	readonly finishedAt: string;
}): CustodianReceipt {
	return {
		schemaVersion: 1,
		proposalId: options.proposal.id,
		proposalPath: options.proposal.proposalPath,
		receiptPath: options.proposal.receiptPath,
		logPath: options.proposal.logPath,
		root: options.proposal.root,
		mode: options.proposal.mode,
		startedAt: options.startedAt,
		finishedAt: options.finishedAt,
		status: "refused",
		plannedBytes: options.proposal.bytes,
		processedBytes: 0,
		entries: [],
		refusal: options.refusal
	};
}

async function persistReceipt(
	receipt: CustodianReceipt,
	proposal: CustodianProposal,
	dependencies: CustodianExecutorDependencies
): Promise<CustodianReceipt> {
	await writeJsonAtomic(proposal.receiptPath, receipt);
	await appendLog(
		proposal,
		{
			event: "execution_finished",
			processedBytes: receipt.processedBytes,
			status: receipt.status
		},
		dependencies
	);
	return receipt;
}

async function refuse(options: {
	readonly proposal: CustodianProposal;
	readonly refusal: CustodianExecutionRefusal;
	readonly startedAt: string;
	readonly dependencies: CustodianExecutorDependencies;
}): Promise<CustodianReceipt> {
	await appendLog(
		options.proposal,
		{ event: "execution_refused", refusal: options.refusal },
		options.dependencies
	);
	return persistReceipt(
		refusalReceipt({
			proposal: options.proposal,
			refusal: options.refusal,
			startedAt: options.startedAt,
			finishedAt: options.dependencies.now().toISOString()
		}),
		options.proposal,
		options.dependencies
	);
}

function runningUnrealEditors(processes: readonly RunningProcess[]): readonly RunningProcess[] {
	const editor = /(?:^|[\\/\s])(?:UnrealEditor|UE4Editor)(?:-Cmd)?(?:\.exe)?(?:$|\s)/iu;
	return processes.filter((process) =>
		[process.name, process.command, process.path].some(
			(value) => value !== undefined && editor.test(value)
		)
	);
}

function targetMatches(
	planned: CustodianProposalTarget,
	current: CustodianProposalTarget | undefined
): current is CustodianProposalTarget {
	return (
		current !== undefined &&
		current.kind === planned.kind &&
		current.root === planned.root &&
		current.target.id === planned.target.id &&
		current.target.key === planned.target.key &&
		current.target.path === planned.target.path &&
		current.target.relativePath === planned.target.relativePath &&
		current.target.bytes === planned.target.bytes
	);
}

async function validateTarget(options: {
	readonly scanRoot: string;
	readonly ownerRoot: string;
	readonly target: CustodianTarget;
}): Promise<void> {
	const metadata = await lstat(options.target.path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Cleanup target is no longer a plain directory.");
	}
	const [scanRoot, ownerRoot, target] = await Promise.all([
		realpath(options.scanRoot),
		realpath(options.ownerRoot),
		realpath(options.target.path)
	]);
	if (!isWithin(target, scanRoot) || !isWithin(target, ownerRoot) || target === ownerRoot) {
		throw new Error("Cleanup target no longer resolves inside its approved roots.");
	}
	const currentRelativePath = relative(ownerRoot, target).split(sep).join("/");
	if (currentRelativePath !== options.target.relativePath) {
		throw new Error("Cleanup target identity changed after revalidation.");
	}
}

function cancelledEntries(
	targets: readonly CustodianProposalTarget[]
): readonly CustodianExecutionEntry[] {
	return targets.map(({ target }) => ({
		targetId: target.id,
		path: target.path,
		relativePath: target.relativePath,
		bytes: target.bytes,
		status: "cancelled" as const,
		message: "Cleanup was cancelled before this target started."
	}));
}

export async function executeCustodianProposal(
	proposal: CustodianProposal,
	approvalPhrase: string,
	signal: AbortSignal,
	dependencies: CustodianExecutorDependencies = defaultDependencies
): Promise<CustodianReceipt> {
	const startedAt = dependencies.now().toISOString();
	await appendLog(proposal, { event: "execution_requested" }, dependencies);
	if (approvalPhrase !== proposal.approvalPhrase) {
		return refuse({
			proposal,
			startedAt,
			dependencies,
			refusal: {
				code: "approval_mismatch",
				message: "The cleanup approval phrase does not match this proposal.",
				recovery: `Review the proposal and approve it with ${proposal.approvalPhrase}.`
			}
		});
	}

	const editors = runningUnrealEditors(await dependencies.runningProcesses());
	if (editors.length > 0) {
		return refuse({
			proposal,
			startedAt,
			dependencies,
			refusal: {
				code: "editor_running",
				message: `Cleanup refused while ${editors.length} Unreal Editor process(es) are running.`,
				recovery: "Close every Unreal Editor process, prepare a fresh proposal, and retry."
			}
		});
	}

	if (signal.aborted) {
		const entries = cancelledEntries(proposal.targets);
		return persistReceipt(
			{
				schemaVersion: 1,
				proposalId: proposal.id,
				proposalPath: proposal.proposalPath,
				receiptPath: proposal.receiptPath,
				logPath: proposal.logPath,
				root: proposal.root,
				mode: proposal.mode,
				startedAt,
				finishedAt: dependencies.now().toISOString(),
				status: "cancelled",
				plannedBytes: proposal.bytes,
				processedBytes: 0,
				entries
			},
			proposal,
			dependencies
		);
	}

	const report = await scanCustodian(
		{ root: proposal.root, ignorePressure: proposal.ignorePressure },
		signal
	);
	const currentById = new Map(
		flattenPlanTargets(report.plan.items).map((target) => [target.target.id, target] as const)
	);
	const currentTargets: CustodianProposalTarget[] = [];
	for (const planned of proposal.targets) {
		const current = currentById.get(planned.target.id);
		if (!targetMatches(planned, current)) {
			return refuse({
				proposal,
				startedAt,
				dependencies,
				refusal: {
					code: "proposal_stale",
					message: `Cleanup target ${planned.target.relativePath} changed after review.`,
					recovery:
						"Rescan, prepare a new proposal, and review the current target evidence."
				}
			});
		}
		currentTargets.push(current);
	}

	const entries: CustodianExecutionEntry[] = [];
	for (let index = 0; index < currentTargets.length; index++) {
		const current = currentTargets[index];
		if (current === undefined) continue;
		if (signal.aborted) {
			entries.push(...cancelledEntries(currentTargets.slice(index)));
			break;
		}
		try {
			await validateTarget({
				scanRoot: proposal.root,
				ownerRoot: current.root,
				target: current.target
			});
			await appendLog(
				proposal,
				{ event: "target_started", targetId: current.target.id },
				dependencies
			);
			if (proposal.mode === "trash") {
				await dependencies.moveToTrash(current.target.path);
			} else {
				await dependencies.removePermanently(current.target.path);
			}
			const entry: CustodianExecutionEntry = {
				targetId: current.target.id,
				path: current.target.path,
				relativePath: current.target.relativePath,
				bytes: current.target.bytes,
				status: proposal.mode === "trash" ? "trashed" : "deleted"
			};
			entries.push(entry);
			await appendLog(proposal, { event: "target_completed", ...entry }, dependencies);
		} catch (cause) {
			const entry: CustodianExecutionEntry = {
				targetId: current.target.id,
				path: current.target.path,
				relativePath: current.target.relativePath,
				bytes: current.target.bytes,
				status: "failed",
				message: cause instanceof Error ? cause.message : String(cause)
			};
			entries.push(entry);
			await appendLog(proposal, { event: "target_failed", ...entry }, dependencies);
		}
	}

	const processedBytes = entries
		.filter(({ status }) => status === "trashed" || status === "deleted")
		.reduce((total, { bytes }) => total + bytes, 0);
	const status = entries.some(({ status }) => status === "cancelled")
		? "cancelled"
		: entries.some(({ status }) => status === "failed")
			? "partial"
			: "completed";
	return persistReceipt(
		{
			schemaVersion: 1,
			proposalId: proposal.id,
			proposalPath: proposal.proposalPath,
			receiptPath: proposal.receiptPath,
			logPath: proposal.logPath,
			root: proposal.root,
			mode: proposal.mode,
			startedAt,
			finishedAt: dependencies.now().toISOString(),
			status,
			plannedBytes: proposal.bytes,
			processedBytes,
			entries
		},
		proposal,
		dependencies
	);
}
