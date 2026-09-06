import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { InvestigationError } from "./investigation.js";

export const readInvestigationPresetJson = Effect.fn("Investigation.readPreset")(function* (
	path: string
) {
	return yield* Effect.tryPromise({
		try: async () => {
			const file = await open(path, "r");
			try {
				const limit = 4 * 1024 * 1024;
				const bytes = Buffer.alloc(limit + 1);
				let count = 0;
				while (count < bytes.length) {
					const read = await file.read(bytes, count, bytes.length - count, null);
					if (read.bytesRead === 0) break;
					count += read.bytesRead;
				}
				if (count > limit) throw new Error("Preset exceeds 4 MiB.");
				const input: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
				return input;
			} finally {
				await file.close();
			}
		},
		catch: (cause) =>
			new InvestigationError({
				message: `Could not read investigation preset: ${String(cause)}`,
				recovery: "Choose a readable version-1 JSON preset smaller than 4 MiB."
			})
	});
});

export const writeInvestigationFile = Effect.fn("Investigation.writeFile")(function* (
	path: string,
	contents: string
) {
	return yield* Effect.tryPromise({
		try: async () => {
			if (Buffer.byteLength(contents) > 512 * 1024 * 1024)
				throw new Error("Export exceeds 512 MiB.");
			const temporary = `${path}.${randomUUID()}.tmp`;
			try {
				const file = await open(temporary, "wx");
				try {
					await file.writeFile(contents, "utf8");
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temporary, path);
			} finally {
				await rm(temporary, { force: true });
			}
		},
		catch: (cause) =>
			new InvestigationError({
				message: `Could not save investigation: ${String(cause)}`,
				recovery:
					"Choose a writable destination, or narrow results if the export exceeds 512 MiB."
			})
	});
});
