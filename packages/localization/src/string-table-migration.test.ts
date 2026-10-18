import { describe, expect, it } from "vitest";
import {
	planStringTableKeyMigration,
	StringTableKeyMigrationId,
	prepareStringTableRedirectConfig,
	type StringTableKeyMigrationRequest
} from "./string-table-migration.js";

export const migration: StringTableKeyMigrationRequest = {
	id: StringTableKeyMigrationId.make("welcome"),
	projectRoot: "C:/Fixture",
	packageFile: "Content/ST_Words.uasset",
	objectPath: "/Game/ST_Words.ST_Words",
	tableId: "/Game/ST_Words.ST_Words",
	namespace: "Words",
	oldKey: "Welcome",
	newKey: "Greeting",
	source: "Welcome aboard",
	references: [
		{
			id: "reference",
			place: {
				packageFile: "Content/DA_Words.uasset",
				objectPath: "/Game/DA_Words.DA_Words",
				propertyPath: "Text"
			}
		}
	]
};

describe("String Table migration planning", () => {
	it("reviews copy, reference retargeting, persisted redirect and explicit removal together", () => {
		const result = planStringTableKeyMigration(migration);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;
		expect(result.plan.copy.edit.kind).toBe("copy_string_table_entry");
		expect(result.plan.retarget[0]?.expected).toMatchObject({
			tableId: migration.tableId,
			key: "Welcome"
		});
		expect(result.plan.remove.edit).toEqual({ kind: "remove_string_table_entry" });
		expect(result.plan.removeRequiresVerifiedRedirect).toBe(true);
		expect(result.plan.referenceCoverage).toBe("caller_supplied");
		expect(result.plan.deleteOldEntry).toBe(false);
	});
	it.each([
		{ ...migration, newKey: "Welcome" },
		{ ...migration, newKey: 'Invalid"Key' },
		{ ...migration, references: [...migration.references, ...migration.references] }
	])("rejects ambiguous or unrepresentable plans", (input) => {
		expect(planStringTableKeyMigration(input).status).toBe("invalid");
	});
	it("preserves surrounding config, BOM and CRLF, and is idempotent", () => {
		const result = planStringTableKeyMigration(migration);
		if (result.status !== "ready") throw new Error("Expected a plan");
		const before = "\uFEFF[Core.StringTable]\r\n; keep this\r\n[Other]\r\nValue=1\r\n";
		const config = prepareStringTableRedirectConfig(before, result.plan.redirect);
		expect(config).toEqual({
			status: "ready",
			after: `\uFEFF[Core.StringTable]\r\n; keep this\r\n+StringTableRedirects=${result.plan.redirect.value}\r\n[Other]\r\nValue=1\r\n`
		});
		if (config.status === "ready")
			expect(prepareStringTableRedirectConfig(config.after, result.plan.redirect)).toEqual(
				config
			);
	});
	it.each([
		`(StringTable="${migration.tableId}",OldKey="Welcome",NewKey="Elsewhere")`,
		`(StringTable=${migration.tableId},OldKey=Welcome,NewKey=Elsewhere)`
	])("rejects an existing different destination %s", (value) => {
		const result = planStringTableKeyMigration(migration);
		if (result.status !== "ready") throw new Error("Expected a plan");
		expect(
			prepareStringTableRedirectConfig(
				`[Core.StringTable]\n+StringTableRedirects=${value}\n`,
				result.plan.redirect
			).status
		).toBe("invalid");
	});
});
