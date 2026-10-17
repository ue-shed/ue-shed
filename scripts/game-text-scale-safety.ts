import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { positiveNumber } from "./game-text-scale-options.ts";

export const maximumHeapMiB = 16384;
export const maximumRssBytes = 20_000_000_000;
export const maximumStageSeconds = 1200;
export const maximumTenfoldRunSeconds = 900;

/** Absolute run budget; changing stages must never restart the 10× deadline. */
export function benchmarkRunSeconds(scale: number): number | undefined {
	return scale >= 10 ? maximumTenfoldRunSeconds : undefined;
}

export function benchmarkRunExpired(started: number, now: number, seconds: number | undefined) {
	return seconds !== undefined && now - started >= seconds * 1000;
}

export function boundedNumber(value: string, name: string, maximum: number): number {
	const number = positiveNumber(value, name);
	if (number > maximum) throw new Error(`${name} cannot exceed ${maximum}.`);
	return number;
}

/** OS sampling works while the child's JavaScript thread is blocked in parsing or GC. */
export async function childWorkingSet(pid: number, includeDescendants = false): Promise<number> {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid child PID.");
	const run = promisify(execFile);
	if (includeDescendants) {
		if (process.platform === "win32") {
			const { stdout } = await run(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`$ErrorActionPreference = 'Stop'; $all = @(Get-CimInstance Win32_Process); ` +
						`$owned = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$owned.Add(${pid}); ` +
						`do { $added = $false; foreach ($item in $all) { if ($owned.Contains($item.ParentProcessId) -and $owned.Add($item.ProcessId)) { $added = $true } } } while ($added); ` +
						`$total = 0L; foreach ($item in $all) { if ($owned.Contains($item.ProcessId)) { $total += [long]$item.WorkingSetSize } }; $total`
				],
				{ windowsHide: true, timeout: 5000 }
			);
			const rss = Number(stdout.trim());
			if (!Number.isFinite(rss) || rss <= 0)
				throw new Error("Invalid process-tree memory sample.");
			return rss;
		}
		const { stdout } = await run("ps", ["-eo", "pid=,ppid=,rss="], { timeout: 3000 });
		const processes = stdout
			.trim()
			.split("\n")
			.map((line) => line.trim().split(/\s+/u).map(Number));
		const owned = new Set([pid]);
		let added: boolean;
		do {
			added = false;
			for (const [child, parent] of processes)
				if (
					child !== undefined &&
					parent !== undefined &&
					owned.has(parent) &&
					!owned.has(child)
				) {
					owned.add(child);
					added = true;
				}
		} while (added);
		return processes.reduce(
			(total, [child, , rss]) =>
				total + (child !== undefined && owned.has(child) ? (rss ?? 0) * 1024 : 0),
			0
		);
	}
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
