import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureUassetExecutable } from "./native-tools.ts";
import { JsonSchema, Schema, SchemaRepresentation } from "effect";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageNodeEntry = join(
	repositoryRoot,
	"packages",
	"uasset-inspection-wasm",
	"dist",
	"node.js"
);
const nativeExecutable = ensureUassetExecutable();
const fixtureRoot = process.env.UE_SHED_UASSET_FIXTURE_ROOT
	? resolve(process.env.UE_SHED_UASSET_FIXTURE_ROOT)
	: join(repositoryRoot, "fixtures", "unreal-project");
// SAFETY: checked-in JSON Schema is a development contract, validated against real output below.
const sequenceSchema: JsonSchema.JsonSchema = JSON.parse(
	readFileSync(
		join(
			repositoryRoot,
			"packages/uasset-inspection-wasm/contracts/level-sequence.v6.schema.json"
		),
		"utf8"
	)
);
const decodeSequence = Schema.decodeUnknownSync(
	// JSON Schema contains pure value checks, with no Effect service requirements.
	SchemaRepresentation.toSchema<Schema.Codec<unknown>>(
		SchemaRepresentation.fromJsonSchemaDocument(
			JsonSchema.fromSchemaDraft2020_12(sequenceSchema)
		)
	),
	{ onExcessProperty: "error" }
);
const fixtures = [
	"Content/Fixture/ParserNative/CF_Native.uasset",
	"Content/Fixture/ParserNative/CV_Native.uasset",
	"Content/Fixture/ParserNative/CC_Native.uasset",
	"Content/Fixture/ParserNative/SK_Native.uasset",
	"Content/Fixture/ParserNative/DA_Native.uasset",
	"Content/Fixture/ParserNative/LS_Numeric.uasset",
	"Content/Fixture/ParserNative/LS_SavedDetails.uasset",
	"Content/Fixture/ParserNative/A_Native.uasset",

	"Content/Fixture/Authoring/DT_Scalars.uasset",
	"Content/Fixture/Authoring/DT_LargeScalars.uasset",
	"Content/Fixture/Input/IMC_Fixture.uasset",
	"Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset",
	"Content/Fixture/Animation/A_FixtureMotion.uasset",
	"Content/Fixture/Sequences/LS_TextTimeline.uasset",
	"Content/Fixture/Sequences/LS_NestedTimeline.uasset",
	"Content/Fixture/Text/ST_Game.uasset",
	"Content/Fixture/Cameras/L_CameraLoad.umap"
].map((path) => join(fixtureRoot, path));

// SAFETY: the checked-in envelope embeds the authoritative authoring snapshot definitions.
const authoringSchema: JsonSchema.JsonSchema = JSON.parse(
	readFileSync(
		join(
			repositoryRoot,
			"packages/uasset-inspection-wasm/contracts/authoring-table.v1.schema.json"
		),
		"utf8"
	)
);
const decodeAuthoringTable = Schema.decodeUnknownSync(
	SchemaRepresentation.toSchema<Schema.Codec<unknown>>(
		SchemaRepresentation.fromJsonSchemaDocument(
			JsonSchema.fromSchemaDraft2020_12(authoringSchema)
		)
	),
	{ onExcessProperty: "error" }
);
const projectionFixtures: ReadonlyArray<{
	readonly path: string;
	readonly kind: "text" | "texture";
}> = [
	{ path: join(fixtureRoot, "Content/Fixture/Text/DA_TextOccurrences.uasset"), kind: "text" },
	{
		path: join(
			fixtureRoot,
			"Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset"
		),
		kind: "texture"
	}
];

// SAFETY: packageNodeEntry is the generated module and its declared type is the source contract.
const wasm = (await import(
	pathToFileURL(packageNodeEntry).href
)) as typeof import("../packages/uasset-inspection-wasm/src/node.js");
const runtime = wasm.createNodeRuntime();

const authoringDirectory = join(fixtureRoot, "Content/Fixture/Authoring");
const authoringFixtures = readdirSync(authoringDirectory, { encoding: "utf8", recursive: true })
	.filter((path) => /\.uasset$/i.test(path))
	.map((path) => join(authoringDirectory, path));
assert.ok(authoringFixtures.length > 0, "authoring parity must exercise DataTable fixtures");
for (const fixture of authoringFixtures) {
	const displayPath = relative(repositoryRoot, fixture).replaceAll("\\", "/");
	const request = {
		contract: { name: "uasset-io", version: { major: 1, minor: 7 } },
		requestId: "wasm-authoring-parity",
		operation: { kind: "authoring", assetPath: fixture },
		limits: { maximumOutputBytes: 64 * 1024 * 1024, timeoutMs: 30_000 }
	};
	const native = spawnSync(nativeExecutable, ["protocol"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		input: JSON.stringify(request),
		maxBuffer: 64 * 1024 * 1024
	});
	assert.ifError(native.error);
	assert.equal(native.status, 0, native.stderr);
	const events = native.stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => JSON.parse(line));
	const event = events.find(
		(item) => item.kind === "result" && item.result?.kind === "authoring"
	);
	assert.ok(event, `${displayPath} must emit a native authoring snapshot`);
	const result = runtime.extractAuthoringTable(displayPath, readFileSync(fixture));
	decodeAuthoringTable(result);
	assert.ok(result.status === "ok" || result.status === "partial");
	assert.deepEqual(result.snapshot, event.result.snapshot, `${displayPath} authoring parity`);
	assert.equal(result.status === "partial", event.result.snapshot.completeness === "partial");
	const completed = events.find((item) => item.kind === "completed");
	assert.ok(completed, `${displayPath} native authoring must complete`);
	assert.equal(result.status === "ok" ? "complete" : "partial", completed.outcome);
}

assert.equal(
	`uasset ${runtime.version()}`,
	execFileSync(nativeExecutable, ["--version"], { encoding: "utf8" }).trim()
);
assert.equal(runtime.limits.maxInputBytes, 64 * 1024 * 1024);
assert.equal(runtime.limits.maxOutputBytes, 64 * 1024 * 1024);

for (const fixture of fixtures) {
	const displayPath = relative(repositoryRoot, fixture).replaceAll("\\", "/");
	const bytes = readFileSync(fixture);
	const nativeOutput = execFileSync(nativeExecutable, ["inspect", "-", "--format", "json"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		input: bytes,
		maxBuffer: 64 * 1024 * 1024
	});
	const nativeInspection = JSON.parse(nativeOutput);
	nativeInspection.path = displayPath;

	assert.deepEqual(
		runtime.inspect(displayPath, bytes),
		nativeInspection,
		`${displayPath} must match native inspection`
	);

	const repeated = runtime.inspect(displayPath, bytes);
	assert.deepEqual(
		repeated,
		nativeInspection,
		`${displayPath} must be stable across repeated calls`
	);
}

for (const { path: fixture, kind } of projectionFixtures) {
	const displayPath = relative(repositoryRoot, fixture).replaceAll("\\", "/");
	const bytes = readFileSync(fixture);
	const nativeProjection = readNativeProjection(fixture, kind, displayPath);
	const wasmProjection =
		kind === "text"
			? runtime.extractText(displayPath, bytes)
			: runtime.extractTextures(displayPath, bytes);
	assert.deepEqual(
		wasmProjection,
		nativeProjection,
		`${displayPath} ${kind} projection must match native`
	);
}

const levelSequenceFixture = join(fixtureRoot, "Content/Fixture/Sequences/LS_TextTimeline.uasset");
const levelSequencePath = relative(repositoryRoot, levelSequenceFixture).replaceAll("\\", "/");
const levelSequence = runtime.extractLevelSequences(
	levelSequencePath,
	readFileSync(levelSequenceFixture)
);
assert.equal(levelSequence.status, "complete");
assert.equal(levelSequence.sequences.length, 1);
assert.equal(levelSequence.sequences[0].schema_version, 6);
decodeSequence(levelSequence.sequences[0]);
assert.equal(levelSequence.sequences[0].reference_coverage_gaps.length, 0);
assert.ok(
	levelSequence.sequences[0].references.some(
		(reference) =>
			reference.kind === "soft_object" &&
			reference.property_path === "Possessables[0].PossessedObjectClass" &&
			reference.target_path === "/Script/UEShedFixture.UEShedFixtureTextAsset" &&
			reference.scope === "external"
	)
);
assert.deepEqual(
	levelSequence.sequences[0].bindings[0].tracks[0].sections[0].text_keys.map((key) => [
		key.frame,
		key.source
	]),
	[
		[0, "We made it."],
		[48000, "Something is wrong."],
		[96000, "Run!"]
	]
);

const numericSequenceFixture = join(fixtureRoot, "Content/Fixture/ParserNative/LS_Numeric.uasset");
const numericSequence = runtime.extractLevelSequences(
	"LS_Numeric.uasset",
	readFileSync(numericSequenceFixture)
);
assert.equal(numericSequence.status, "complete");
const numericRecord = numericSequence.sequences[0];
decodeSequence(numericRecord);
assert.throws(() => decodeSequence({ ...numericRecord, schema_version: 3 }));
assert.deepEqual(numericRecord.coverage_gaps, []);
const nativeEvidence: unknown = JSON.parse(
	readFileSync(join(fixtureRoot, "FixtureExpected/parser-targets/native-coverage.json"), "utf8")
);
const normalizedChannels = numericRecord.root_tracks.flatMap((track) =>
	track.sections.flatMap((section) =>
		section.numeric_channels
			.filter((channel) => channel.property_path !== "ManualWeight")
			.map((channel) => ({
				default: channel.default_value,
				pre: channel.pre_extrapolation,
				post: channel.post_extrapolation,
				numerator: channel.tick_resolution.numerator,
				denominator: channel.tick_resolution.denominator,
				keys: channel.keys.map((key) => ({
					frame: key.frame,
					value: key.value,
					interp: key.interpolation,
					tangent_mode: key.tangent_mode,
					weight_mode: key.tangent_weight_mode,
					arrive: key.arrive_tangent,
					leave: key.leave_tangent,
					arrive_weight: key.arrive_tangent_weight,
					leave_weight: key.leave_tangent_weight
				}))
			}))
	)
);
const oracle = Schema.decodeUnknownSync(
	Schema.Struct({
		sequence_channels: Schema.Array(Schema.Json),
		transform_channels: Schema.Array(Schema.Json),
		transform_mask: Schema.Number
	})
)(nativeEvidence);
assert.deepEqual(normalizedChannels, [...oracle.sequence_channels, ...oracle.transform_channels]);
const transformChannels = numericRecord.root_tracks
	.find((track) => track.content === "transform")
	?.sections[0].numeric_channels.filter((channel) => channel.property_path !== "ManualWeight");
assert.equal(transformChannels?.length, 9);
transformChannels?.forEach((channel, index) =>
	assert.equal(channel.enabled, (oracle.transform_mask & (1 << index)) !== 0)
);

const nestedSequenceFixture = join(
	fixtureRoot,
	"Content/Fixture/Sequences/LS_NestedTimeline.uasset"
);
const nestedSequencePath = relative(repositoryRoot, nestedSequenceFixture).replaceAll("\\", "/");
const nestedSequence = runtime.extractLevelSequences(
	nestedSequencePath,
	readFileSync(nestedSequenceFixture)
);
assert.equal(nestedSequence.status, "complete");
assert.equal(nestedSequence.sequences[0].schema_version, 6);
decodeSequence(nestedSequence.sequences[0]);
assert.equal(
	nestedSequence.sequences[0].references.filter(
		(reference) =>
			reference.kind === "object" &&
			reference.property_path === "SubSequence" &&
			reference.target_path === "/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline" &&
			reference.scope === "external"
	).length,
	2
);
assert.deepEqual(
	nestedSequence.sequences[0].root_tracks.map((track) => [
		track.content,
		track.sections[0].sequence_path,
		track.sections[0].shot_display_name
	]),
	[
		["sub_sequence", "/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline", null],
		[
			"cinematic_shot",
			"/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline",
			"Text timeline reprise"
		]
	]
);

const blueprintFixture = join(fixtureRoot, "Content/Fixture/Blueprints/BP_GraphFixture.uasset");
const blueprintPath = relative(repositoryRoot, blueprintFixture).replaceAll("\\", "/");
const blueprint = runtime.extractBlueprints(blueprintPath, readFileSync(blueprintFixture));
assert.equal(blueprint.status, "ok");
assert.equal(blueprint.blueprints.length, 1);
assert.equal(blueprint.blueprints[0].schema_version, 2);
assert.ok(blueprint.blueprints[0].graphs.length > 0);
assert.ok(blueprint.blueprints[0].graphs.flatMap((graph) => graph.nodes).length > 0);
assert.ok(
	blueprint.blueprints[0].graphs.flatMap((graph) => graph.nodes.flatMap((node) => node.pins))
		.length > 0
);
assert.ok(blueprint.blueprints[0].graphs.flatMap((graph) => graph.links).length > 0);
assert.deepEqual(blueprint.blueprints[0].coverage_gaps, []);
assert.deepEqual(blueprint.diagnostics, []);

const unsupported = runtime.inspect("BigEndian.uasset", Uint8Array.from([0x9e, 0x2a, 0x83, 0xc1]));
assert.equal(unsupported.schema_version, 8);
assert.equal(unsupported.status, "error");
assert.equal(unsupported.path, "BigEndian.uasset");
assert.equal(unsupported.kind, "unsupported_capability");

const malformed = runtime.inspect("Broken.uasset", Uint8Array.from([0, 1, 2, 3]));
assert.equal(malformed.schema_version, 8);
assert.equal(malformed.status, "error");
assert.equal(malformed.path, "Broken.uasset");
assert.equal(malformed.kind, "unsupported_format");

const malformedText = runtime.extractText("Broken.uasset", Uint8Array.from([0, 1, 2, 3]));
assert.equal(malformedText.schema_version, 1);
assert.equal(malformedText.status, "error");
assert.equal(malformedText.path, "Broken.uasset");
assert.equal(malformedText.kind, "unsupported_format");

const malformedBlueprint = runtime.extractBlueprints(
	"Broken.uasset",
	Uint8Array.from([0, 1, 2, 3])
);
assert.equal(malformedBlueprint.schema_version, 1);
assert.equal(malformedBlueprint.status, "error");
assert.equal(malformedBlueprint.path, "Broken.uasset");
assert.equal(malformedBlueprint.kind, "unsupported_format");

// SAFETY: checked-in language-neutral schema is validated against both producers.
const animationSchema: JsonSchema.JsonSchema = JSON.parse(
	readFileSync(
		join(repositoryRoot, "packages/uasset-inspection-wasm/contracts/animation.v1.schema.json"),
		"utf8"
	)
);
const decodeAnimation = Schema.decodeUnknownSync(
	SchemaRepresentation.toSchema<Schema.Codec<unknown>>(
		SchemaRepresentation.fromJsonSchemaDocument(
			JsonSchema.fromSchemaDraft2020_12(animationSchema)
		)
	),
	{ onExcessProperty: "error" }
);
for (const [path, status] of [
	["Content/Fixture/ParserNative/A_Native.uasset", "complete"],
	["Content/Fixture/Animation/A_FixtureMotion.uasset", "partial"]
] as const) {
	const bytes = readFileSync(join(fixtureRoot, path));
	const actual = runtime.extractAnimations(path, bytes);
	assert.equal(actual.status, status);
	assert.equal(actual.animations.length, 1);
	decodeAnimation(actual.animations[0]);
	assert.throws(() => decodeAnimation({ ...actual.animations[0], schema_version: 2 }));
	assert.throws(() => decodeAnimation({ ...actual.animations[0], frame_count: -1 }));
	const native = spawnSync(nativeExecutable, ["animation", "-", "--format", "json"], {
		input: bytes,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024
	});
	assert.equal(native.status, status === "complete" ? 0 : 6, native.stderr);
	const expected = JSON.parse(native.stdout);
	expected.path = path;
	assert.deepEqual(actual, expected, `${path} animation native/WASM parity`);
}
const malformedAnimation = runtime.extractAnimations(
	"Broken.uasset",
	Uint8Array.from([0, 1, 2, 3])
);
assert.equal(malformedAnimation.status, "error");
assert.equal(malformedAnimation.kind, "unsupported_format");

const narrowRuntime = wasm.createNodeRuntime({ maxInputBytes: 4 });
assert.throws(
	() => narrowRuntime.extractAnimations("TooLarge.uasset", new Uint8Array(5)),
	(cause: unknown) =>
		cause instanceof Object &&
		"code" in cause &&
		cause.code === "UE_SHED_UASSET_WASM_INPUT_LIMIT"
);
assert.throws(
	() => narrowRuntime.inspect("TooLarge.uasset", new Uint8Array(5)),
	(cause: unknown) =>
		cause instanceof Object &&
		"code" in cause &&
		cause.code === "UE_SHED_UASSET_WASM_INPUT_LIMIT"
);

process.stdout.write(
	`WASM inspection parity passed for ${fixtures.length} fixtures, authoring parity passed for ${authoringFixtures.length} fixtures, compact projections passed for ${projectionFixtures.length} fixtures plus Blueprint and Level Sequence coverage, and typed failures/limits passed.\n`
);

function readNativeProjection(
	fixture: string,
	projection: "text" | "texture",
	displayPath: string
) {
	const lines = execFileSync(
		nativeExecutable,
		["scan", fixtureRoot, "--path", fixture, "--projection", projection, "--concurrency", "1"],
		{ cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
	)
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
	const eventPrefix = projection === "text" ? "text" : "texture";
	const packageEvent = lines.find((line) => line.event === `${eventPrefix}_package`);
	assert.ok(packageEvent, `${displayPath} must produce a ${eventPrefix} package event`);
	if (projection === "text") {
		return {
			schema_version: 1,
			status: packageEvent.status,
			path: displayPath,
			occurrences: lines
				.filter((line) => line.event === "text_occurrence")
				.map((line) => line.occurrence),
			coverage_gaps: lines
				.filter((line) => line.event === "text_coverage_gap")
				.map((line) => line.coverage_gap),
			diagnostics: packageEvent.diagnostics
		};
	}
	return {
		schema_version: 1,
		status: packageEvent.status,
		path: displayPath,
		records: lines.filter((line) => line.event === "texture_record").map((line) => line.record),
		diagnostics: packageEvent.diagnostics
	};
}
