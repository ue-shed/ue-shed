import { Context, Effect, Layer } from "effect";
import {
	P4CommandError,
	type P4CommandExecutor,
	type P4ChangelistDescription,
	type P4DepotPath,
	type P4FileAction,
	type P4LocalPath
} from "p4client-ts";
import { describe, expect, it } from "vitest";
import {
	makePerforceHistorySource,
	PerforceHistorySource,
	PerforceProjectContext,
	perforceHistorySourceLayer,
	selectPerforceWorkspace
} from "./perforce.js";

function backend() {
	const description: P4ChangelistDescription = {
		change: 42,
		client: "workspace",
		createdAt: "2026/07/28 12:00:00",
		createdAtIso: "2026-07-28T12:00:00.000Z",
		description: "Move actor",
		files: [
			{
				action: "edit" as P4FileAction,
				depotFile: "//Project/Main/Content/Maps/L_Example.umap" as P4DepotPath,
				revision: 7,
				type: "binary"
			}
		],
		status: "submitted",
		user: "artist"
	};
	return {
		describeChangelist: () => Effect.succeed(description),
		listDepotFilesAtChange: () => Effect.succeed({ hasMore: false, items: [] }),
		listSubmittedChangelists: () =>
			Effect.succeed({
				hasMore: false,
				items: [
					{
						change: 42,
						client: "workspace",
						createdAt: "2026/07/28 12:00:00",
						createdAtIso: "2026-07-28T12:00:00.000Z",
						description: "Move actor",
						status: "submitted" as const,
						user: "artist"
					}
				],
				nextBeforeChange: null
			}),
		materializeDepotFiles: () =>
			Effect.succeed({
				directory: "C:/temp/history" as P4LocalPath,
				items: [],
				totalCount: 0
			}),
		resolveLocalPath: () =>
			Effect.succeed({ depotPath: "//Project/Main/Content/Maps/L_Example.umap" })
	};
}

describe("PerforceHistorySource", () => {
	it("selects the workspace bound to the selected project root", () => {
		expect(
			selectPerforceWorkspace({
				configuredClient: "configured-client",
				projectRoot: "D:/Perforce/ExampleProject",
				workspaces: [
					{ client: "example-client", root: "d:\\Perforce\\ExampleProject" },
					{ client: "other-client", root: "E:\\Perforce\\OtherProject" }
				]
			})
		).toBe("example-client");
	});

	it("resolves a backend against the selected project context", async () => {
		const roots: (string | undefined)[] = [];
		const source = makePerforceHistorySource((projectRoot) => {
			roots.push(projectRoot);
			return backend();
		});

		await Effect.runPromise(
			source
				.listSubmittedChangelists({ limit: 1 })
				.pipe(Effect.provideService(PerforceProjectContext, "D:/Perforce/ExampleProject"))
		);

		expect(roots).toEqual(["D:/Perforce/ExampleProject"]);
	});

	it("runs project-scoped commands with the matching client", async () => {
		const calls: {
			readonly args: readonly string[];
			readonly client: string | undefined;
			readonly cwd: string | undefined;
		}[] = [];
		const executor: P4CommandExecutor = async (_command, args, options) => {
			calls.push({ args, cwd: options.cwd, client: options.env?.P4CLIENT });
			const command = args.find(
				(argument) => argument === "info" || argument === "clients" || argument === "where"
			);
			const stdout =
				command === "info"
					? "User name: developer\nClient name: configured-client\nClient host: DEV-WORKSTATION\n"
					: command === "clients"
						? `${JSON.stringify({ client: "example-client", Host: "DEV-WORKSTATION", Owner: "developer", Root: "D:\\Perforce\\ExampleProject" })}\n`
						: `${JSON.stringify({ depotFile: "//Depot/Main/Content/Maps/Example.umap" })}\n`;
			return { args: [...args], command: "p4", exitCode: 0, stderr: "", stdout };
		};
		const context = await Effect.runPromise(
			Effect.scoped(Layer.build(perforceHistorySourceLayer({ executor })))
		);
		const source = Context.get(context, PerforceHistorySource);

		const mapping = await Effect.runPromise(
			source
				.resolveLocalPath("D:/Perforce/ExampleProject/Content/Maps/Example.umap")
				.pipe(Effect.provideService(PerforceProjectContext, "D:/Perforce/ExampleProject"))
		);

		expect(mapping.depotPath).toBe("//Depot/Main/Content/Maps/Example.umap");
		const whereCall = calls.find((call) => call.args.includes("where"));
		expect(whereCall?.cwd).toBe("D:/Perforce/ExampleProject");
		expect(whereCall?.client).toBe("example-client");
	});

	it("translates p4client values at the acquisition boundary", async () => {
		const source = makePerforceHistorySource(backend());

		const result = await Effect.runPromise(
			source.listSubmittedChangelists({
				fileSpec: "//Project/Main/Content/Maps/...",
				limit: 100
			})
		);

		expect(result).toEqual({
			hasMore: false,
			items: [
				{
					change: 42,
					description: "Move actor",
					submittedAt: "2026-07-28T12:00:00.000Z",
					user: "artist"
				}
			],
			nextBeforeChange: null
		});
	});

	it("maps authentication failures to the map-history error vocabulary", async () => {
		const source = makePerforceHistorySource({
			...backend(),
			listSubmittedChangelists: () =>
				Effect.fail(
					new P4CommandError(
						"Perforce password invalid or unset.",
						{
							args: ["changes"],
							command: "p4",
							exitCode: 1,
							stderr: "Perforce password invalid or unset.",
							stdout: ""
						},
						"authentication"
					)
				)
		});

		const error = await Effect.runPromise(
			Effect.flip(source.listSubmittedChangelists({ limit: 1 }))
		);

		expect(error.kind).toBe("perforce_authentication");
		expect(error.retrySafe).toBe(false);
	});
});
