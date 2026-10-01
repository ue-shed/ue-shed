import * as stylex from "@stylexjs/stylex";
import { Button, createEffectAction } from "@ue-shed/ui";
import type { JSX } from "@solidjs/web";
import type { Effect } from "effect";
import { For, Show, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type {
	BlueprintAssetCandidate,
	BlueprintAssetSearchRequest,
	BlueprintAssetSearchResult
} from "./contract.js";
import type {
	BlueprintGraphOpenerControls,
	BlueprintGraphReadEffect
} from "./blueprint-graph-viewer.js";
import { styles } from "./blueprint-graph-styles.js";

export interface ProjectBlueprintSearchProps {
	readonly controls: BlueprintGraphOpenerControls;
	readonly searchBlueprints: (
		request: BlueprintAssetSearchRequest
	) => Effect.Effect<BlueprintAssetSearchResult, unknown>;
	readonly readBlueprint: (path: string) => BlueprintGraphReadEffect;
	readonly noProjectHint?: string;
}

type ReadyBlueprintSearch = Extract<BlueprintAssetSearchResult, { readonly status: "ready" }>;

type IndexedBlueprintState =
	| { readonly status: "loading" }
	| { readonly status: "transport_failed" }
	| { readonly result: ReadyBlueprintSearch; readonly status: "ready" | "updating" }
	| Exclude<BlueprintAssetSearchResult, { readonly status: "ready" }>;

function plural(count: number, noun: string): string {
	return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

export function ProjectBlueprintSearch(props: ProjectBlueprintSearchProps) {
	// Capture host operations during setup so callbacks cannot materialize lazy prop memos.
	const searchBlueprints = props.searchBlueprints;
	const readBlueprint = props.readBlueprint;
	const indexAction = createEffectAction();
	const [assetQuery, setAssetQuery] = createSignal("");
	const [pickerOpen, setPickerOpen] = createSignal(false);
	const [indexedBlueprints, setIndexedBlueprints] = createSignal<IndexedBlueprintState>({
		status: "loading"
	});
	let openerInput: HTMLInputElement | undefined;
	let resultList: HTMLElement | undefined;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	const indexedResult = createMemo(() => {
		const state = indexedBlueprints();
		return state.status === "ready" || state.status === "updating" ? state.result : undefined;
	});
	const indexBusy = createMemo(() =>
		["loading", "updating"].includes(indexedBlueprints().status)
	);
	props.controls.observeSourceBusy(indexBusy);
	const pickerVisible = () => props.controls.hasBlueprint && pickerOpen();

	const requestBlueprints = (query: string) => {
		setIndexedBlueprints((current) =>
			current.status === "ready" || current.status === "updating"
				? { result: current.result, status: "updating" }
				: { status: "loading" }
		);
		indexAction.run(searchBlueprints({ query }), {
			onFailure: () => {
				setIndexedBlueprints({ status: "transport_failed" });
			},
			onSuccess: (next) => {
				setIndexedBlueprints(
					next.status === "ready" ? { result: next, status: "ready" } : next
				);
			}
		});
	};
	const updateAssetQuery = (query: string) => {
		setAssetQuery(query);
		setPickerOpen(true);
		if (searchTimer !== undefined) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => requestBlueprints(query), 120);
	};
	const openIndexedBlueprint = (asset: BlueprintAssetCandidate) => {
		setPickerOpen(false);
		props.controls.open(readBlueprint(asset.assetPath));
		if (assetQuery() === "") return;
		// The next search starts from the whole project again, like the other showcase pickers.
		if (searchTimer !== undefined) clearTimeout(searchTimer);
		setAssetQuery("");
		requestBlueprints("");
	};
	const searchKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter") {
			const first = indexedResult()?.assets[0];
			if (first === undefined || indexedBlueprints().status === "updating") return;
			event.preventDefault();
			openIndexedBlueprint(first);
			return;
		}
		if (event.key === "ArrowDown") {
			const first = resultList?.querySelector<HTMLButtonElement>("button[data-result]");
			if (first === undefined || first === null) return;
			event.preventDefault();
			setPickerOpen(true);
			first.focus();
			return;
		}
		if (event.key !== "Escape") return;
		if (pickerVisible()) {
			event.preventDefault();
			setPickerOpen(false);
			return;
		}
		if (assetQuery() !== "") {
			event.preventDefault();
			updateAssetQuery("");
			setPickerOpen(false);
		}
	};
	const resultKeyDown = (event: KeyboardEvent & { readonly currentTarget: HTMLElement }) => {
		if (event.key === "Escape") {
			event.preventDefault();
			setPickerOpen(false);
			openerInput?.focus();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const items = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-result]")
		];
		const current = items.findIndex((item) => item === document.activeElement);
		const next = event.key === "ArrowDown" ? current + 1 : current - 1;
		if (next < 0) openerInput?.focus();
		else items[Math.min(next, items.length - 1)]?.focus();
	};
	const closeWhenFocusLeaves =
		(close: () => void) => (event: FocusEvent & { readonly currentTarget: HTMLElement }) => {
			if (!(event.relatedTarget instanceof Node)) return close();
			if (!event.currentTarget.contains(event.relatedTarget)) close();
		};
	onSettled(() => requestBlueprints(""));
	onCleanup(() => {
		if (searchTimer !== undefined) clearTimeout(searchTimer);
	});

	const browser = (variant: "inline" | "menu") => (
		<AssetBrowser
			noProjectHint={props.noProjectHint ?? "Choose a project to search its Blueprints."}
			listRef={(element) => {
				resultList = element;
			}}
			onKeyDown={resultKeyDown}
			onOpen={openIndexedBlueprint}
			onRetry={() => requestBlueprints(assetQuery())}
			query={assetQuery()}
			search={variant === "inline" ? searchField() : undefined}
			state={indexedBlueprints()}
			variant={variant}
		/>
	);
	// One project search, placed beside whichever title it navigates from.
	const searchField = () => (
		<Show when={indexedResult()}>
			{(catalog) => (
				<div
					onFocusOut={closeWhenFocusLeaves(() => setPickerOpen(false))}
					{...stylex.attrs(styles.searchWrap)}
				>
					<label role="search" {...stylex.attrs(styles.searchField)}>
						<span aria-hidden="true" {...stylex.attrs(styles.searchGlyph)}>
							⌕
						</span>
						<input
							aria-label="Search project Blueprints"
							autocomplete="off"
							onFocus={() => setPickerOpen(true)}
							onInput={(event) => updateAssetQuery(event.currentTarget.value)}
							onKeyDown={searchKeyDown}
							placeholder={`Search ${catalog().projectName} Blueprints`}
							ref={(element) => {
								openerInput = element;
							}}
							spellcheck={false}
							type="search"
							value={assetQuery()}
							{...stylex.attrs(styles.searchInput)}
						/>
						<Show when={indexBusy()}>
							<span
								aria-hidden="true"
								{...stylex.attrs(styles.spinner, styles.searchSpinner)}
							/>
						</Show>
					</label>
					<Show when={pickerVisible()}>
						<div {...stylex.attrs(styles.pickerMenu)}>{browser("menu")}</div>
					</Show>
				</div>
			)}
		</Show>
	);
	return (
		<Show when={props.controls.hasBlueprint} fallback={browser("inline")}>
			{searchField()}
		</Show>
	);
}

function AssetBrowser(props: {
	readonly noProjectHint: string;
	readonly listRef: (element: HTMLElement) => void;
	readonly onKeyDown: (event: KeyboardEvent & { readonly currentTarget: HTMLElement }) => void;
	readonly onOpen: (asset: BlueprintAssetCandidate) => void;
	readonly onRetry: () => void;
	readonly query: string;
	readonly search?: JSX.Element | undefined;
	readonly state: IndexedBlueprintState;
	readonly variant: "inline" | "menu";
}) {
	const catalog = () =>
		props.state.status === "ready" || props.state.status === "updating"
			? props.state.result
			: undefined;
	const failure = () => (props.state.status === "failed" ? props.state : undefined);
	const inline = createMemo(() => props.variant === "inline");
	return (
		<section
			aria-busy={props.state.status === "loading" ? "true" : "false"}
			aria-label="Indexed Blueprints"
			{...stylex.attrs(styles.browser, inline() && styles.browserInline)}
		>
			<Show when={props.state.status === "loading"}>
				<div aria-live="polite" role="status" {...stylex.attrs(styles.browserNote)}>
					<span {...stylex.attrs(styles.spinner)} />
					Loading the project's saved package index…
				</div>
			</Show>

			<Show when={props.state.status === "not_configured"}>
				<Show
					when={inline()}
					fallback={<p {...stylex.attrs(styles.browserNote)}>{props.noProjectHint}</p>}
				>
					<div {...stylex.attrs(styles.emptyState)}>
						<h2 {...stylex.attrs(styles.emptyTitle)}>No project selected</h2>
						<p {...stylex.attrs(styles.emptyText)}>
							{props.noProjectHint} Graphs are decoded from the saved packages; Unreal
							does not need to be running.
						</p>
					</div>
				</Show>
			</Show>

			<Show when={failure()}>
				{(value) => (
					<div role="alert" {...stylex.attrs(styles.browserNote, styles.browserError)}>
						<span {...stylex.attrs(styles.browserErrorCopy)}>
							<strong>{value().message}</strong>
							<span>{value().recovery}</span>
						</span>
						<Button onClick={() => props.onRetry()} type="button">
							Retry
						</Button>
					</div>
				)}
			</Show>

			<Show when={props.state.status === "transport_failed"}>
				<div role="alert" {...stylex.attrs(styles.browserNote, styles.browserError)}>
					<span {...stylex.attrs(styles.browserErrorCopy)}>
						<strong>The project index request could not be completed</strong>
						<span>Retry the request. Unreal does not need to be running.</span>
					</span>
					<Button onClick={() => props.onRetry()} type="button">
						Retry
					</Button>
				</div>
			</Show>

			<Show when={catalog()}>
				{(value) => (
					<>
						<Show when={inline()}>
							<header {...stylex.attrs(styles.browserHeader)}>
								<strong {...stylex.attrs(styles.browserTitle)}>
									Blueprints in {value().projectName}
								</strong>
								{props.search}
								<span {...stylex.attrs(styles.browserCount)}>
									{value().matchCount === value().assets.length
										? plural(value().matchCount, "Blueprint")
										: `${value().assets.length} of ${plural(value().matchCount, "Blueprint")}`}
								</span>
							</header>
						</Show>
						<Show
							when={value().assets.length > 0}
							fallback={
								<p {...stylex.attrs(styles.browserNote)}>
									No Blueprints match “{props.query}”. Try part of the name, a
									/Game path, or a Blueprint class.
								</p>
							}
						>
							<div
								aria-label="Blueprint search results"
								onKeyDown={(event) => props.onKeyDown(event)}
								ref={(element) => props.listRef(element)}
								{...stylex.attrs(styles.results, inline() && styles.resultsInline)}
							>
								<For each={value().assets}>
									{(asset) => (
										<button
											aria-label={`Open ${asset.assetName} from project index`}
											data-result=""
											onClick={() => props.onOpen(asset)}
											type="button"
											{...stylex.attrs(styles.result)}
										>
											<span {...stylex.attrs(styles.resultIdentity)}>
												<strong
													title={asset.assetName}
													{...stylex.attrs(styles.resultName)}
												>
													{asset.assetName}
												</strong>
												<small
													title={asset.packageName}
													{...stylex.attrs(styles.resultPackage)}
												>
													{asset.packageName}
												</small>
											</span>
											<span {...stylex.attrs(styles.chip)}>
												{asset.className}
											</span>
										</button>
									)}
								</For>
							</div>
						</Show>
						<Show when={!inline() && value().matchCount > value().assets.length}>
							<p {...stylex.attrs(styles.browserFooter)}>
								Showing {value().assets.length} of{" "}
								{value().matchCount.toLocaleString()} matches. Refine the search to
								narrow them.
							</p>
						</Show>
					</>
				)}
			</Show>
		</section>
	);
}
