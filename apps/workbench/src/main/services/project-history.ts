import { Context, Effect, Layer, Ref, Schema, Semaphore } from "effect";
import { join } from "node:path";
import { ElectronApp } from "../adapters/electron-app.js";
import { LocalFiles, type LocalFilesError } from "../adapters/local-files.js";
import type { WorkbenchRecentProject } from "../project-workspace-contract.js";

const PROJECT_HISTORY_LIMIT = 8;
const PROJECT_HISTORY_MAX_BYTES = 32 * 1_024;

const ProjectHistoryDocument = Schema.Struct({
	projectRoots: Schema.Array(Schema.NonEmptyString),
	schemaVersion: Schema.Literal(1)
});
interface ProjectHistoryDocument extends Schema.Schema.Type<typeof ProjectHistoryDocument> {}

export interface WorkbenchProjectHistoryApi {
	readonly recent: () => Effect.Effect<readonly WorkbenchRecentProject[]>;
	readonly record: (projectRoot: string) => Effect.Effect<void, LocalFilesError>;
}

export class WorkbenchProjectHistory extends Context.Service<
	WorkbenchProjectHistory,
	WorkbenchProjectHistoryApi
>()("@ue-shed/workbench/WorkbenchProjectHistory") {}

function cleanProjectRoot(projectRoot: string): string {
	const trimmed = projectRoot.trim();
	if (trimmed === "/" || /^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed;
	return trimmed.replace(/[\\/]+$/, "");
}

function projectKey(projectRoot: string): string {
	return cleanProjectRoot(projectRoot).replaceAll("\\", "/").toLocaleLowerCase();
}

function projectName(projectRoot: string): string {
	const normalized = cleanProjectRoot(projectRoot).replaceAll("\\", "/");
	return normalized.split("/").at(-1) || normalized;
}

function recentProjects(document: ProjectHistoryDocument): readonly WorkbenchRecentProject[] {
	return document.projectRoots.map((projectRoot) => ({
		projectName: projectName(projectRoot),
		projectRoot
	}));
}

const emptyDocument = (): ProjectHistoryDocument => ({ projectRoots: [], schemaVersion: 1 });
const decodeDocument = Schema.decodeUnknownEffect(ProjectHistoryDocument);

export const WorkbenchProjectHistoryLive = Layer.effect(
	WorkbenchProjectHistory,
	Effect.gen(function* () {
		const app = yield* ElectronApp;
		const files = yield* LocalFiles;
		const historyPath = join(yield* app.getPath("userData"), "project-history-v1.json");
		const initial = yield* files
			.readFile(historyPath, { maxBytes: PROJECT_HISTORY_MAX_BYTES })
			.pipe(
				Effect.flatMap((bytes) =>
					Effect.try(() => JSON.parse(new TextDecoder().decode(bytes)))
				),
				Effect.flatMap(decodeDocument),
				Effect.catch(() => Effect.succeed(emptyDocument()))
			);
		const document = yield* Ref.make(initial);
		const writeGate = yield* Semaphore.make(1);

		const recent = Effect.fn("Workbench.ProjectHistory.recent")(function* () {
			return recentProjects(yield* Ref.get(document));
		});
		const record = Effect.fn("Workbench.ProjectHistory.record")(function* (
			projectRoot: string
		) {
			const root = cleanProjectRoot(projectRoot);
			if (root === "") return;
			yield* writeGate.withPermits(1)(
				Effect.gen(function* () {
					const current = yield* Ref.get(document);
					const key = projectKey(root);
					if (current.projectRoots[0] && projectKey(current.projectRoots[0]) === key)
						return;
					const next: ProjectHistoryDocument = {
						projectRoots: [
							root,
							...current.projectRoots.filter(
								(candidate) => projectKey(candidate) !== key
							)
						].slice(0, PROJECT_HISTORY_LIMIT),
						schemaVersion: 1
					};
					yield* files.writeFile(
						historyPath,
						new TextEncoder().encode(JSON.stringify(next, undefined, "\t") + "\n"),
						{ maxBytes: PROJECT_HISTORY_MAX_BYTES }
					);
					yield* Ref.set(document, next);
				})
			);
		});

		return WorkbenchProjectHistory.of({ recent, record });
	})
);

export function makeWorkbenchProjectHistoryTestLayer(
	initialProjectRoots: readonly string[] = []
): Layer.Layer<WorkbenchProjectHistory> {
	return Layer.effect(
		WorkbenchProjectHistory,
		Effect.gen(function* () {
			const roots = yield* Ref.make([...initialProjectRoots]);
			return WorkbenchProjectHistory.of({
				recent: Effect.fn("Workbench.ProjectHistory.Test.recent")(function* () {
					return recentProjects({
						projectRoots: yield* Ref.get(roots),
						schemaVersion: 1
					});
				}),
				record: Effect.fn("Workbench.ProjectHistory.Test.record")(function* (projectRoot) {
					const current = yield* Ref.get(roots);
					const root = cleanProjectRoot(projectRoot);
					const key = projectKey(root);
					yield* Ref.set(
						roots,
						[
							root,
							...current.filter((candidate) => projectKey(candidate) !== key)
						].slice(0, PROJECT_HISTORY_LIMIT)
					);
				})
			});
		})
	);
}
