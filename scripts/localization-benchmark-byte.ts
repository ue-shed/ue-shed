import { open } from "node:fs/promises";

/** Parent-owned restoration survives a worker kill while the one-byte PO edit is in flight. */
export async function captureBenchmarkByte(path: string, token: string) {
	const handle = await open(path, "r");
	try {
		const bytes = Buffer.alloc(4096);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const offset = bytes.subarray(0, bytesRead).indexOf(token);
		if (offset < 0) throw new Error("Benchmark change token absent");
		return { path, offset, byte: bytes[offset]! };
	} finally {
		await handle.close();
	}
}
export async function restoreBenchmarkByte(
	saved: Awaited<ReturnType<typeof captureBenchmarkByte>> | undefined
) {
	if (!saved) return;
	const handle = await open(saved.path, "r+");
	try {
		const current = Buffer.alloc(1);
		if ((await handle.read(current, 0, 1, saved.offset)).bytesRead !== 1)
			throw new Error("Short restoration read");
		if (current[0] !== saved.byte) {
			if (
				(await handle.write(Uint8Array.of(saved.byte), 0, 1, saved.offset)).bytesWritten !==
				1
			)
				throw new Error("Short restoration write");
			await handle.sync();
		}
	} finally {
		await handle.close();
	}
}
