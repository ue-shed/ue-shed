/** Differential input and byte oracle for the reader's local package columns. */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
	packageTextColumns,
	type PackageTextStored
} from "../packages/game-text/src/package-text-columns.ts";
import { emptyPackageTextRecord } from "../packages/game-text/src/package-text-record.ts";
import { foldRepresentationCopies } from "../packages/game-text/src/representation-copies.ts";
import { mountPackageTextEvent } from "../packages/game-text/src/package-object-path.ts";
import {
	encodeTextAudience,
	TEXT_AUDIENCE_POLICY
} from "../packages/game-text/src/text-audience.ts";
import { writeSnapshotFile } from "../packages/game-text/src/snapshot-file.ts";
import {
	packageTextFixtureProjects,
	measureNativeText
} from "./package-text-reader.test-support.ts";
import type { PackageTextOccurrence } from "../packages/game-text/src/representation-copies.ts";

const directory = resolve(process.argv[2]!);
await mkdir(directory, { recursive: true });
const cases: PackageTextStored[][] = [[]];
const generated: PackageTextStored[] = [];
for (let index = 0; index < 120; index++) {
	const path = `Content/Generated${String(index).padStart(3, "0")}.uasset`;
	const object = `/Game/Generated${index}.Asset`;
	const source = ["", "é\u0000ไทย😀", "\ud800", "\udfff", "\u{f0000}\u{f0001}"][index % 5]!;
	const identity = [
		{ status: "resolved", namespace: "UObjectToolTips", key: "key" },
		{ status: "resolved", namespace: "", key: "" },
		{ status: "string_table", table_id: "/Game/Table.Table", key: "" },
		{ status: "unresolved", reason: "culture_invariant" },
		{ status: "unresolved", reason: "missing_key" }
	] as const;
	const properties = [
		"Text",
		"Map{0}.value",
		"Nested[4].ToolTip",
		'Names("a").Category',
		"VersionData[0].Description",
		"Signature.Description",
		"ScriptBytecode[0]"
	];
	const location =
		index % 3 === 0
			? {
					kind: "asset_property" as const,
					object_path: `${object}.WidgetTree.Title`,
					class_path: "/Script/UMG.TextBlock",
					property_path: properties[index % properties.length]!
				}
			: index % 3 === 1
				? {
						kind: "data_table_cell" as const,
						object_path: object,
						property_path: "Text",
						row: ""
					}
				: { kind: "string_table_entry" as const, object_path: object, entry_key: "" };
	const occurrence: PackageTextOccurrence = {
		source,
		dev_notes: index % 2 ? "" : 'Notes\r\n\t\\"',
		identity: identity[index % identity.length]!,
		location,
		edit_capability: index % 2 ? "read_only" : "source_editable",
		...(index % 3 === 0 ? {} : { gather_editor_only: index % 3 === 1 }),
		copies: (["generated_class", "class_default", "skeleton", "instance"] as const).map(
			(kind, row) => ({
				kind,
				object_path: `${object}_C.Copy${row}`,
				source: row % 2 ? `Other ${source}` : source,
				...(row % 3 === 0
					? {}
					: { class_path: row % 3 === 1 ? "/Script/UMG.TextBlock" : "" }),
				...(row % 3 === 0 ? {} : { gather_editor_only: row % 3 === 1 })
			})
		)
	};
	generated.push({
		path,
		signature: `s${index}`,
		evidence: {
			...emptyPackageTextRecord(path),
			fileBytes: 2 ** 40 + index,
			decodeErrors: index,
			packageName: index % 2 ? "" : `/Game/Generated${index}`,
			assetClass: "",
			status: index % 2 ? "partial" : "complete",
			occurrences: [occurrence],
			gapCounts: {
				unsupported_text_history: 1,
				legacy_container_element_without_type_information: 2,
				feature_unavailable_for_engine_version: 3,
				property_decoder_rejected: 4
			},
			gapSamples: (
				[
					"unsupported_text_history",
					"legacy_container_element_without_type_information",
					"feature_unavailable_for_engine_version",
					"property_decoder_rejected"
				] as const
			).map((reason) => ({ object_path: object, property_path: "", reason })),
			gatherCoverage: {
				runtimeSites: 2 ** 32 + 1,
				missing: 2,
				missingSamples: [{ namespace: "", key: "", source, site: "" }]
			}
		}
	});
}
generated.push({
	path: "Content/None.uasset",
	signature: "",
	evidence: { event: "not_gatherable", path: "Content/None.uasset" }
});
generated.push({
	path: "Content/Error.uasset",
	signature: "",
	evidence: {
		event: "error",
		code: "io",
		message: "Error\nไทย",
		path: "Content/Error.uasset",
		retrySafe: true
	}
});
cases.push(generated);
const blueprintPath = "/Game/Blueprint.Blueprint";
const base: PackageTextOccurrence = {
	source: "Authored",
	dev_notes: "",
	identity: { status: "resolved", namespace: "N", key: "K" },
	location: {
		kind: "asset_property",
		object_path: `${blueprintPath}.WidgetTree.Title`,
		class_path: "/Script/UMG.TextBlock",
		property_path: "Text"
	},
	edit_capability: "source_editable",
	gather_editor_only: true
};
for (const authored of [true, false]) {
	const record = {
		...emptyPackageTextRecord("Content/Blueprint.uasset"),
		blueprintClasses: [
			{
				blueprint: blueprintPath,
				generatedClass: `${blueprintPath}_C`,
				classDefault: "/Game/Blueprint.Default__Blueprint_C",
				skeletonClass: "/Game/Blueprint.SKEL_Blueprint_C",
				skeletonClassDefault: "/Game/Blueprint.Default__SKEL_Blueprint_C"
			}
		],
		occurrences: [
			...(authored ? [base] : []),
			...[
				`${blueprintPath}_C`,
				"/Game/Blueprint.Default__Blueprint_C",
				"/Game/Blueprint.SKEL_Blueprint_C",
				"/Game/Blueprint.Default__SKEL_Blueprint_C"
			].map((object_path, index) => ({
				...base,
				source: index === 2 ? "Skeleton" : "Compiled",
				gather_editor_only: false,
				location: { ...base.location, object_path: `${object_path}.WidgetTree.Title` }
			}))
		]
	};
	cases.push([{ path: record.path, signature: "copies", evidence: record }]);
	cases.push([
		{ path: record.path, signature: "copies", evidence: foldRepresentationCopies(record) }
	]);
}
const wide = {
	...emptyPackageTextRecord("Content/Wide.uasset"),
	occurrences: Array.from({ length: 1800 }, (_, row) => ({
		...base,
		source: `${row}:${"é😀".repeat(50)}`
	}))
};
cases.push([{ path: wide.path, signature: "boundary", evidence: wide }]);
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
if (!executable) throw new Error("Select the freshly built reader for the differential oracle.");
const projects = [
	...packageTextFixtureProjects,
	...(process.env.UE_SHED_PACKAGE_COLUMNS_CORPORA ?? "").split(";").filter(Boolean)
];
let fixtureRecords = 0;
for (const project of projects) {
	if (!existsSync(project)) throw new Error("Requested differential corpus is unavailable.");
	const measured = measureNativeText(
		executable,
		project,
		true,
		project.startsWith("fixtures/") ? undefined : [join(resolve(project), "Content")]
	);
	const records = measured.events.flatMap((event): PackageTextStored[] => {
		if (event.event !== "text_package_record" && event.event !== "error") return [];
		const path = relative(resolve(project), event.path).replaceAll("\\", "/");
		const evidence = mountPackageTextEvent(project, { ...event, path });
		if (evidence.event === "text_summary") throw new Error("Unexpected summary.");
		return [{ path, signature: path, evidence }];
	});
	fixtureRecords += records.length;
	cases.push(records);
}
const output = [];
for (const [index, records] of cases.entries()) {
	const source = packageTextColumns(records);
	const columns = [];
	for (const column of source.columns) {
		const data = await column.load();
		columns.push({
			name: column.name,
			kind: column.kind,
			domain: column.domain ?? "",
			strings: column.stringCount ?? 0,
			bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
		});
	}
	const snapshot = join(directory, `${index}.snapshot`);
	await writeSnapshotFile(snapshot, source, 0, undefined, undefined, { durable: false });
	output.push({ records, columns, snapshot });
}
process.stdout.write(
	JSON.stringify({
		rules: TEXT_AUDIENCE_POLICY.map((rule) => ({
			code: encodeTextAudience({
				audience: rule.audience,
				reason: rule.reason,
				rule: rule.id
			}),
			when: rule.when
		})),
		cases: output,
		fixtureRecords
	})
);
