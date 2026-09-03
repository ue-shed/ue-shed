// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { AuthoringTableSnapshot } from "@ue-shed/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AuthoringAnalysisView } from "./authoring-analysis-view.js";

afterEach(cleanup);

const snapshot: AuthoringTableSnapshot = {
	authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Test" },
	completeness: "complete",
	contract: { name: "unreal-authoring", version: { major: 2, minor: 0 } },
	diagnostics: [],
	fingerprint: { algorithm: "sha256", status: "available", value: "fixture", version: 1 },
	producer: { name: "fixture", version: "1" },
	table: {
		kind: "data_table",
		objectPath: "/Game/Fixture/DT_Test.DT_Test",
		packageName: "/Game/Fixture/DT_Test",
		parentTables: [],
		rowStruct: "/Script/Fixture.Row",
		rows: [
			{
				fields: [
					{
						name: "Enabled",
						typeName: "BoolProperty",
						value: { kind: "bool", value: true }
					},
					{ name: "Count", typeName: "IntProperty", value: { kind: "int", value: "2" } }
				],
				id: "row:Alpha",
				name: "Alpha"
			},
			{
				fields: [
					{
						name: "Enabled",
						typeName: "BoolProperty",
						value: { kind: "bool", value: false }
					},
					{ name: "Count", typeName: "IntProperty", value: { kind: "int", value: "9" } }
				],
				id: "row:Beta",
				name: "Beta"
			}
		],
		schema: {
			fields: [
				{
					annotations: { deprecated: false, readOnly: false },
					defaultValue: { status: "known", value: { kind: "bool", value: false } },
					editability: { kind: "editable" },
					id: "field:Enabled",
					name: "Enabled",
					presence: "required",
					type: { kind: "scalar", valueKind: "bool" },
					typeName: "BoolProperty"
				},
				{
					annotations: { deprecated: false, readOnly: false },
					defaultValue: { status: "known", value: { kind: "int", value: "0" } },
					editability: { kind: "editable" },
					id: "field:Count",
					name: "Count",
					presence: "required",
					type: { kind: "scalar", valueKind: "int" },
					typeName: "IntProperty"
				}
			],
			source: "saved_package",
			status: "available"
		}
	}
};

describe("AuthoringAnalysisView", () => {
	it("renders inferred chart titles for the current rows", () => {
		render(() => <AuthoringAnalysisView snapshot={snapshot} rows={snapshot.table.rows} />);

		expect(screen.getByRole("heading", { name: "Patterns in DT_Test" })).toBeDefined();
		expect(screen.getByText("Enabled distribution")).toBeDefined();
		expect(screen.getByText("Count distribution")).toBeDefined();
	});
});
