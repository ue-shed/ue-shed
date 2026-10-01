import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { createEffectAction } from "@ue-shed/ui";
import type { Effect } from "effect";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type {
	AssetInspectionReadResult,
	InspectedAsset,
	ReadyAssetInspection
} from "./contract.js";
import {
	AssetPanel,
	MetadataRecords,
	PackageHeaderPanel,
	assetMatches,
	inspectionClassPath,
	exportCount,
	shortObjectName
} from "./asset-panels.js";
import { styles } from "./styles.js";
import { countLabel } from "./count-label.js";

export type AssetInspectionReadEffect = Effect.Effect<AssetInspectionReadResult, unknown>;
export interface AssetInspectorControls {
	readonly open: (read: AssetInspectionReadEffect) => void;
	readonly loading: boolean;
	readonly hasInspection: boolean;
}
export type AssetRelatedView =
	| {
			readonly kind: "action";
			readonly label: string;
			readonly href: string;
			readonly description?: string;
			readonly onClick?: JSX.EventHandler<HTMLAnchorElement, MouseEvent>;
	  }
	| { readonly kind: "note"; readonly message: string };

export interface AssetInspectorProps {
	readonly opener: (controls: AssetInspectorControls) => JSX.Element;
	readonly initialRead?: AssetInspectionReadEffect | undefined;
	/** The host owns navigation and selection of specialized viewers. */
	readonly relatedViews?: (read: ReadyAssetInspection) => readonly AssetRelatedView[];
}

function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ExportNavigator(props: {
	readonly assets: readonly InspectedAsset[];
	readonly selectedPath: string | undefined;
	readonly onSelect: (path: string) => void;
}) {
	return (
		<div {...stylex.attrs(styles.navigatorPane)}>
			<div {...stylex.attrs(styles.mobileNavigator)}>
				<select
					aria-label="Choose an export"
					value={props.selectedPath ?? ""}
					onChange={(event) => props.onSelect(event.currentTarget.value)}
					{...stylex.attrs(styles.select)}
				>
					<For each={props.assets}>
						{(asset) => (
							<option value={asset.object_path}>
								{shortObjectName(asset.object_path)} ·{" "}
								{shortObjectName(inspectionClassPath(asset))}
							</option>
						)}
					</For>
				</select>
			</div>
			<nav aria-label="Exports" {...stylex.attrs(styles.navigator)}>
				<For each={props.assets}>
					{(asset) => (
						<button
							type="button"
							aria-pressed={
								props.selectedPath === asset.object_path ? "true" : "false"
							}
							onClick={() => props.onSelect(asset.object_path)}
							{...stylex.attrs(
								styles.exportButton,
								props.selectedPath === asset.object_path && styles.selectedExport
							)}
						>
							<span {...stylex.attrs(styles.exportIdentity)}>
								<span
									title={asset.object_path}
									{...stylex.attrs(styles.exportName)}
								>
									{shortObjectName(asset.object_path)}
								</span>
								<span
									title={inspectionClassPath(asset)}
									{...stylex.attrs(styles.exportClass, styles.truncate)}
								>
									{shortObjectName(inspectionClassPath(asset))}
								</span>
							</span>
							<span {...stylex.attrs(styles.count, styles.countBadge)}>
								{exportCount(asset)}
							</span>
						</button>
					)}
				</For>
			</nav>
		</div>
	);
}

export function AssetInspector(props: AssetInspectorProps) {
	const initialRead = props.initialRead;
	const action = createEffectAction();
	const [result, setResult] = createSignal<AssetInspectionReadResult>();
	const [loading, setLoading] = createSignal(false);
	const [transportFailure, setTransportFailure] = createSignal(false);
	const [query, setQuery] = createSignal("");
	const [selectedPath, setSelectedPath] = createSignal<string>();
	const ready = createMemo(() => {
		const value = result();
		return value?.status === "ready" ? value : undefined;
	});
	const failure = createMemo(() => {
		const value = result();
		return value?.status === "failed" ? value : undefined;
	});
	const normalizedQuery = createMemo(() => query().trim().toLowerCase());
	const primaryAsset = createMemo(() => {
		const inspection = ready()?.inspection;
		const packageName = inspection?.package.name ?? "";
		const objectPath = `${packageName}.${packageName.split("/").at(-1) ?? ""}`;
		return (
			inspection?.assets.find((asset) => asset.object_path === objectPath) ??
			inspection?.assets[0]
		);
	});
	const assets = createMemo(() => {
		const all = ready()?.inspection.assets ?? [];
		const primary = primaryAsset();
		const ordered =
			primary === undefined ? all : [primary, ...all.filter((item) => item !== primary)];
		return ordered.filter((asset) => assetMatches(asset, normalizedQuery()));
	});
	// Derive the fallback selection; filtering never writes state from an owned scope.
	const selected = createMemo(
		() => assets().find((asset) => asset.object_path === selectedPath()) ?? assets()[0]
	);
	const selectedAssets = createMemo(() => {
		const asset = selected();
		return asset === undefined ? [] : [asset];
	});
	const hasNavigator = createMemo(() => (ready()?.inspection.assets.length ?? 0) > 1);
	const relatedViews = createMemo(() => {
		const read = ready();
		return read === undefined ? [] : (props.relatedViews?.(read) ?? []);
	});
	const primaryClass = createMemo(() => inspectionClassPath(primaryAsset()));
	const coverageLabel = createMemo(() => {
		const inspection = ready()?.inspection;
		if (inspection === undefined) return "";
		return inspection.status === "ok" && inspection.decode_errors.length === 0
			? "Fully decoded"
			: `Partial · ${countLabel(inspection.decode_errors.length, "decode error")}`;
	});
	const stats = createMemo(() => {
		const read = ready();
		if (read === undefined) return "";
		const header = read.inspection.package;
		return [
			`UE4 ${header.version.ue4}`,
			`UE5 ${header.version.ue5}`,
			...(header.version.licensee === 0 ? [] : [`Licensee ${header.version.licensee}`]),
			fileSize(read.fileBytes),
			countLabel(header.names.count, "name"),
			countLabel(header.imports.count, "import"),
			countLabel(header.exports.count, "export"),
			countLabel(header.total_header_size, "header byte")
		].join(" · ");
	});
	const open = (read: AssetInspectionReadEffect) => {
		setLoading(true);
		setTransportFailure(false);
		action.run(read, {
			onFailure: () => {
				setLoading(false);
				setResult(undefined);
				setTransportFailure(true);
			},
			onSuccess: (value) => {
				setLoading(false);
				setResult(value);
				setQuery("");
				setSelectedPath(undefined);
			}
		});
	};
	const opener = props.opener({
		open,
		get loading() {
			return loading();
		},
		get hasInspection() {
			return ready() !== undefined;
		}
	});
	onSettled(() => {
		if (initialRead !== undefined) open(initialRead);
	});
	return (
		<main aria-busy={loading() ? "true" : "false"} {...stylex.attrs(styles.main)}>
			<header {...stylex.attrs(styles.header)}>
				<div>
					<h1 {...stylex.attrs(styles.title)}>Asset Inspector</h1>
					<p {...stylex.attrs(styles.intro)}>
						Drop any .uasset to explore its saved data locally in your browser.
					</p>
				</div>
				<span {...stylex.attrs(styles.scopeStamp)}>Read-only · no Unreal required</span>
			</header>
			<Show when={loading()}>
				<p role="status" {...stylex.attrs(styles.quiet)}>
					Reading saved package…
				</p>
			</Show>
			<Show when={transportFailure()}>
				<div role="alert" {...stylex.attrs(styles.alert)}>
					<strong>The browser decoder is unavailable</strong>
					<p>Reload and retry in a browser with WebAssembly and Web Worker support.</p>
				</div>
			</Show>
			<Show when={failure()}>
				{(value) => (
					<div role="alert" {...stylex.attrs(styles.alert)}>
						<strong>The saved package could not be read</strong>
						<p>{value().message}</p>
						<p>{value().recovery}</p>
					</div>
				)}
			</Show>
			<Show when={ready()} fallback={opener}>
				{(read) => (
					<>
						<section aria-label="Asset summary" {...stylex.attrs(styles.summary)}>
							<div {...stylex.attrs(styles.identity)}>
								<div
									title={read().inspection.package.name}
									{...stylex.attrs(styles.assetTitle, styles.truncate)}
								>
									{read().inspection.package.name.split("/").at(-1) ||
										read().fileName}
								</div>
								<div {...stylex.attrs(styles.stats)}>{stats()}</div>
							</div>
							<span title={primaryClass()} {...stylex.attrs(styles.classChip)}>
								{primaryClass().split(".").at(-1) || "Package"}
							</span>
							<span {...stylex.attrs(styles.chip)}>{coverageLabel()}</span>
							<For each={relatedViews()}>
								{(view) =>
									view.kind === "action" ? (
										<a
											href={view.href}
											aria-label={view.label}
											title={view.description}
											onClick={view.onClick}
											{...stylex.attrs(styles.viewAction)}
										>
											{view.label}
											<span aria-hidden="true">→</span>
										</a>
									) : (
										<span {...stylex.attrs(styles.quiet)}>{view.message}</span>
									)
								}
							</For>
							{opener}
						</section>
						<Show
							when={
								read().inspection.status === "partial" ||
								read().inspection.decode_errors.length > 0
							}
						>
							<aside aria-label="Decode coverage" {...stylex.attrs(styles.alert)}>
								<strong>
									Partial coverage ·{" "}
									{countLabel(
										read().inspection.decode_errors.length,
										"decode error"
									)}
								</strong>
								<p>
									Decoded exports are shown below. Some saved data could not be
									read.
								</p>
								<For each={read().inspection.decode_errors}>
									{(error) => (
										<details>
											<summary>
												{error.object_path} ·{" "}
												{error.kind.replaceAll("_", " ")}
											</summary>
											<p>{error.message}</p>
											<p {...stylex.attrs(styles.mono)}>{error.class_path}</p>
										</details>
									)}
								</For>
							</aside>
						</Show>
						<div {...stylex.attrs(styles.exportHeader)}>
							<h2 {...stylex.attrs(styles.exportTitle)}>
								Exports{" "}
								<span {...stylex.attrs(styles.count)}>{assets().length}</span>
							</h2>
							<input
								aria-label="Filter properties, values, and asset paths"
								type="search"
								placeholder="Filter properties and paths…"
								value={query()}
								onInput={(event) => setQuery(event.currentTarget.value)}
								{...stylex.attrs(styles.filter)}
							/>
						</div>
						<div
							{...stylex.attrs(styles.panes, hasNavigator() && styles.withNavigator)}
						>
							<Show when={hasNavigator()}>
								<ExportNavigator
									assets={assets()}
									selectedPath={selected()?.object_path}
									onSelect={setSelectedPath}
								/>
							</Show>
							<For
								each={selectedAssets()}
								fallback={
									<p {...stylex.attrs(styles.quiet)}>
										{normalizedQuery() === ""
											? "No decoded exports in this package."
											: "No matching decoded assets."}
									</p>
								}
							>
								{(asset) => <AssetPanel asset={asset} query={normalizedQuery()} />}
							</For>
						</div>
						<div {...stylex.attrs(styles.packageDetails)}>
							<PackageHeaderPanel header={read().inspection.package} />
							<Show when={read().inspection.metadata}>
								{(metadata) => (
									<details {...stylex.attrs(styles.disclosure)}>
										<summary>Package metadata</summary>
										<MetadataRecords
											records={{
												"Package root": metadata().root,
												...metadata().objects
											}}
										/>
									</details>
								)}
							</Show>
						</div>
					</>
				)}
			</Show>
		</main>
	);
}
