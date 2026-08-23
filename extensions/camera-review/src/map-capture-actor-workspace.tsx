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
					...(resolved ? [] : ["Unresolved"]),
					...(resolved && !inside ? ["Outside capture"] : [])
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
					<strong>Saved actors</strong>
					<span>Overlay the saved world on the captured tiles.</span>
				</div>
				<div {...stylex.props(styles.coverage)}>
					<Show
						when={catalog().status === "ready"}
						fallback={<span>Loads on demand</span>}
					>
						<span>{insideCount().toLocaleString()} inside</span>
						<span>{resolvedCount().toLocaleString()} resolved</span>
						<span>{actors().length.toLocaleString()} saved</span>
					</Show>
				</div>
				<button
					type="button"
					aria-pressed={enabled()}
					onClick={toggleActors}
					{...stylex.props(styles.toggle, enabled() && styles.toggleEnabled)}
				>
					<i {...stylex.props(styles.toggleDot)} />
					Saved actors {enabled() ? "on" : "off"}
				</button>
			</header>
			<Show when={enabled() && catalog().status === "loading"}>
				<div role="status" {...stylex.props(styles.catalogLoading)}>
					Indexing saved actors…
				</div>
			</Show>
			<Show when={enabled() ? failedCatalog() : undefined}>
				{(failed) => (
					<div role="alert" {...stylex.props(styles.catalogFailure)}>
						<div {...stylex.props(styles.failureCopy)}>
							<strong>Couldn&apos;t load saved actors</strong>
							<p>{failed().recovery}</p>
							<details {...stylex.props(styles.technical)}>
								<summary>Technical details</summary>
								<code>{failed().message}</code>
							</details>
						</div>
						<button
							type="button"
							onClick={loadCatalog}
							{...stylex.props(styles.retryButton)}
						>
							Retry
						</button>
					</div>
				)}
			</Show>
			<Show when={enabled() && readyWorld()?.completeness === "partial"}>
				<div {...stylex.props(styles.catalogPartial)}>
					Some actor packages could not be read, so this list may be incomplete.
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
						label="Capture overlay"
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
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	toolbar: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: tokens.space4,
		padding: `${tokens.space2}px ${tokens.space4}px`,
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	toolbarCopy: {
		display: "flex",
		alignItems: "baseline",
		gap: tokens.space2,
		minWidth: 0,
		color: tokens.colorTextStrong,
		fontSize: 13
	},
	coverage: {
		display: "flex",
		gap: tokens.space3,
		marginLeft: "auto",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontVariantNumeric: "tabular-nums"
	},
	toggle: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		padding: "4px 10px",
		fontSize: 12,
		fontWeight: 500,
		cursor: "pointer"
	},
	toggleEnabled: {
		borderColor: tokens.colorAccent,
		backgroundColor: { default: tokens.colorAccentWash, ":hover": tokens.colorAccentWash },
		color: tokens.colorAccent
	},
	toggleDot: {
		width: 6,
		height: 6,
		borderRadius: tokens.radiusPill,
		backgroundColor: "currentColor"
	},
	catalogLoading: {
		padding: `${tokens.space2}px ${tokens.space4}px`,
		textAlign: "center",
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	catalogFailure: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		alignItems: "start",
		gap: tokens.space3,
		margin: tokens.space3,
		padding: tokens.space3,
		border: `1px solid rgba(235, 87, 87, 0.45)`,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		color: tokens.colorDanger,
		fontSize: 12
	},
	failureCopy: { display: "grid", gap: tokens.space1 },
	retryButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "4px 12px",
		fontSize: 12,
		cursor: "pointer"
	},
	technical: {
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	catalogPartial: {
		padding: `${tokens.space2}px ${tokens.space4}px`,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorWarning,
		fontSize: 12
	},
	mapRow: { display: "grid", minWidth: 0 },
	mapRowWithExplorer: {
		gridTemplateColumns: "minmax(230px, 300px) minmax(0, 1fr)",
		gap: 1,
		backgroundColor: tokens.colorBorder
	}
});
