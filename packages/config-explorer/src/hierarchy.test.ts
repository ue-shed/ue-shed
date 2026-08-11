import { resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { ConfigFileAccessLive } from "./file-access.js";
import { buildConfigHierarchy, resolvePlatformChain } from "./hierarchy.js";

const fixture = resolve("packages/config-explorer/fixtures/config-source");

it("builds UE 5.7 expansion-major layers with parents before the selected platform", () => {
	const layers = buildConfigHierarchy({
		engineRoot: fixture,
		projectRoot: fixture,
		family: "Game",
		platforms: ["Parent", "PlatformA"]
	});
	expect(layers.slice(5, 7).map(({ source }) => source.path)).toEqual([
		"Engine/Config/Parent/BaseParentGame.ini",
		"Engine/Config/PlatformA/BasePlatformAGame.ini"
	]);
	expect(layers.slice(29, 31).map(({ source }) => source.path)).toEqual([
		"Engine/Config/Parent/ParentGame.ini",
		"Engine/Config/PlatformA/PlatformAGame.ini"
	]);
	expect(layers.slice(45, 47).map(({ source }) => source.path)).toEqual([
		"Config/Parent/ParentGame.ini",
		"Config/PlatformA/PlatformAGame.ini"
	]);
	expect(layers[53]?.source.path).toBe("Platforms/Parent/Config/ParentGame.ini");
	expect(layers[54]?.source.path).toBe("Platforms/PlatformA/Config/PlatformAGame.ini");
});

it.effect("derives the parent-most platform chain from data-driven platform metadata", () =>
	Effect.gen(function* () {
		const chain = yield* resolvePlatformChain({
			engineRoot: fixture,
			projectRoot: fixture,
			platform: "PlatformA"
		});
		expect(chain).toEqual(["Parent", "PlatformA"]);
	}).pipe(Effect.provide(ConfigFileAccessLive))
);
