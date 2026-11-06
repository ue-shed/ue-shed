import { mkdtempSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Disposable report databases do not need a persistent filesystem's flush latency. */
export function createIndexedReportDirectory(): string {
	if (process.platform === "linux") {
		try {
			const memory = statfsSync("/dev/shm", { bigint: true });
			// Avoid filling small container mounts when several suites prepare fixtures together.
			if (memory.bavail * memory.bsize >= 256n * 1024n * 1024n)
				return mkdtempSync("/dev/shm/ue-shed-report-suite-");
		} catch {
			// Shared memory is optional: absent, read-only or exhausted mounts use OS scratch.
		}
	}
	return mkdtempSync(join(tmpdir(), "ue-shed-report-suite-"));
}
