import { TextureAuditLive } from "@ue-shed/asset-audits";
import {
	ReviewAuthoringLive,
	ReviewCaptureLive,
	ReviewIdGeneratorLive,
	ReviewRepositoryLive,
	cameraFeedLayer,
	reviewCaptureRemotePortLayer
} from "@ue-shed/cameras";
import { AuthoringCatalogLive } from "@ue-shed/authoring-catalog";
import { TextCorpusServiceLive } from "@ue-shed/game-text";
import { AssetReaderLive } from "@ue-shed/unreal-assets";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { electronAppLayer, type ElectronAppHost } from "./adapters/electron-app.js";
import { ElectronDialogLive } from "./adapters/electron-dialog.js";
import { electronIpcLayer, type ElectronIpcHost } from "./adapters/electron-ipc.js";
import { workbenchWindowLayer, type WorkbenchWindowOptions } from "./adapters/electron-window.js";
import { FixtureProcessLive } from "./adapters/fixture-process.js";
import { LocalFilesLive } from "./adapters/local-files.js";
import { register as registerWorkbenchIpc } from "./ipc/register.js";
import { WorkbenchAssetAuditsLive } from "./services/asset-audits.js";
import { WorkbenchAuthoringLive } from "./services/authoring.js";
import { CameraPresentationLive } from "./services/camera-presentation.js";
import { FixtureHealthLive, FixtureLauncherLive } from "./services/fixture-launcher.js";
import { WorkbenchGameTextLive } from "./services/game-text.js";
import { WorkbenchMapReviewLive } from "./services/map-review.js";
import { ShowcaseLive } from "./services/showcase.js";
import { WorkbenchConfiguration, WorkbenchConfigurationLive } from "./workbench-config.js";

export interface WorkbenchHosts {
	readonly app: ElectronAppHost;
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
		electronAppLayer(hosts.app),
		electronIpcLayer(hosts.ipc),
		workbenchWindowLayer(windowOptions),
		AssetReaderLive,
		RemoteControlClientLive,
		ReviewRepositoryLive,
		ReviewIdGeneratorLive,
		cameraFeedLayer(),
		LocalFilesLive,
		FixtureProcessLive
	).pipe(Layer.provideMerge(WorkbenchConfigurationLive));
}

/** Domain catalog and audit services that only need the base infrastructure. */
function domainCatalogLayer(hosts: WorkbenchHosts) {
	return Layer.mergeAll(
		ElectronDialogLive,
		TextureAuditLive,
		TextCorpusServiceLive,
		AuthoringCatalogLive
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
		ReviewCaptureLive.pipe(Layer.provide(reviewCapturePort)),
		FixtureLauncherLive.pipe(Layer.provide(FixtureHealthLive))
	).pipe(Layer.provideMerge(domainCatalogLayer(hosts)));
}

/** Workbench-owned application services surfaced directly to IPC registration. */
function featureLayer(hosts: WorkbenchHosts) {
	return Layer.mergeAll(
		ShowcaseLive,
		WorkbenchAssetAuditsLive,
		WorkbenchGameTextLive,
		WorkbenchAuthoringLive,
		WorkbenchMapReviewLive,
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
 */
export function WorkbenchLive(hosts: WorkbenchHosts) {
	return Layer.effectDiscard(registerWorkbenchIpc).pipe(Layer.provideMerge(featureLayer(hosts)));
}
