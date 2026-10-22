import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = process.env.UE_SHED_GAME_TEXT_CORPUS;
describe.skipIf(!root)(
	"local corpus: generate with pnpm corpus:generate --project <scratch.uproject> --seed 1 --lines 256; set UE_SHED_GAME_TEXT_CORPUS to its Content corpus folder",
	() => {
		it("equals the planted right answers except the explicitly pinned, still failing defects", async () => {
			// Run the same public-API adapter as fuzz, using Node's script runtime rather than
			// importing script-only TypeScript into this package's compilation graph.
			const script = fileURLToPath(
				new URL("../../../scripts/compare-game-text-corpus.ts", import.meta.url)
			);
			const { stdout } = await promisify(execFile)(process.execPath, [script, root!], {
				windowsHide: true,
				maxBuffer: 16 * 1024 * 1024
			});
			expect(stdout).toContain('"unexpected": []');
			expect(stdout).toContain('"stale": []');
			expect(stdout).toContain("pinned disagreements");
			expect(stdout).toContain('"byDefect":');
		}, 180_000);
	}
);
