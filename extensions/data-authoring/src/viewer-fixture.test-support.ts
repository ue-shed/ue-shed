import type { AuthoringTableSnapshotV2 } from "@ue-shed/protocol";
import type { AuthoringReadResult } from "./wasm-reader.js";

export const viewerSnapshot: AuthoringTableSnapshotV2 = {
	contract: { name: "unreal-authoring", version: { major: 2, minor: 1 } },
	authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Scalars" },
	completeness: "complete",
	diagnostics: [],
	fingerprint: { status: "unavailable", reason: "not_available" },
	producer: { name: "uasset-parser", version: "0.8.0" },
	table: {
		kind: "data_table",
		objectPath: "/Game/Fixture/DT_Scalars.DT_Scalars",
		rowStruct: "/Script/Fixture.ScalarRow",
		parentTables: [],
		packageName: "/Game/Fixture/DT_Scalars",
		schema: { status: "unavailable", reason: "not_available" },
		rows: [
			{
				id: "row:Scalar_Alpha",
				name: "Scalar_Alpha",
				fields: [
					{ name: "Count", typeName: "IntProperty", value: { kind: "int", value: "12" } },
					{
						name: "Enabled",
						typeName: "BoolProperty",
						value: { kind: "bool", value: true }
					}
				]
			},
			{
				id: "row:Scalar_Beta",
				name: "Scalar_Beta",
				fields: [
					{ name: "Count", typeName: "IntProperty", value: { kind: "int", value: "24" } },
					{
						name: "Enabled",
						typeName: "BoolProperty",
						value: { kind: "bool", value: false }
					}
				]
			}
		]
	}
};

export const viewerRead: Omit<
	Extract<AuthoringReadResult, { readonly status: "ready" }>,
	"snapshot"
> & {
	readonly snapshot: AuthoringTableSnapshotV2;
} = {
	status: "ready",
	assetPath: "DT_Scalars.uasset",
	snapshot: viewerSnapshot,
	outcome: "complete",
	diagnostics: []
};
