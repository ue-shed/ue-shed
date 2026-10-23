import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";

/** Serialize native corpus scans and Unreal runs with other jobs on the same machine. */
export async function withCorpusUnrealLock<A>(
	operation: () => A | Promise<A>,
	options: { path?: string; pollMs?: number } = {}
): Promise<A> {
	const path =
		options.path ?? process.env.UE_SHED_UNREAL_LOCK ?? join(tmpdir(), "ue-shed-unreal.lock");
	await mkdir(dirname(path), { recursive: true });
	let lease;
	for (;;) {
		try {
			lease = await open(path, "wx");
			break;
		} catch (cause) {
			if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST")
				throw cause;
			process.stdout.write(`Waiting for Unreal lock: ${path}\n`);
			await setTimeout(options.pollMs ?? 30_000);
		}
	}
	try {
		await lease.writeFile(`UE Shed corpus ${new Date().toISOString()} pid ${process.pid}\n`);
		return await operation();
	} finally {
		await lease.close();
		await rm(path);
	}
}
