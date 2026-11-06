import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { openDatabase } from "./database.ts";
import { stageGeneration } from "./publication.ts";

const path = resolve(process.argv[2]!);
const db = await openDatabase(path, true);
db.exec("PRAGMA cache_size=1; PRAGMA cache_spill=ON");
stageGeneration(db, resolve(process.argv[3]!));
const uncommittedWalBytes = (await stat(`${path}-wal`)).size;
if (uncommittedWalBytes <= 32) throw new Error("The crash test did not spill WAL pages");
process.stdout.write(`${JSON.stringify({ ready: true, uncommittedWalBytes })}\n`);
// The parent kills this process with a fully staged, uncommitted generation.
await new Promise<void>(() => {});
