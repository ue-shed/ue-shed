import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { Effect } from "effect";
import { P4, P4DepotPath, P4FileAction } from "p4client-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	changelistRevisions,
	changelistRevisionSpecs,
	rangeRevisionSpecs,
	specBatches,
	workspaceHolds
} from "./perforce-revisions.js";

const file = (action: string, revision: number) => ({
	depotPath: "//Project/Main/Content/UI/WBP_Menu.uasset",
	action,
	revision
});

describe("a changelist's revisions", () => {
	it("compares a submitted file's revision with the one before it", () => {
		expect(changelistRevisionSpecs(file("edit", 4), 220, false)).toEqual({
			base: "//Project/Main/Content/UI/WBP_Menu.uasset#3",
			head: "//Project/Main/Content/UI/WBP_Menu.uasset#4"
		});
		expect(changelistRevisionSpecs(file("add", 1), 220, false)).toEqual({
			head: "//Project/Main/Content/UI/WBP_Menu.uasset#1"
		});
		expect(changelistRevisionSpecs(file("delete", 5), 220, false)).toEqual({
			base: "//Project/Main/Content/UI/WBP_Menu.uasset#4"
		});
		expect(changelistRevisionSpecs(file("move/add", 1), 220, false)).toEqual({
			head: "//Project/Main/Content/UI/WBP_Menu.uasset#1"
		});
	});

	it("compares a shelved file with the revision the shelf is based on", () => {
		expect(changelistRevisionSpecs(file("edit", 4), 230, true)).toEqual({
			base: "//Project/Main/Content/UI/WBP_Menu.uasset#4",
			head: "//Project/Main/Content/UI/WBP_Menu.uasset@=230"
		});
		expect(changelistRevisionSpecs(file("add", 0), 230, true)).toEqual({
			head: "//Project/Main/Content/UI/WBP_Menu.uasset@=230"
		});
		expect(changelistRevisionSpecs(file("delete", 4), 230, true)).toEqual({
			base: "//Project/Main/Content/UI/WBP_Menu.uasset#4"
		});
	});
});

describe("a range's revisions", () => {
	it("compares a file's revision at the start with its last one in the range", () => {
		expect(
			rangeRevisionSpecs({ depotPath: "//p/A.uasset", revision: 7, deleted: false }, 4)
		).toEqual({ action: "edit", base: "//p/A.uasset#4", head: "//p/A.uasset#7" });
	});

	it("has no base for a file the range adds, and no head for one it deletes", () => {
		expect(
			rangeRevisionSpecs(
				{ depotPath: "//p/A.uasset", revision: 1, deleted: false },
				undefined
			)
		).toEqual({ action: "add", head: "//p/A.uasset#1" });
		expect(
			rangeRevisionSpecs({ depotPath: "//p/A.uasset", revision: 5, deleted: true }, 4)
		).toEqual({ action: "delete", base: "//p/A.uasset#4" });
	});

	it("lists a long range's files in batches a command line holds", () => {
		const specs = Array.from(
			{ length: 600 },
			(_, index) => `//Project/Main/Content/UI/Widgets/WBP_Widget_${index}.uasset@220670`
		);
		const batches = specBatches(specs);
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat()).toEqual(specs);
		for (const batch of batches)
			expect(batch.reduce((size, spec) => size + spec.length + 3, 0)).toBeLessThanOrEqual(
				24_000
			);
		expect(specBatches([])).toEqual([]);
	});

	it("leaves out a file the range adds and deletes", () => {
		expect(
			rangeRevisionSpecs({ depotPath: "//p/A.uasset", revision: 2, deleted: true }, undefined)
		).toBeUndefined();
	});
});

describe("a file at a revision", () => {
	it("is read from the workspace only when the workspace has that revision unopened", () => {
		expect(workspaceHolds(7, 7, false)).toBe(true);
		expect(workspaceHolds(7, 8, false)).toBe(false);
		expect(workspaceHolds(7, undefined, false)).toBe(false);
		// Checked out: the workspace copy may hold edits.
		expect(workspaceHolds(7, 7, true)).toBe(false);
	});
});

const PREFIX = "//Depot/Project/";
const PACKAGES = Array.from({ length: 20 }, (_, index) => `Content/UI/WBP_Panel${index}.uasset`);
const MANIFEST = "Content/Localization/Game/Game.manifest";
const ARCHIVE = "Content/Localization/Game/de/Game.archive";

/**
 * A server at `address` holding submitted change 7, which edits `PACKAGES` to #3. The project's
 * manifest and archive are at #5 before it; the workspace has the manifest at #5 and the archive
 * at #4. A printed revision's bytes name the server and the revision, and every print is kept.
 */
function fakeServer(address: string, projectRoot: string) {
	const batches: string[][] = [];
	const content = (spec: string) => new TextEncoder().encode(`${address} ${spec}`);
	const depotFile = (spec: string) => P4DepotPath.make(spec.replace(/[#@].*$/u, ""));
	const layer = P4.layerTest({
		getEnvironment: () =>
			Effect.succeed({
				user: "reviewer",
				client: "workspace",
				clientHost: null,
				port: address,
				serverAddress: address,
				serverVersion: null,
				unicode: false,
				caseInsensitive: true,
				messages: []
			}),
		whereFiles: () =>
			Effect.succeed({
				items: [
					{
						depotFile: P4DepotPath.make(`${PREFIX}...`),
						clientFile: null,
						localFile: null,
						isExcluded: false
					}
				],
				messages: [],
				failures: []
			}),
		describeChangelist: () =>
			Effect.succeed({
				change: 7,
				status: "submitted",
				user: "artist",
				client: "workspace",
				description: "Rework the panels",
				createdAt: null,
				messages: [],
				files: PACKAGES.map((path) => ({
					depotFile: P4DepotPath.make(`${PREFIX}${path}`),
					action: P4FileAction.make("edit"),
					type: "binary",
					revision: 3,
					digest: null,
					fileSize: null
				}))
			}),
		listFiles: (options) =>
			Effect.succeed({
				items: [options.fileSpec].flat().map((spec) => {
					const path = spec.slice(projectRoot.length + 1).replace(/[#@].*$/u, "");
					return {
						depotFile: P4DepotPath.make(`${PREFIX}${path}`),
						name: path,
						revision: spec.endsWith("#have") && path === ARCHIVE ? 4 : 5,
						action: P4FileAction.make("edit"),
						type: "text",
						change: null,
						submittedAt: null,
						isDeletedAtHead: false,
						isBinary: false
					};
				}),
				messages: [],
				hasMore: false,
				failures: []
			}),
		printBatch: (options) => {
			batches.push([...options.fileSpec]);
			return Effect.succeed({
				items: options.fileSpec.map((spec) => ({
					file: {
						depotFile: depotFile(spec),
						revision: null,
						change: null,
						action: null,
						type: null,
						time: null,
						fileSize: null
					},
					content: content(spec)
				})),
				printed: [],
				messages: [],
				failures: []
			});
		},
		// `print -q -o <file> <spec>`, which writes the revision itself.
		runTagged: (options: { readonly args: readonly string[] }) =>
			Effect.promise(async () => {
				const [, , , target, spec] = options.args;
				if (target === undefined || spec === undefined)
					throw new Error(`Unexpected command: ${options.args.join(" ")}`);
				await writeFile(target, content(spec));
				const items: never[] = [];
				return { items, messages: [], failures: [] };
			})
	});
	return { layer, batches };
}

describe("a changelist read from a server", () => {
	let root = "";
	const project = () => join(root, "Project");
	const cache = () => join(root, "revisions");

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "ue-shed-revisions-"));
		const manifest = join(project(), MANIFEST);
		await mkdir(dirname(manifest), { recursive: true });
		await writeFile(manifest, "workspace manifest");
		// Perforce leaves a file the workspace has but has not opened read-only.
		await chmod(manifest, 0o444);
	});

	afterEach(async () => {
		await chmod(join(project(), MANIFEST), 0o644);
		await rm(root, { recursive: true, force: true });
	});

	const read = (server: ReturnType<typeof fakeServer>) =>
		Effect.runPromise(
			changelistRevisions({
				projectRoot: project(),
				change: 7,
				shelved: false,
				directory: cache(),
				reads: () => true,
				before: [MANIFEST, ARCHIVE]
			}).pipe(Effect.provide(server.layer))
		);

	it("prints each side in batches, then reuses every revision it printed", async () => {
		const server = fakeServer("perforce:1666", project());
		const first = await read(server);
		expect(server.batches.map((batch) => batch.length)).toEqual([16, 4, 16, 4]);
		expect(first).toMatchObject({ printed: 40, reused: 0 });
		for (const file of first.files) {
			expect(file.base && (await readFile(file.base, "utf8"))).toBe(
				`perforce:1666 ${file.depotPath}#2`
			);
			expect(file.head && (await readFile(file.head, "utf8"))).toBe(
				`perforce:1666 ${file.depotPath}#3`
			);
		}

		server.batches.length = 0;
		const again = await read(server);
		expect(server.batches).toEqual([]);
		expect(again).toMatchObject({ printed: 0, reused: 40 });
		expect(again.before).toMatchObject({ printed: 0, reused: 2 });
		expect(again.files).toEqual(first.files);
	});

	it("keeps two servers' revisions apart, naming the server of workspace and cached files", async () => {
		const one = await read(fakeServer("one:1666", project()));
		const other = await read(fakeServer("other:1666", project()));
		// The same depot paths and revisions, on another server, are printed again.
		expect(other).toMatchObject({ printed: 40, reused: 0 });
		const head = other.files[0]?.head;
		expect(head && (await readFile(head, "utf8"))).toBe(`other:1666 ${PREFIX}${PACKAGES[0]}#3`);

		const files = (read: typeof one) =>
			(read.before?.files ?? []).map((file) => ({
				path: file.path,
				workspace: file.workspace,
				server: file.server,
				folder: relative(cache(), file.file).split(sep)[0]
			}));
		const [manifest, archive] = files(one);
		const [otherManifest, otherArchive] = files(other);
		expect([manifest?.workspace, archive?.workspace]).toEqual([true, false]);
		expect(manifest?.server).toBe(archive?.server);
		expect(otherManifest?.server).toBe(otherArchive?.server);
		expect(otherManifest?.server).not.toBe(manifest?.server);
		// A cached revision sits in its server's folder.
		expect(archive?.folder).toBe(archive?.server);
		expect(otherArchive?.folder).toBe(otherArchive?.server);
		const archiveFile = other.before?.files[1]?.file;
		expect(archiveFile && (await readFile(archiveFile, "utf8"))).toBe(
			`other:1666 ${PREFIX}${ARCHIVE}#5`
		);
	});
});
