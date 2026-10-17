import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { packageImportUsages } from "./package-import-usages.ts";

const usages = (text: string, name = "@ue-shed/cameras") =>
	packageImportUsages(
		ts.createSourceFile("consumer.ts", text, ts.ScriptTarget.ESNext, true),
		name
	);

describe("package import usage measurement", () => {
	it("preserves imported names through aliases, type imports and re-exports", () => {
		expect(
			usages(`import DefaultCamera, { Camera as Local, type CameraId } from "@ue-shed/cameras";
			export { render as renderCamera } from "@ue-shed/cameras";
			import * as tiles from "@ue-shed/cameras/map-tiles";
			export * as browser from "@ue-shed/cameras/browser";`)
		).toEqual([
			{ subpath: ".", names: ["Camera", "CameraId", "default"] },
			{ subpath: ".", names: ["render"] },
			{ subpath: "./map-tiles", names: "all" },
			{ subpath: "./browser", names: "all" }
		]);
	});

	it("finds dynamic imports nested in Effect callbacks and promise continuations", () => {
		expect(
			usages(`const read = Effect.gen(function* () {
			const { inspectMapCaptureReadiness } = yield* Effect.promise(() => import("@ue-shed/cameras"));
			const camera = yield* Effect.promise(() => import("@ue-shed/cameras/map-tiles"));
			return camera;
		});
		import("@ue-shed/cameras/browser").then((module) => module.render());
		type Snapshot = import("@ue-shed/cameras/review-contracts").Snapshot;`)
		).toEqual([
			{ subpath: ".", names: "all" },
			{ subpath: "./map-tiles", names: "all" },
			{ subpath: "./browser", names: "all" },
			{ subpath: "./review-contracts", names: "all" }
		]);
	});

	it("recognizes the CLI's actual dynamically loaded camera APIs", () => {
		const cli = readFileSync(
			new URL("../apps/cli/src/workflows/map-capture.ts", import.meta.url),
			"utf8"
		);
		expect(cli).toContain("inspectMapCaptureReadiness");
		expect(cli).toContain("inspectMapCaptureSelection");
		expect(usages(cli)).toContainEqual({ subpath: ".", names: "all" });
	});

	it("ignores comments, ordinary strings, computed paths and other package prefixes", () => {
		expect(
			usages(`// import("@ue-shed/cameras")
			const example = 'import("@ue-shed/cameras")';
			import("@ue-shed/cameras-extra");
			import("@ue-shed/cameras" + suffix);
			import(path);`)
		).toEqual([]);
	});
});
