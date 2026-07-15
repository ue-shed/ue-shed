import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type DataTableContract = {
	readonly kind: "data-table";
	readonly assetPath: string;
	readonly rowStruct: string;
	readonly source: string;
	readonly rows: readonly string[];
	readonly fieldFamilies: readonly string[];
};

type CompositeTableContract = {
	readonly kind: "composite-data-table";
	readonly assetPath: string;
	readonly rowStruct: string;
	readonly parents: readonly string[];
	readonly rows: readonly string[];
	readonly fieldFamilies: readonly string[];
};

type FixtureContract = {
	readonly schemaVersion: number;
	readonly fixtureVersion: string;
	readonly engine: { readonly major: number; readonly minor: number };
	readonly contentRoot: string;
	readonly gameText: {
		readonly contentRoot: string;
		readonly stringTable: {
			readonly assetPath: string;
			readonly namespace: string;
			readonly entries: readonly string[];
		};
		readonly occurrenceAsset: {
			readonly assetPath: string;
			readonly sharedIdentity: {
				readonly namespace: string;
				readonly key: string;
				readonly occurrences: number;
			};
			readonly equalSourceDistinctKeys: readonly string[];
			readonly stringTableReference: string;
		};
	};
	readonly cameraLoad: {
		readonly map: string;
		readonly movingActors: number;
		readonly cameraSources: number;
		readonly capture: {
			readonly width: number;
			readonly height: number;
			readonly pixelFormat: string;
		};
	};
	readonly textureAudit: {
		readonly contentRoot: string;
		readonly source: string;
		readonly rules: string;
		readonly textures: readonly TextureContract[];
	};
	readonly tables: readonly (DataTableContract | CompositeTableContract)[];
};

type TextureContract = {
	readonly objectPath: string;
	readonly width: number;
	readonly height: number;
	readonly sourceFormat: string;
	readonly textureGroup: string;
	readonly compression: string;
	readonly sRGB: boolean;
	readonly mipGeneration: string;
	readonly expectedFindingIds: readonly string[];
};

const fixtureRoot = dirname(fileURLToPath(import.meta.url));

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readContract(): FixtureContract {
	const value = readJson(join(fixtureRoot, "fixture-contract.json"));
	if (
		!isRecord(value) ||
		typeof value.schemaVersion !== "number" ||
		typeof value.fixtureVersion !== "string" ||
		!isRecord(value.engine) ||
		!isRecord(value.cameraLoad) ||
		!isRecord(value.gameText) ||
		!isRecord(value.textureAudit) ||
		typeof value.engine.major !== "number" ||
		typeof value.engine.minor !== "number" ||
		typeof value.contentRoot !== "string" ||
		!Array.isArray(value.tables) ||
		!Array.isArray(value.textureAudit.textures)
	) {
		throw new Error("fixture-contract.json does not match the fixture contract envelope");
	}
	return value as FixtureContract;
}

function sourceRowNames(sourcePath: string): readonly string[] {
	const value = readJson(resolve(fixtureRoot, sourcePath));
	if (!Array.isArray(value)) {
		throw new Error(`${sourcePath} must contain an array of rows`);
	}
	return value.map((row, index) => {
		if (!isRecord(row) || typeof row.Name !== "string" || row.Name.length === 0) {
			throw new Error(`${sourcePath} row ${index} must have a non-empty Name`);
		}
		return row.Name;
	});
}

function generatedAssetPath(assetPath: string): string {
	const packagePath = assetPath.slice("/Game/".length).split(".")[0];
	return join(fixtureRoot, "Content", `${packagePath}.uasset`);
}

describe("generic Unreal fixture contract", () => {
	const contract = readContract();

	it("declares an inspectable version and stock engine baseline", () => {
		expect(contract.schemaVersion).toBe(1);
		expect(contract.fixtureVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(contract.engine).toEqual({ major: 5, minor: 7 });
		expect(contract.contentRoot).toBe("/Game/Fixture/Authoring");
	});

	it("keeps table identities and row identities unique", () => {
		const assetPaths = contract.tables.map((table) => table.assetPath);
		expect(new Set(assetPaths).size).toBe(assetPaths.length);
		for (const table of contract.tables) {
			expect(table.assetPath.startsWith(`${contract.contentRoot}/`)).toBe(true);
			expect(table.rowStruct.startsWith("/Script/UEShedFixture.")).toBe(true);
			expect(new Set(table.rows).size).toBe(table.rows.length);
		}
	});

	it("declares the reproducible multi-camera load map", () => {
		expect(contract.cameraLoad).toEqual({
			map: "/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad",
			movingActors: 32,
			cameraSources: 32,
			capture: { width: 320, height: 180, pixelFormat: "BGRA8" }
		});
		expect(existsSync(join(fixtureRoot, "Content/Fixture/Cameras/L_CameraLoad.umap"))).toBe(
			true
		);
	});

	it("declares identity-focused game text evidence", () => {
		expect(contract.gameText.contentRoot).toBe("/Game/Fixture/Text");
		expect(contract.gameText.stringTable).toEqual({
			assetPath: "/Game/Fixture/Text/ST_Game.ST_Game",
			namespace: "Fixture.StringTable",
			entries: ["PromptContinue", "StatusSaving", "PromptHold"]
		});
		expect(contract.gameText.occurrenceAsset.sharedIdentity.occurrences).toBe(2);
		expect(new Set(contract.gameText.occurrenceAsset.equalSourceDistinctKeys).size).toBe(2);
		for (const assetPath of [
			contract.gameText.stringTable.assetPath,
			contract.gameText.occurrenceAsset.assetPath
		]) {
			expect(assetPath.startsWith(`${contract.gameText.contentRoot}/`)).toBe(true);
			expect(existsSync(generatedAssetPath(assetPath)), assetPath).toBe(true);
		}
	});

	it("keeps every ordinary table reproducible from reviewable source", () => {
		for (const table of contract.tables) {
			if (table.kind !== "data-table") {
				continue;
			}
			expect(sourceRowNames(table.source)).toEqual(table.rows);
		}
	});

	it("commits every generated asset declared by the contract", () => {
		for (const table of contract.tables) {
			expect(existsSync(generatedAssetPath(table.assetPath)), table.assetPath).toBe(true);
		}
	});

	it("declares a portable, reproducible texture audit corpus", () => {
		const audit = contract.textureAudit;
		expect(audit.contentRoot).toBe("/Game/Fixture/Audits/Textures");
		expect(audit.textures).toHaveLength(5);
		const source = readJson(resolve(fixtureRoot, audit.source));
		expect(Array.isArray(source)).toBe(true);
		expect(source).toEqual(
			expect.arrayContaining(
				audit.textures.map(({ expectedFindingIds: _, ...texture }) =>
					expect.objectContaining(texture)
				)
			)
		);
		const objectPaths = audit.textures.map((texture) => texture.objectPath);
		expect(new Set(objectPaths).size).toBe(objectPaths.length);
		for (const texture of audit.textures) {
			expect(texture.objectPath.startsWith(`${audit.contentRoot}/`)).toBe(true);
			expect(texture.width).toBeGreaterThan(0);
			expect(texture.height).toBeGreaterThan(0);
			expect(texture.width).toBeLessThanOrEqual(4096);
			expect(texture.height).toBeLessThanOrEqual(4096);
			expect(texture.sourceFormat).toBe("TSF_BGRA8");
			expect(existsSync(generatedAssetPath(texture.objectPath)), texture.objectPath).toBe(
				true
			);
		}
		const findings = audit.textures.flatMap((texture) => texture.expectedFindingIds);
		expect(findings.sort()).toEqual(["dimensions.power_of_two", "dimensions.ui_max_512"]);
		const rules = readJson(resolve(fixtureRoot, audit.rules));
		expect(rules).toEqual(
			expect.objectContaining({
				schemaVersion: 1,
				rules: expect.arrayContaining([
					expect.objectContaining({ id: "dimensions.power_of_two" }),
					expect.objectContaining({ id: "dimensions.ui_max_512" })
				])
			})
		);
	});

	it("defines composite parent precedence without mixed row structures", () => {
		const tablesByPath = new Map(contract.tables.map((table) => [table.assetPath, table]));
		for (const table of contract.tables) {
			if (table.kind !== "composite-data-table") {
				continue;
			}
			const parents = table.parents.map((parentPath) => tablesByPath.get(parentPath));
			expect(parents.every((parent) => parent?.kind === "data-table")).toBe(true);
			expect(parents.every((parent) => parent?.rowStruct === table.rowStruct)).toBe(true);
			const composedRows = [...new Set(parents.flatMap((parent) => parent?.rows ?? []))];
			expect(composedRows).toEqual(table.rows);
		}
	});

	it("covers the field families required before public API design", () => {
		const families = new Set(contract.tables.flatMap((table) => table.fieldFamilies));
		for (const family of [
			"boolean",
			"integer",
			"float",
			"enum",
			"localized-text",
			"nested-struct",
			"soft-object-reference",
			"data-table-row-handle",
			"array",
			"set",
			"map",
			"opaque-structured-value",
			"composite-table"
		]) {
			expect(families.has(family), family).toBe(true);
		}
	});

	it("contains no machine-specific paths in its portable inputs", () => {
		const portableFiles = [
			"fixture-contract.json",
			"UEShedFixture.uproject",
			contract.textureAudit.source,
			contract.textureAudit.rules,
			...contract.tables.flatMap((table) =>
				table.kind === "data-table" ? [table.source] : []
			)
		];
		for (const relativePath of portableFiles) {
			const contents = readFileSync(resolve(fixtureRoot, relativePath), "utf8");
			expect(contents, relativePath).not.toMatch(/\b[A-Za-z]:[\\/]/);
			expect(contents, relativePath).not.toMatch(/\/(?:Users|home|mnt)\//);
		}
	});
});

describe("fixture project", () => {
	it("enables the stock Remote Control and UE Shed capability plugins", () => {
		const project = readJson(join(fixtureRoot, "UEShedFixture.uproject"));
		if (!isRecord(project) || !Array.isArray(project.Plugins)) {
			throw new Error("UEShedFixture.uproject has no plugin list");
		}
		const pluginNames = project.Plugins.flatMap((plugin) =>
			isRecord(plugin) && typeof plugin.Name === "string" ? [plugin.Name] : []
		);
		expect(pluginNames).toEqual([
			"RemoteControl",
			"UEShedCore",
			"UEShedAuthoring",
			"UEShedCameras",
			"UEShedAssetAudits"
		]);
	});
});
