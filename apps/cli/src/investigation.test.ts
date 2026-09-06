import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { runCli } from "./command.js";
import { CliRuntime } from "./cli-runtime.js";

// The repository lane deliberately runs without the native reader. The UAsset IO lane
// supplies it and runs both real fixture replays below.
it.skipIf(!process.env.UE_SHED_UASSET_EXECUTABLE).each(["game_text", "texture_audit"])(
	"replays a %s preset through the CLI and native reader",
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-cli-investigation-"));
		const project = resolve("fixtures/unreal-project");
		let output = "";
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (value) =>
					Effect.sync(() => {
						output += value;
					}),
				printError: (value) => Effect.die(value),
				setExitCode: (code) => Effect.die(`Unexpected exit ${code}`)
			})
		);
		try {
			const rules = JSON.parse(
				await readFile(
					join(
						project,
						"FixtureSource",
						kind === "game_text"
							? "Text/quality-rules.json"
							: "Audits/texture-rules.json"
					),
					"utf8"
				)
			);
			const preset = {
				schemaVersion: 1,
				kind,
				sort: kind === "game_text" ? "domain_order" : "object_path",
				query:
					kind === "game_text"
						? {
								mode: "quality",
								query: "",
								capability: "all",
								lens: "all",
								qualityFilter: "character_budget"
							}
						: { findingsOnly: true, query: "" },
				rules
			};
			const presetPath = join(root, "preset.json");
			const outputPath = join(root, "export.csv");
			await writeFile(presetPath, JSON.stringify(preset));
			const args = ["investigations", "run", project, "--preset", presetPath];
			await Effect.runPromise(runCli(args).pipe(Effect.provide(runtime)));
			const exported = JSON.parse(output);
			expect(exported.preset).toEqual(preset);
			expect(exported.source).toEqual({
				projectRoot: project,
				generation: null,
				authority: "project_files"
			});
			const rows =
				kind === "game_text" ? exported.result.report.findings : exported.result.records;
			expect(rows.length).toBeGreaterThan(0);
			output = "";
			await Effect.runPromise(
				runCli([...args, "--format", "csv", "--output", outputPath]).pipe(
					Effect.provide(runtime)
				)
			);
			expect(output).toBe("");
			const csv = await readFile(outputPath, "utf8");
			expect(csv).toContain('"metadata"');
			expect(csv).toContain('"record"');
			await writeFile(presetPath, JSON.stringify({ ...preset, schemaVersion: 99 }));
			await expect(
				Effect.runPromise(runCli(args).pipe(Effect.provide(runtime)))
			).rejects.toMatchObject({ _tag: "CliCommandError" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	60_000
);
