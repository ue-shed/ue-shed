import { open, unlink } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

/** Share the machine's exclusive heavy-job lease with Unreal and other benchmark hosts. */
export async function withEngineBenchmarkLock<A>(run: () => Promise<A>): Promise<A> {
	const path = process.env.UE_SHED_UNREAL_LOCK;
	if (!path) throw new Error("Set UE_SHED_UNREAL_LOCK before a heavy run.");
	const started = Date.now();
	let lease;
	for (;;) {
		try {
			lease = await open(path, "wx");
			break;
		} catch (cause) {
			if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST")
				throw cause;
			if (Date.now() - started >= 2 * 60 * 60 * 1000)
				throw new Error("STOP: shared heavy-job lock held for more than two hours.");
			process.stdout.write("Waiting for the shared heavy-job lock.\n");
			await setTimeout(30_000);
		}
	}
	try {
		await lease.writeFile(`Codex Plan 059 ${new Date().toISOString()} pid ${process.pid}\n`);
		return await run();
	} finally {
		await lease.close();
		await unlink(path);
	}
}
