// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import type { AuthoringClientShape } from "@ue-shed/authoring-sdk";
import type { AuthoringTableSnapshot } from "@ue-shed/protocol";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AuthoringCombinedView } from "./authoring-combined-view.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

const sourcePath = "/Game/Fixture/DT_Left.DT_Left";
const targetPath = "/Game/Fixture/DT_Right.DT_Right";

function snapshot(args: {
	readonly fields: AuthoringTableSnapshot["table"]["rows"][number]["fields"];
	readonly objectPath: string;
	readonly rowName: string;
}): AuthoringTableSnapshot {
	return {
		authority: { kind: "project_files", packageName: args.objectPath.split(".")[0] ?? "" },
		completeness: "complete",
		contract: { name: "unreal-authoring", version: { major: 1, minor: 0 } },
		diagnostics: [],
		table: {
			kind: "data_table",
			objectPath: args.objectPath,
			parentTables: [],
			rowStruct: "/Script/Fixture.Row",
			rows: [
				{
					fields: args.fields,
					id: `row:${args.rowName}`,
					name: args.rowName
				}
			]
		}
	};
}

const source = snapshot({
	fields: [
		{
			name: "Target",
			typeName: "StructProperty",
			value: { kind: "row_reference", rowName: "Right_Alpha", tableObjectPath: targetPath }
		},
		{ name: "Weight", typeName: "IntProperty", value: { kind: "int", value: "2" } }
	],
	objectPath: sourcePath,
	rowName: "Left_Alpha"
});

const target = snapshot({
	fields: [
		{
			name: "Description",
			typeName: "StrProperty",
			value: { kind: "string", value: "First target" }
		}
	],
	objectPath: targetPath,
	rowName: "Right_Alpha"
});

function client(): AuthoringClientShape {
	return {
		applySession: () => Effect.die("unused"),
		beginSession: () => Effect.die("unused"),
		chooseTable: () => Effect.die("unused"),
		discardSession: () => Effect.die("unused"),
		editSession: () => Effect.die("unused"),
		getCatalogProgress: () => Effect.die("unused"),
		listSessions: () => Effect.die("unused"),
		loadConfiguredCatalog: () => Effect.die("unused"),
		loadConfiguredTable: () => Effect.die("unused"),
		openCatalogTable: (objectPath) =>
			Effect.succeed(
				objectPath === targetPath
					? { snapshot: target, status: "ready" as const }
					: { status: "not_configured" as const }
			),
		openSession: () => Effect.die("unused"),
		reconcileSession: () => Effect.die("unused"),
		redoSession: () => Effect.die("unused"),
		reviewSession: () => Effect.die("unused"),
		saveSession: () => Effect.die("unused"),
		undoSession: () => Effect.die("unused")
	};
}

describe("AuthoringCombinedView", () => {
	it("shows the project table index and isolates participating table columns", async () => {
		const onOpenForEditing = vi.fn();
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<AuthoringCombinedView
					catalogTablePaths={[
						sourcePath,
						targetPath,
						"/Game/Fixture/DT_Unrelated.DT_Unrelated"
					]}
					client={client()}
					initialSnapshot={source}
					onOpenForEditing={onOpenForEditing}
				/>
			</EffectRuntimeProvider>
		));

		expect(screen.getByRole("option", { name: "DT_Unrelated" })).toBeDefined();
		expect(await screen.findByText("First target")).toBeDefined();
		expect(screen.getByRole("columnheader", { name: /sourceDT_Left/i })).toBeDefined();
		expect(screen.getByRole("columnheader", { name: /targetDT_Right/i })).toBeDefined();

		await userEvent.setup().click(screen.getByRole("button", { name: "Isolate DT_Right" }));
		await waitFor(() =>
			expect(screen.queryByRole("columnheader", { name: /sourceDT_Left/i })).toBeNull()
		);
		expect(screen.getByRole("columnheader", { name: /targetDT_Right/i })).toBeDefined();

		await userEvent.setup().click(screen.getByRole("button", { name: "Hide all" }));
		expect(await screen.findByText("All participating tables are hidden.")).toBeDefined();
		await userEvent.setup().click(screen.getByRole("button", { name: "Show all" }));
		expect(screen.getByRole("columnheader", { name: /sourceDT_Left/i })).toBeDefined();

		await userEvent.setup().click(screen.getByRole("button", { name: "Open source editor ↗" }));
		expect(onOpenForEditing).toHaveBeenCalledWith(sourcePath);
	});
});
