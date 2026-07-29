import { TextureAuditLive } from "@ue-shed/asset-audits";
import {
	ReviewAuthoringLive,
	ReviewAuthoringSessionsLive,
	ReviewCaptureLive,
	ReviewIdGeneratorLive,
	ReviewRepositoryLive,
	cameraFeedLayer,
	reviewCaptureRemotePortLayer
} from "@ue-shed/cameras";
import { AuthoringCatalogLive } from "@ue-shed/authoring-catalog";
import { EnhancedInputServiceLive } from "@ue-shed/enhanced-input";
import { TextCorpusServiceLive } from "@ue-shed/game-text";
import { EditorPlaySessionLive } from "@ue-shed/engine-discovery";
import { AuthoringClientLive } from "@ue-shed/host";
import { runtimeObservabilityLayer } from "@ue-shed/observability";
import { ObservatoryLive } from "@ue-shed/observatory";
import { AssetReaderLive } from "@ue-shed/unreal-assets";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { electronAppLayer, type ElectronAppHost } from "./adapters/electron-app.js";
import { ElectronDialogLive } from "./adapters/electron-dialog.js";
import { electronIpcLayer, type ElectronIpcHost } from "./adapters/electron-ipc.js";
import { workbenchWindowLayer, type WorkbenchWindowOptions } from "./adapters/electron-window.js";
import { fixtureProcessLayer } from "./adapters/fixture-process.js";
import { LocalFilesLive } from "./adapters/local-files.js";
import { ProjectInventoryCacheLive } from "./adapters/project-inventory-cache.js";
import { register as registerWorkbenchIpc } from "./ipc/register.js";
import { WorkbenchAssetAuditsLive } from "./services/asset-audits.js";
import { WorkbenchAuthoringLive, WorkbenchAuthoringSessionsLive } from "./services/authoring.js";
import { CameraPresentationLive } from "./services/camera-presentation.js";
import { FixtureHealthLive, FixtureLauncherLive } from "./services/fixture-launcher.js";
import { WorkbenchGameTextLive } from "./services/game-text.js";
import { WorkbenchInputAtlasLive } from "./services/input-atlas.js";
import { WorkbenchMapReviewLive } from "./services/map-review.js";
import { WorkbenchProjectLive } from "./services/project-workspace.js";
import { ShowcaseLive } from "./services/showcase.js";
import { WorkbenchConfiguration, WorkbenchConfigurationLive } from "./workbench-config.js";

export interface WorkbenchHosts {
	readonly app: ElectronAppHost;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly ipc: ElectronIpcHost;
}

const windowOptions: WorkbenchWindowOptions = {
	backgroundColor: "#0b0d0d",
	height: 940,
	htmlPath: join(import.meta.dirname, "../renderer/index.html"),
	minHeight: 720,
	minWidth: 1120,
	preloadPath: join(import.meta.dirname, "preload.cjs"),
	title: "UE Shed Workbench",
	width: 1540
};

/**
 * `WorkbenchConfiguration` plus the Electron host adapters and the process-level
 * infrastructure services that have no Workbench-internal dependencies.
 */
function baseLayer(hosts: WorkbenchHosts) {
	return Layer.mergeAll(
		runtimeObservabilityLayer({
			serviceName: "ue-shed-workbench",
			serviceVersion: "0.0.0"
		}),
		electronAppLayer(hosts.app),
		electronIpcLayer(hosts.ipc),
		workbenchWindowLayer(windowOptions),
		AssetReaderLive,
		RemoteControlClientLive,
		EditorPlaySessionLive.pipe(Layer.provide(RemoteControlClientLive)),
		ReviewRepositoryLive,
		ReviewIdGeneratorLive,
		cameraFeedLayer(),
		LocalFilesLive,
		fixtureProcessLayer(hosts.environment)
	).pipe(Layer.provideMerge(WorkbenchConfigurationLive));
}

/** Domain catalog and audit services that only need the base infrastructure. */
function domainCatalogLayer(hosts: WorkbenchHosts) {
	const project = WorkbenchProjectLive.pipe(
		Layer.provide(
			Layer.mergeAll(ElectronDialogLive, EnhancedInputServiceLive, ProjectInventoryCacheLive)
		)
	);
	return Layer.mergeAll(
		ElectronDialogLive,
		TextureAuditLive,
		TextCorpusServiceLive,
		EnhancedInputServiceLive,
		AuthoringCatalogLive,
		project
	).pipe(Layer.provideMerge(baseLayer(hosts)));
}

/** Review capture/authoring plus the demand-driven fixture launcher. */
function reviewAndFixtureLayer(hosts: WorkbenchHosts) {
	const reviewCapturePort = Layer.unwrap(
		Effect.map(WorkbenchConfiguration, (configuration) =>
			reviewCaptureRemotePortLayer(configuration.remoteControlEndpoint)
		)
	);
	return Layer.mergeAll(
		ReviewAuthoringLive,
		ReviewAuthoringSessionsLive.pipe(Layer.provide(ReviewAuthoringLive)),
		ReviewCaptureLive.pipe(Layer.provide(reviewCapturePort)),
		FixtureLauncherLive.pipe(Layer.provide(FixtureHealthLive))
	).pipe(Layer.provideMerge(domainCatalogLayer(hosts)));
}

/** Workbench-owned application services surfaced directly to IPC registration. */
function featureLayer(hosts: WorkbenchHosts) {
	const authoring = WorkbenchAuthoringLive.pipe(Layer.provide(WorkbenchAuthoringSessionsLive));
	const authoringClient = AuthoringClientLive.pipe(Layer.provide(authoring));
	const mapReview = WorkbenchMapReviewLive.pipe(Layer.provide(ObservatoryLive));
	return Layer.mergeAll(
		ShowcaseLive,
		WorkbenchAssetAuditsLive,
		WorkbenchGameTextLive,
		WorkbenchInputAtlasLive,
		authoring,
		authoringClient,
		mapReview,
		CameraPresentationLive
	).pipe(Layer.provideMerge(reviewAndFixtureLayer(hosts)));
}

/**
 * The complete, topologically sorted Workbench runtime graph. Optional project, review,
 * audit, authoring-asset, and launcher configuration produce usable not-configured feature
 * services rather than failing acquisition. Malformed explicit configuration, an unavailable
 * `BrowserWindow`, a camera pipe bind failure, or an IPC registration defect may still fail
 * startup with a typed error.
 *
 * Acquiring this layer never launches Unreal and never polls fixture health; it only builds
 * services, forks scoped presentation/camera workers, and registers IPC handlers.
 * Observatory named-pipe observation starts only when Map Review subscribes and stops when that
 * subscription scope closes — Workbench never begins actor sampling at layer acquisition.
 */
export function WorkbenchLive(hosts: WorkbenchHosts) {
	return Layer.effectDiscard(registerWorkbenchIpc).pipe(Layer.provideMerge(featureLayer(hosts)));
}
