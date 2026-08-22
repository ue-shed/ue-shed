import * as stylex from "@stylexjs/stylex";
import type { MapTileKey, MapTilePyramidManifestValue } from "@ue-shed/cameras/map-tiles";
import type { SavedWorld, SavedWorldActor } from "@ue-shed/protocol";
import {
	ActorExplorer,
	actorExplorerMatches,
	createEffectAction,
	noActorExplorerFilters,
	type ActorExplorerFilters,
	type ActorExplorerItem
} from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, type Effect } from "effect";
import { Show, createMemo, createSignal } from "solid-js";
import type { MapCaptureActorCatalogResult, MapCaptureClientError } from "./map-capture-client.js";
import {
	MapTilePyramidViewer,
	type MapTileActorMarker,
	type MapTilePyramidViewerController
} from "./map-tile-viewer.js";

type ActorCatalogState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly message: string; readonly recovery: string; readonly status: "failed" }
	| { readonly status: "ready"; readonly world: SavedWorld };

function actorKey(actor: SavedWorldActor): string {
	return actor.actorGuid === undefined || /^0{8}-0{8}-0{8}-0{8}$/.test(actor.actorGuid)
		? `path:${actor.packageName}\u0000${actor.actorPath}`
		: `guid:${actor.actorGuid}`;
}

function shortClass(classPath: string): string {
	return classPath.split(/[./]/).filter(Boolean).at(-1) ?? classPath;
}

function actorLabel(actor: SavedWorldActor): string {
	return actor.label ?? actor.actorPath.split(".").at(-1) ?? actor.actorPath;
}

function isInsideCapture(
	actor: SavedWorldActor,
	bounds: MapTilePyramidManifestValue["grid"]["snappedBounds"]
): boolean {
	if (actor.transform.status !== "resolved") return false;
	const { x, y } = actor.transform.location;
	return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

export function MapCaptureActorWorkspace(props: {
	readonly loadActors: () => Effect.Effect<MapCaptureActorCatalogResult, MapCaptureClientError>;
	readonly loadTile: (
		key: MapTileKey,
		relativePath: string
	) => Effect.Effect<Uint8Array, unknown>;
	readonly manifest: MapTilePyramidManifestValue;
}) {
	const loadAction = createEffectAction();
	let viewer: MapTilePyramidViewerController | undefined;
	const [enabled, setEnabled] = createSignal(false);
	const [catalog, setCatalog] = createSignal<ActorCatalogState>({ status: "idle" });
	const [filters, setFilters] = createSignal<ActorExplorerFilters>(noActorExplorerFilters);
	const [selectedKey, setSelectedKey] = createSignal<string>();
	const readyWorld = createMemo(() => {
		const current = catalog();
		return current.status === "ready" ? current.world : undefined;
	});
	const failedCatalog = createMemo(() => {
		const current = catalog();
		return current.status === "failed" ? current : undefined;
	});
	const actors = createMemo(() => readyWorld()?.actors ?? []);
	const explorerItems = createMemo<readonly ActorExplorerItem[]>(() =>
		actors().map((actor) => {
			const resolved = actor.transform.status === "resolved";
			const inside = isInsideCapture(actor, props.manifest.grid.snappedBounds);
			return {
				badges: [
					...(resolved ? [] : ["UNRESOLVED"]),
					...(resolved && !inside ? ["OUTSIDE CAPTURE"] : [])
				],
				classLabel: shortClass(actor.classPath),
				classPath: actor.classPath,
				key: actorKey(actor),
				label: actorLabel(actor),
				packageName: actor.packageName,
				path: actor.actorPath,
				secondary: resolved
					? `${actor.transform.location.x.toLocaleString()}, ${actor.transform.location.y.toLocaleString()} UU`
					: actor.transform.status,
				searchFields: {
					class: actor.classPath,
					guid: actor.actorGuid,
					label: actor.label,
					package: actor.packageName,
					path: actor.actorPath
				}
			};
		})
	);
	const explorerItemsByKey = createMemo(
		() => new Map(explorerItems().map((item) => [item.key, item] as const))
	);
	const classOptions = createMemo(() => {
		const counts = new Map<string, number>();
		for (const actor of actors()) {
			counts.set(actor.classPath, (counts.get(actor.classPath) ?? 0) + 1);
		}
		return [...counts].map(([classPath, count]) => ({
			classPath,
			count,
			label: shortClass(classPath)
		}));
	});
	const markers = createMemo<readonly MapTileActorMarker[]>(() =>
		actors().flatMap((actor) => {
			if (actor.transform.status !== "resolved") return [];
			const item = explorerItemsByKey().get(actorKey(actor));
			if (item === undefined || !actorExplorerMatches(item, filters())) return [];
			return [
				{
					className: actor.classPath,
					key: actorKey(actor),
					label: actorLabel(actor),
					worldX: actor.transform.location.x,
					worldY: actor.transform.location.y
				}
			];
		})
	);
	const resolvedCount = createMemo(
		() => actors().filter((actor) => actor.transform.status === "resolved").length
	);
	const insideCount = createMemo(
		() =>
			actors().filter((actor) => isInsideCapture(actor, props.manifest.grid.snappedBounds))
				.length
	);

	function loadCatalog() {
		setCatalog({ status: "loading" });
		loadAction.run(props.loadActors(), {
			onFailure: (cause) =>
				setCatalog({
					message: Cause.pretty(cause),
					recovery: "Verify the selected project and saved map, then retry.",
					status: "failed"
				}),
			onSuccess: (result) => setCatalog(result)
		});
	}

	function toggleActors() {
		const next = !enabled();
		setEnabled(next);
		if (next && catalog().status === "idle") loadCatalog();
	}

	return (
		<section aria-label="Captured map actor workspace" {...stylex.props(styles.workspace)}>
			<header {...stylex.props(styles.toolbar)}>
				<div {...stylex.props(styles.toolbarCopy)}>
					<span>SAVED-WORLD INDEX</span>
					<strong>Actors over capture</strong>
				</div>
				<div {...stylex.props(styles.coverage)}>
					<Show
						when={catalog().status === "ready"}
						fallback={<span>LOADS ON DEMAND</span>}
					>
						<span>{insideCount().toLocaleString()} INSIDE CAPTURE</span>
						<span>{resolvedCount().toLocaleString()} RESOLVED</span>
						<span>{actors().length.toLocaleString()} SAVED</span>
					</Show>
				</div>
				<button
					type="button"
					aria-pressed={enabled()}
					onClick={toggleActors}
					{...stylex.props(styles.toggle, enabled() && styles.toggleEnabled)}
				>
					<i {...stylex.props(styles.toggleDot)} />
					SAVED ACTORS {enabled() ? "ON" : "OFF"}
				</button>
			</header>
			<Show when={enabled() && catalog().status === "loading"}>
				<div role="status" {...stylex.props(styles.catalogNotice)}>
					INDEXING SAVED ACTORS…
				</div>
			</Show>
			<Show when={enabled() ? failedCatalog() : undefined}>
				{(failed) => (
					<div
						role="alert"
						{...stylex.props(styles.catalogNotice, styles.catalogFailure)}
					>
						<div>
							<strong>SAVED ACTORS UNAVAILABLE</strong>
							<p>{failed().message}</p>
							<small>{failed().recovery}</small>
						</div>
						<button type="button" onClick={loadCatalog}>
							RETRY
						</button>
					</div>
				)}
			</Show>
			<Show when={enabled() && readyWorld()?.completeness === "partial"}>
				<div {...stylex.props(styles.catalogNotice, styles.catalogPartial)}>
					PARTIAL SAVED-WORLD COVERAGE · SOME ACTOR PACKAGES COULD NOT BE READ
				</div>
			</Show>
			<div
				{...stylex.props(
					styles.mapRow,
					enabled() && catalog().status === "ready" && styles.mapRowWithExplorer
				)}
			>
				<Show when={enabled() && catalog().status === "ready"}>
					<ActorExplorer
						ariaLabel="Captured map saved actor explorer"
						classOptions={classOptions()}
						classSelection="multiple"
						density="compact"
						filters={filters()}
						itemListLabel="Saved actors on captured map"
						items={explorerItems()}
						label="CAPTURE OVERLAY"
						onClassPathsChange={(classPaths) =>
							setFilters((current) => ({ ...current, classPaths }))
						}
						onFiltersChange={setFilters}
						onFocus={(key) => viewer?.focusActor(key)}
						onSelect={setSelectedKey}
						queryAriaLabel="Find captured map actor"
						role="complementary"
						selectedClassPath={undefined}
						selectedKey={selectedKey()}
						title="Saved actors"
					/>
				</Show>
				<MapTilePyramidViewer
					actorMarkers={enabled() ? markers() : []}
					manifest={props.manifest}
					onActorSelect={enabled() ? setSelectedKey : undefined}
					onController={(controller) => {
						viewer = controller;
					}}
					selectedActorKey={selectedKey()}
					loadTile={props.loadTile}
				/>
			</div>
		</section>
	);
}

const styles = stylex.create({
	workspace: {
		display: "grid",
		minWidth: 0,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface
	},
	toolbar: {
		display: "grid",
		gridTemplateColumns: "minmax(170px, 1fr) auto auto",
		alignItems: "center",
		gap: 20,
		padding: "10px 12px 10px 16px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundImage: "linear-gradient(90deg, #101112, #0c0d0e)",
		fontFamily: tokens.fontMono
	},
	toolbarCopy: {
		display: "flex",
		alignItems: "baseline",
		gap: 10,
		minWidth: 0,
		color: tokens.colorText
	},
	coverage: {
		display: "flex",
		gap: 13,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0
	},
	toggle: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusBadge,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		padding: "5px 12px",
		fontSize: 11,
		fontWeight: 500,
		letterSpacing: 0,
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	toggleEnabled: {
		borderColor: tokens.colorAccent,
		borderRadius: tokens.radiusBadge,
		backgroundColor: {
			default: "rgba(228, 242, 34, 0.08)",
			":hover": "rgba(228, 242, 34, 0.12)"
		},
		color: tokens.colorAccent
	},
	toggleDot: {
		width: 6,
		height: 6,
		borderRadius: 99,
		backgroundColor: "currentColor",
		boxShadow: "0 0 9px currentColor"
	},
	catalogNotice: {
		padding: "9px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorWarning,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		letterSpacing: 0
	},
	catalogFailure: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 18,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		color: tokens.colorDanger
	},
	catalogPartial: { backgroundColor: "rgba(242, 153, 74, 0.08)", color: tokens.colorWarning },
	mapRow: { display: "grid", minWidth: 0 },
	mapRowWithExplorer: {
		gridTemplateColumns: "minmax(230px, 300px) minmax(0, 1fr)",
		gap: 1,
		backgroundColor: tokens.colorBorder
	}
});
