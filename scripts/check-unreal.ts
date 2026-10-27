import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSpan, withSpan, withSpanAsync, type Span } from "./gate-trace.ts";
import { runPnpm } from "./workbench-tools.ts";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001";
const remoteControlStartupTimeoutMs = 180_000;
const lifecycleRoot = mkdtempSync(join(tmpdir(), "ue-shed-check-unreal-"));
const pidFile = join(lifecycleRoot, "fixture-editor.pid");
const environment = {
	...process.env,
	UE_SHED_FIXTURE_PID_FILE: pidFile,
	UE_SHED_FIXTURE_UNATTENDED: "1",
	UE_SHED_REMOTE_CONTROL_ENDPOINT: endpoint
};

async function remoteControlResponds() {
	try {
		const response = await fetch(`${endpoint.replace(/\/+$/, "")}/remote/info`, {
			signal: AbortSignal.timeout(1_500)
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForRemoteControl(editorPid: number) {
	const deadline = Date.now() + remoteControlStartupTimeoutMs;
	const controller = new AbortController();
	let request: Promise<boolean> | undefined;
	try {
		while (Date.now() < deadline) {
			request ??= fetch(`${endpoint.replace(/\/+$/, "")}/remote/info`, {
				signal: controller.signal
			})
				.then((response) => response.ok)
				.catch(() => false);
			const outcome = await Promise.race([
				request.then((ready) => ({ kind: "response" as const, ready })),
				new Promise<{ readonly kind: "pending" }>((resolve) =>
					setTimeout(() => resolve({ kind: "pending" }), 1_000)
				)
			]);
			if (outcome.kind === "response") {
				request = undefined;
				if (outcome.ready) return;
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			try {
				process.kill(editorPid, 0);
			} catch {
				throw new Error(
					`The fixture editor exited before Remote Control started at ${endpoint}.`
				);
			}
		}
	} finally {
		controller.abort();
	}
	throw new Error(`The fixture editor did not start Remote Control at ${endpoint} within 180s.`);
}

function ownedEditorPid() {
	const value = Number(readFileSync(pidFile, "utf8"));
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`The fixture launcher wrote an invalid editor PID: ${String(value)}.`);
	}
	return value;
}

function stopOwnedEditor(editorPid: number | undefined) {
	if (editorPid === undefined) return;
	try {
		process.kill(editorPid);
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
	}
}

let editorPid: number | undefined;
let editorSession: Span | undefined;
try {
	if (await remoteControlResponds()) {
		throw new Error(
			`check:unreal needs exclusive access to the fixture project, but ${endpoint} is already serving Remote Control. Close that editor and retry; the gate launches and cleans up its own editor after commandlet checks.`
		);
	}
	// The lanes import packages' build output, so build it from this checkout's sources first.
	runPnpm(["run", "build:typescript-packages"], environment);
	// Commandlet lanes need the project to themselves; the live-editor lanes share one editor.
	// Authoring runs first there: it restores the tables it edits before review starts.
	runPnpm(["run", "test:uasset-conformance"], environment);
	runPnpm(["run", "test:unreal-niagara"], environment);
	// One span for the owned editor's lifetime, from launch to stop, with the live lanes inside it.
	editorSession = startSpan("owned fixture editor", { "trace.lane": "unreal editor" });
	const session = editorSession;
	await withSpanAsync("live editor lanes", {}, async () => {
		runPnpm(["run", "fixture:launch-authoring"], environment);
		editorPid = ownedEditorPid();
		session.setAttributes({ "process.pid": editorPid });
		const launchedPid = editorPid;
		await withSpanAsync("wait for Remote Control", {}, () => waitForRemoteControl(launchedPid));
		runPnpm(["run", "test:unreal-authoring"], environment);
		runPnpm(["run", "test:unreal-review"], environment);
	});
} finally {
	withSpan("stop owned editor", {}, () => stopOwnedEditor(editorPid));
	editorSession?.end();
	rmSync(lifecycleRoot, { force: true, recursive: true });
}
