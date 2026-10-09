import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { positiveNumber } from "./game-text-scale-options.ts";

export const maximumHeapMiB = 16384;
export const maximumRssBytes = 20_000_000_000;
export const maximumStageSeconds = 1200;

export function boundedNumber(value: string, name: string, maximum: number): number {
	const number = positiveNumber(value, name);
	if (number > maximum) throw new Error(`${name} cannot exceed ${maximum}.`);
	return number;
}

/** OS sampling works while the child's JavaScript thread is blocked in parsing or GC. */
export async function childWorkingSet(pid: number): Promise<number> {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid child PID.");
	const run = promisify(execFile);
	const { stdout } =
		process.platform === "win32"
			? await run(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`$ErrorActionPreference = 'Stop'; $sample = Get-Process -Id ${pid}; $sample.Refresh(); $sample.WorkingSet64`
					],
					{ windowsHide: true, timeout: 3000 }
				)
			: await run("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 3000 });
	const rss = Number(stdout.trim()) * (process.platform === "win32" ? 1 : 1024);
	if (!Number.isFinite(rss) || rss <= 0) throw new Error("Invalid OS working-set sample.");
	return rss;
}

/** Workers use a separate process group on POSIX; taskkill includes descendants on Windows. */
export async function killBenchmarkTree(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (process.platform === "win32")
			await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				windowsHide: true,
				timeout: 5000
			});
		else process.kill(-child.pid, "SIGKILL");
	} catch (cause) {
		// Exiting between the check and termination is harmless. Any other failure is visible.
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			throw cause;
		}
	}
}
