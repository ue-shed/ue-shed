import {
	NIAGARA_SYSTEM_CLASS,
	NiagaraPreview,
	NiagaraPreviewError,
	NiagaraSystemObjectPath,
	decodeNiagaraPreviewRunManifest,
	type NiagaraPreviewFailure
} from "@ue-shed/niagara";
import type {
	NiagaraPreviewClientApi,
	NiagaraPreviewFrameIntent,
	NiagaraPreviewFrameResult,
	NiagaraPreviewIntent,
	NiagaraPreviewRunResult
} from "@ue-shed/extension-niagara-preview/client";
import { AssetReader, isHeaderScanEntry, type SavedAssetScan } from "@ue-shed/unreal-assets";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

const previewRootName = ".ue-shed/niagara-preview";
const ProjectEngineAssociation = Schema.Struct({
	EngineAssociation: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+\.\d+$/u)))
});

function failure(
	code: NiagaraPreviewFailure["code"],
	message: string,
	recovery: string,
	stage: NiagaraPreviewFailure["stage"] = "validation",
	retrySafe = false
): NiagaraPreviewFailure {
	return { code, message, recovery, retrySafe, stage };
}

function failureResult(error: NiagaraPreviewFailure): NiagaraPreviewRunResult {
	return { error, status: "failed" };
}

function frameFailure(error: NiagaraPreviewFailure): NiagaraPreviewFrameResult {
	return { error, status: "failed" };
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isContainedPath(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath !== "" &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`) &&
		!isAbsolute(relativePath)
	);
}

function existing(path: string): Effect.Effect<boolean> {
	return Effect.promise(() =>
		access(path)
			.then(() => true)
			.catch(() => false)
	);
}

function projectDescriptor(projectRoot: string): Effect.Effect<string, NiagaraPreviewFailure> {
	return Effect.tryPromise({
		try: async () =>
			(await readdir(projectRoot, { withFileTypes: true }))
				.filter(
					(entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".uproject"
				)
				.map((entry) => join(projectRoot, entry.name)),
		catch: (cause) =>
			failure(
				"invalid_request",
				`The selected project directory could not be read: ${messageOf(cause)}`,
				"Choose a readable Unreal project directory and retry."
			)
	}).pipe(
		Effect.flatMap((descriptors) => {
			const descriptor = descriptors[0];
			if (descriptors.length === 1 && descriptor !== undefined)
				return Effect.succeed(descriptor);
			return Effect.fail(
				failure(
					"invalid_request",
					descriptors.length === 0
						? `No .uproject descriptor exists in ${projectRoot}.`
						: `More than one .uproject descriptor exists in ${projectRoot}.`,
					"Choose a project directory containing exactly one .uproject descriptor."
				)
			);
		})
	);
}

function engineAssociation(descriptor: string): Effect.Effect<string | undefined> {
	return Effect.tryPromise({
		try: () => readFile(descriptor, "utf8").then(JSON.parse),
		catch: (cause) => cause
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ProjectEngineAssociation)),
		Effect.map((metadata) => metadata.EngineAssociation),
		Effect.catch(() => Effect.succeed(undefined))
	);
}

function pluginDescriptor(options: {
	readonly projectDescriptor: string;
	readonly projectRoot: string;
	readonly sourceCheckout: string | undefined;
}): Effect.Effect<string | undefined> {
	return Effect.gen(function* () {
		const installed = join(
			options.projectRoot,
			"Plugins",
			"UEShedNiagara",
			"UEShedNiagara.uplugin"
		);
		if (yield* existing(installed)) return installed;
		if (options.sourceCheckout === undefined) return undefined;
		const association = yield* engineAssociation(options.projectDescriptor);
		if (association === undefined) return undefined;
		const staged = join(
			options.sourceCheckout,
			"out",
			"workbench-plugin-host",
			association,
			"RuntimePlugins",
			"UEShedNiagara",
			"UEShedNiagara.uplugin"
		);
		return (yield* existing(staged)) ? staged : undefined;
	});
}

export interface WorkbenchNiagaraPreviewApi extends NiagaraPreviewClientApi {}

export class WorkbenchNiagaraPreview extends Context.Service<
	WorkbenchNiagaraPreview,
	WorkbenchNiagaraPreviewApi
>()("@ue-shed/workbench/WorkbenchNiagaraPreview") {}

export const WorkbenchNiagaraPreviewLive = Layer.effect(
	WorkbenchNiagaraPreview,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const niagara = yield* NiagaraPreview;
		const project = yield* WorkbenchProject;
		const assetReader = yield* AssetReader;

		/**
		 * Header-decode only the Project Index's Niagara System candidates so catalogue entries carry
		 * each export's true object path; the index projection alone only knows package names.
		 */
		const niagaraSystemCatalogue = Effect.fn("Workbench.NiagaraPreview.niagaraSystemCatalogue")(
			function* (projectRoot: string, candidates: SavedAssetScan) {
				const paths = candidates.assets
					.filter(isHeaderScanEntry)
					.map((entry) => entry.header.path)
					.sort((left, right) => left.localeCompare(right));
				if (paths.length === 0) return { entries: [], status: "ready" as const };
				const scan = yield* assetReader.scanProject({
					classes: [NIAGARA_SYSTEM_CLASS],
					depth: "header",
					paths,
					projectRoot
				});
				const objectPaths = new Set<string>();
				for (const entry of scan.assets) {
					if (!isHeaderScanEntry(entry)) continue;
					for (const exported of entry.header.exports) {
						if (exported.class_path === NIAGARA_SYSTEM_CLASS) {
							objectPaths.add(exported.object_path);
						}
					}
				}
				return {
					entries: [...objectPaths]
						.sort((left, right) => left.localeCompare(right))
						.flatMap((objectPath) => {
							// One malformed header entry must not reject the whole catalogue.
							const decoded =
								Schema.decodeUnknownOption(NiagaraSystemObjectPath)(objectPath);
							return Option.isSome(decoded) ? [{ objectPath: decoded.value }] : [];
						}),
					status: "ready" as const
				};
			}
		);

		const catalogue = Effect.fn("Workbench.NiagaraPreview.catalogue")(function* () {
			const current = yield* project.current();
			if (current.status === "not_configured" || current.status === "cancelled") {
				return { status: "not_configured" as const };
			}
			if (current.status === "failed") {
				return {
					error: { message: current.error.message, recovery: current.error.recovery },
					status: "failed" as const
				};
			}
			const readerFailure =
				"Check that the saved-asset worker can read this project's packages, then retry.";
			return yield* project.candidates("niagara_system").pipe(
				Effect.flatMap((candidates) =>
					niagaraSystemCatalogue(current.project.projectRoot, candidates)
				),
				Effect.catchTag("WorkbenchProjectUnavailable", (error) =>
					Effect.succeed({
						error: { message: error.message, recovery: error.recovery },
						status: "failed" as const
					})
				),
				Effect.catchTag("AssetReaderError", (error) =>
					Effect.succeed({
						error: { message: error.message, recovery: readerFailure },
						status: "failed" as const
					})
				)
			);
		});

		const run = Effect.fn("Workbench.NiagaraPreview.run")(function* (
			intent: NiagaraPreviewIntent
		) {
			return yield* Effect.gen(function* () {
				const selected = yield* project.selectedProject();
				const descriptor = yield* projectDescriptor(selected.projectRoot);
				const plugin = yield* pluginDescriptor({
					projectDescriptor: descriptor,
					projectRoot: selected.projectRoot,
					sourceCheckout:
						configuration.sourceCheckout.status === "configured"
							? configuration.sourceCheckout.path
							: undefined
				});
				const outcome = yield* niagara.run({
					...(configuration.unrealEngineRoot?.status === "configured"
						? { explicitEngineRoot: configuration.unrealEngineRoot.path }
						: undefined),
					...(plugin === undefined ? undefined : { pluginDescriptor: plugin }),
					projectDescriptor: descriptor,
					settings: intent.settings,
					systemObjectPath: intent.systemObjectPath
				});
				return {
					manifest: outcome.manifest,
					manifestPath: outcome.manifestPath,
					status: "completed" as const
				};
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failureResult(
							cause instanceof NiagaraPreviewError
								? cause
								: failure(
										"invalid_request",
										messageOf(cause),
										"Choose a Workbench project, verify its descriptor, and retry."
									)
						)
					)
				)
			);
		});

		const frame = Effect.fn("Workbench.NiagaraPreview.frame")(function* (
			intent: NiagaraPreviewFrameIntent
		) {
			return yield* Effect.gen(function* () {
				const selected = yield* project.selectedProject();
				const previewRoot = resolve(selected.projectRoot, previewRootName);
				const manifestPath = resolve(intent.manifestPath);
				if (
					basename(manifestPath) !== "manifest.json" ||
					!isContainedPath(previewRoot, manifestPath)
				) {
					return yield* Effect.fail(
						failure(
							"artifact_invalid",
							"The preview manifest is outside the selected project.",
							"Select or capture a Niagara Preview Run owned by this project.",
							"publication"
						)
					);
				}
				const manifest = yield* Effect.tryPromise({
					try: () => readFile(manifestPath, "utf8").then(JSON.parse),
					catch: (cause) =>
						failure(
							"artifact_invalid",
							`The preview manifest could not be read: ${messageOf(cause)}`,
							"Inspect or recapture the immutable run.",
							"publication"
						)
				}).pipe(
					Effect.flatMap(decodeNiagaraPreviewRunManifest),
					Effect.mapError((cause) =>
						"code" in cause
							? cause
							: failure(
									"artifact_invalid",
									"The preview manifest does not match contract v1.",
									"Inspect or recapture the immutable run.",
									"publication"
								)
					)
				);
				const artifact = manifest.artifacts.find(
					(candidate) => candidate.relativePath === intent.relativePath
				);
				if (artifact === undefined) {
					return yield* Effect.fail(
						failure(
							"artifact_invalid",
							"The requested frame is not listed by this manifest.",
							"Select a manifest-owned frame.",
							"publication"
						)
					);
				}
				const runRoot = dirname(manifestPath);
				const artifactPath = resolve(runRoot, ...artifact.relativePath.split("/"));
				if (!isContainedPath(runRoot, artifactPath)) {
					return yield* Effect.fail(
						failure(
							"artifact_invalid",
							"The requested frame resolves outside its immutable run.",
							"Inspect or recapture the run.",
							"publication"
						)
					);
				}
				const bytes = yield* Effect.tryPromise({
					try: () => readFile(artifactPath),
					catch: (cause) =>
						failure(
							"artifact_invalid",
							`The requested frame could not be read: ${messageOf(cause)}`,
							"Inspect or recapture the run.",
							"publication"
						)
				});
				const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
				if (bytes.byteLength !== artifact.bytes || hash !== artifact.sha256) {
					return yield* Effect.fail(
						failure(
							"artifact_invalid",
							"The requested frame no longer matches its immutable manifest.",
							"Inspect or recapture the run before trusting this frame.",
							"publication"
						)
					);
				}
				return { bytes: new Uint8Array(bytes), status: "ready" as const };
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						frameFailure(
							"code" in cause
								? cause
								: failure(
										"artifact_invalid",
										messageOf(cause),
										"Inspect or recapture the immutable run.",
										"publication"
									)
						)
					)
				)
			);
		});

		return WorkbenchNiagaraPreview.of({ catalogue, frame, run });
	})
);

export function makeWorkbenchNiagaraPreviewTestLayer(
	service: WorkbenchNiagaraPreviewApi
): Layer.Layer<WorkbenchNiagaraPreview> {
	return Layer.succeed(WorkbenchNiagaraPreview, WorkbenchNiagaraPreview.of(service));
}
