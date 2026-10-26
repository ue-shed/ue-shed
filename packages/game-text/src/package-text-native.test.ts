import { Effect } from "effect";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { describe, expect, it } from "vitest";
import { nativePackageTextColumns, PackageTextReaderConfiguration } from "./package-text-native.js";
import { packageTextColumns, type PackageTextStored } from "./package-text-columns.js";
import { emptyPackageTextRecord } from "./package-text-record.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
describe.skipIf(!executable)("native package column preparation", () => {
	const compare = (records: readonly PackageTextStored[]) =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const actual = yield* nativePackageTextColumns(records);
					const expected = packageTextColumns(records);
					expect(
						actual.columns.map(({ name, kind, domain, stringCount }) => ({
							name,
							kind,
							domain: domain ?? "",
							strings: stringCount ?? 0
						}))
					).toEqual(
						expected.columns.map(({ name, kind, domain, stringCount }) => ({
							name,
							kind,
							domain: domain ?? "",
							strings: stringCount ?? 0
						}))
					);
					for (const [row, column] of actual.columns.entries()) {
						const bytes = yield* Effect.promise(() => column.load());
						const oracle = yield* Effect.promise(() => expected.columns[row]!.load());
						expect(
							Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(
								Buffer.from(oracle.buffer, oracle.byteOffset, oracle.byteLength)
							),
							column.name
						).toBe(true);
					}
				})
			).pipe(
				Effect.provideService(PackageTextReaderConfiguration, {
					executable: executable!,
					timeoutMs: 30_000,
					catalogTimeoutMs: 60_000
				}),
				Effect.provide(
					assetReaderLayer({ executable: "intentionally-unavailable-ambient-reader" })
				)
			)
		);
	it("uses the paired executable for an empty inventory despite a different ambient reader", () =>
		compare([]));
	// U+F0000–U+F0800 escape lone surrogates inside the reader; literal ones in inventory
	// paths and signatures must survive both replayed and excluded packages.
	const reserved = ["Content/\u{f0000}.uasset", "Content/\u{f0001}x.uasset"];
	it("keeps reserved scalars in the paths and signatures of selected and excluded packages", () =>
		compare([
			...reserved.map((path) => ({
				path,
				signature: `\u{f0001}${path}`,
				evidence: emptyPackageTextRecord(path)
			})),
			{
				path: "Content/\u{f0800}None.uasset",
				signature: "\u{f0800}",
				evidence: { event: "not_gatherable", path: "Content/\u{f0800}None.uasset" }
			}
		]));
	it("keeps reserved scalars in a shard of excluded packages only", () =>
		compare(
			reserved.map((path) => ({
				path,
				signature: `\u{f0000}`,
				evidence: { event: "not_gatherable", path }
			}))
		));
	it("converts a record larger than the request envelope from a bounded record file", () => {
		const path = "Content/Large.uasset";
		return compare([
			{
				path,
				signature: "large",
				evidence: {
					...emptyPackageTextRecord(path),
					occurrences: Array.from({ length: 3 }, (_, row) => ({
						source: `${row}:${"x".repeat(900_000)}`,
						dev_notes: "",
						identity: { status: "resolved", namespace: "", key: String(row) },
						location: {
							kind: "asset_property",
							object_path: "/Game/Large.Asset",
							class_path: "/Script/Engine.Actor",
							property_path: "Text"
						},
						edit_capability: "read_only"
					}))
				}
			}
		]);
	}, 15_000);
});
