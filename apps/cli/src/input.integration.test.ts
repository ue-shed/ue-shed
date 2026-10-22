import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { runInProcessCli, runSuccessfulCli } from "./cli-in-process.test-support.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();

const Conflicts = Schema.Struct({
	kind: Schema.Literal("enhanced_input_conflicts"),
	classified: Schema.Boolean,
	counts: Schema.Record(Schema.String, Schema.Number),
	keys: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			classes: Schema.Array(Schema.String),
			conflicts: Schema.Array(
				Schema.Struct({
					classification: Schema.String,
					setId: Schema.NullOr(Schema.String),
					consumption: Schema.optionalKey(Schema.String)
				})
			)
		})
	),
	sources: Schema.Array(Schema.Struct({ source: Schema.String, status: Schema.String }))
});

const decode = <S extends Schema.Decoder<unknown>>(schema: S, output: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(schema))(output);

describe.skipIf(!executable)("Enhanced Input CLI with the real reader", () => {
	it("prints the atlas with contested keys and no false config diagnostic", async () => {
		const atlas = decode(
			Schema.Struct({
				kind: Schema.Literal("enhanced_input_atlas"),
				status: Schema.Literals(["complete", "partial"]),
				coverage: Schema.Struct({
					inputActions: Schema.Number,
					mappingContexts: Schema.Number
				}),
				atlas: Schema.Struct({ contestedKeys: Schema.Array(Schema.String) }),
				edges: Schema.Array(Schema.Unknown),
				diagnostics: Schema.Array(Schema.Unknown)
			}),
			await runSuccessfulCli(["input", "atlas", fixture.root])
		);
		expect(atlas.status).toBe("complete");
		expect(atlas.diagnostics).toEqual([]);
		expect(atlas.coverage.mappingContexts).toBe(5);
		expect(atlas.atlas.contestedKeys).toContain("W");
		expect(atlas.edges).toEqual([]);
	});

	it("claims only contested keys without a source, and classes with a document", async () => {
		const base = decode(
			Conflicts,
			await runSuccessfulCli(["input", "conflicts", fixture.root])
		);
		expect(base.classified).toBe(false);
		expect(base.keys.every((key) => key.classes.length === 0)).toBe(true);
		expect(base.sources.map((source) => [source.source, source.status])).toEqual([
			["config_asset", "absent"],
			["project_default_contexts", "absent"],
			["host_document", "absent"]
		]);

		const document = join(fixture.root, "coactivation.json");
		await writeFile(
			document,
			JSON.stringify({
				schemaVersion: 1,
				kind: "enhanced_input_co_activation",
				sets: [
					{
						id: "driving",
						contexts: [
							{ context: "/Game/Fixture/Input/IMC_Gameplay", priority: 0 },
							{ context: "/Game/Fixture/Input/IMC_Vehicle", priority: 1 }
						]
					}
				]
			})
		);
		const classified = decode(
			Conflicts,
			await runSuccessfulCli([
				"input",
				"conflicts",
				fixture.root,
				"--co-activation",
				document
			])
		);
		expect(classified.classified).toBe(true);
		const byKey = new Map(classified.keys.map((key) => [key.key, key]));
		// Throttle has the higher priority and saves bConsumeInput=false, so both actions fire.
		expect(
			byKey.get("W")?.conflicts.find((conflict) => conflict.setId === "host_document:driving")
		).toMatchObject({ classification: "both_fire", consumption: "passes_through" });
		// Jump fires on Pressed, Handbrake on Hold: likely intentional.
		expect(byKey.get("SpaceBar")?.classes).toContain("qualified");
		// The menu shares no set with gameplay.
		expect(byKey.get("Escape")?.classes).toEqual(["cross_context"]);
	});

	it("reports usage with Blueprint coverage and exports a control sheet", async () => {
		const usage = decode(
			Schema.Struct({
				noKnownUse: Schema.Array(Schema.String),
				blueprintCoverage: Schema.Struct({ status: Schema.String })
			}),
			await runSuccessfulCli(["input", "unused", fixture.root, "--maximum-blueprints", "50"])
		);
		expect(usage.noKnownUse).toEqual([]);
		expect(usage.blueprintCoverage.status).toBe("scanned");

		const csv = await runSuccessfulCli(["input", "export", fixture.root, "--format", "csv"]);
		const lines = csv.trimEnd().split("\r\n");
		expect(lines[0]).toContain('"record_type","metadata_json","context","action"');
		expect(lines[1]?.startsWith('"metadata"')).toBe(true);
		expect(lines.filter((line) => line.startsWith('"record"'))).toHaveLength(56);

		const output = join(fixture.root, "controls.md");
		await runSuccessfulCli(["input", "export", fixture.root, "--output", output]);
		const markdown = await readFile(output, "utf8");
		expect(markdown).toContain("## IMC_Gameplay");
		expect(markdown).toContain("No co-activation set was supplied");
	});

	it("lists platform views and device coverage, whatever the engine can resolve", async () => {
		const platforms = decode(
			Schema.Struct({
				platforms: Schema.Array(
					Schema.Struct({ platform: Schema.String, status: Schema.String })
				),
				keyProfiles: Schema.Array(Schema.String),
				deviceCoverage: Schema.Array(Schema.Unknown)
			}),
			await runSuccessfulCli(["input", "platforms", fixture.root, "--platform", "Windows"])
		);
		expect(platforms.platforms.map((view) => view.platform)).toEqual(["Windows"]);
		expect(["resolved", "unavailable"]).toContain(platforms.platforms[0]?.status);
		expect(platforms.keyProfiles).toEqual([]);
		expect(platforms.deviceCoverage.length).toBeGreaterThan(0);
	});

	it("rejects an invalid co-activation document as an input error", async () => {
		const document = join(fixture.root, "invalid-coactivation.json");
		await writeFile(document, '{"schemaVersion":1,"kind":"enhanced_input_co_activation"}');
		const result = await runInProcessCli([
			"input",
			"conflicts",
			fixture.root,
			"--co-activation",
			document
		]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("co-activation document");
	});
});
