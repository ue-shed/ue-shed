import * as stylex from "@stylexjs/stylex";
import type { BlueprintGraphRead, LevelSequenceRead } from "@ue-shed/protocol";
import {
	blueprintReferences,
	sequenceReferences,
	compareSavedBlueprints,
	compareSavedSequences,
	resolveSavedReference,
	type SavedReviewAsset,
	type SavedReviewComparison
} from "@ue-shed/unreal-assets/saved-review";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect } from "effect";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { SavedReviewClient } from "./saved-review-client.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";

type Review =
	| { readonly kind: "blueprint"; readonly read: BlueprintGraphRead }
	| { readonly kind: "level_sequence"; readonly read: LevelSequenceRead };
export function SavedReviewPanel(props: {
	readonly review: Review;
	readonly client: SavedReviewClient;
	readonly blueprintClient: Pick<WorkbenchRendererClient, "readBlueprint">;
	readonly onOpen: (asset: SavedReviewAsset) => void;
	readonly onInternal: (path: string) => void;
}) {
	const action = createEffectAction();
	const inventoryAction = createEffectAction();
	const [baseline, setBaseline] = createSignal("");
	const [comparison, setComparison] = createSignal<{
		source: Review;
		value: SavedReviewComparison;
	}>();
	const [busy, setBusy] = createSignal(false);
	const [message, setMessage] = createSignal("");
	const [assets, setAssets] = createSignal<readonly SavedReviewAsset[]>([]);
	const [inventoryMessage, setInventoryMessage] = createSignal(
		"Load the project inventory to follow Blueprint and sequence references."
	);
	const references = createMemo(() =>
		props.review.kind === "blueprint"
			? blueprintReferences(props.review.read)
			: sequenceReferences(props.review.read)
	);
	const objectPath = () =>
		props.review.kind === "blueprint"
			? props.review.read.blueprint.object_path
			: props.review.read.sequence.object_path;
	const visibleComparison = createMemo(() =>
		comparison()?.source.read === props.review.read ? comparison()?.value : undefined
	);
	const loadInventory = () =>
		inventoryAction.run(props.client.inventory(), {
			onSuccess: (result) => {
				setAssets(result.status === "ready" ? result.assets : []);
				setInventoryMessage(
					result.status === "ready"
						? `${result.assets.length} Blueprint and sequence packages indexed.`
						: `${result.message} ${result.recovery}`
				);
			},
			onFailure: () =>
				setInventoryMessage(
					"Could not load the project inventory. Retry after choosing a project."
				)
		});
	const compare = (event: SubmitEvent) => {
		event.preventDefault();
		const source = props.review;
		const path = baseline().trim();
		if (!path) return;
		setBusy(true);
		setMessage("");
		setComparison(undefined);
		const effect =
			source.kind === "blueprint"
				? props.blueprintClient.readBlueprint(path).pipe(
						Effect.map((read) =>
							read.status === "ready"
								? { comparison: compareSavedBlueprints(read, source.read) }
								: {
										error:
											read.status === "failed"
												? `${read.message} ${read.recovery}`
												: "Baseline selection cancelled."
									}
						)
					)
				: props.client.readSequence(path).pipe(
						Effect.map((read) =>
							read.status === "ready"
								? { comparison: compareSavedSequences(read, source.read) }
								: {
										error:
											read.status === "failed"
												? `${read.message} ${read.recovery}`
												: "Baseline selection cancelled."
									}
						)
					);
		action.run(effect, {
			onSuccess: (result) => {
				setBusy(false);
				if (result.comparison) setComparison({ source, value: result.comparison });
				else setMessage(result.error ?? "Comparison unavailable.");
			},
			onFailure: () => {
				setBusy(false);
				setMessage("Baseline could not be read. Verify its path and retry.");
			}
		});
	};
	return (
		<section aria-label="Saved references and changes" {...stylex.attrs(styles.panel)}>
			<details>
				<summary>References · {references().length}</summary>
				<button type="button" onClick={loadInventory} {...stylex.attrs(styles.button)}>
					Load project references
				</button>
				<p role="status">{inventoryMessage()}</p>
				<ul {...stylex.attrs(styles.list)}>
					<For each={references().slice(0, 200)}>
						{(reference) => {
							const resolution = createMemo(() =>
								resolveSavedReference(reference.targetPath, objectPath(), assets())
							);
							return (
								<li {...stylex.attrs(styles.reference)}>
									<small>{reference.propertyPath}</small>
									<code>
										{reference.targetPath}
										{reference.targetRow ? ` · row ${reference.targetRow}` : ""}
									</code>
									<button
										type="button"
										{...stylex.attrs(styles.button)}
										disabled={
											!["resolved", "internal"].includes(resolution().status)
										}
										onClick={() => {
											const target = resolution();
											if (target.status === "internal")
												props.onInternal(target.targetPath);
											if (target.status === "resolved")
												props.onOpen(target.asset);
										}}
									>
										{resolution().status === "internal"
											? "Show in this asset"
											: resolution().status === "resolved"
												? "Open saved asset"
												: resolution().status === "native"
													? "Engine type"
													: resolution().status === "ambiguous"
														? "Ambiguous package"
														: "Outside loaded inventory"}
									</button>
								</li>
							);
						}}
					</For>
				</ul>
				<Show when={references().length > 200}>
					<p>
						Showing the first 200 references. The CLI includes the full decoded
						inventory.
					</p>
				</Show>
			</details>
			<details>
				<summary>Compare saved versions</summary>
				<form onSubmit={compare} {...stylex.attrs(styles.form)}>
					<label>
						Baseline asset path
						<input
							aria-label="Baseline asset path"
							{...stylex.attrs(styles.input)}
							value={baseline()}
							onInput={(event) => setBaseline(event.currentTarget.value)}
							placeholder="Path to an earlier .uasset"
						/>
					</label>
					<button
						type="submit"
						{...stylex.attrs(styles.button)}
						disabled={busy() || !baseline().trim()}
					>
						{busy() ? "Comparing…" : "Compare baseline"}
					</button>
				</form>
				<Show when={message()}>
					<p role="alert">{message()}</p>
				</Show>
				<Show when={visibleComparison()}>
					{(result) => (
						<div aria-label="Saved changes">
							<p>
								{result().changes.length === 0
									? "No changes in decoded evidence."
									: `${result().changes.length} saved changes.`}{" "}
								{result().outcome === "partial"
									? "Coverage is incomplete."
									: "Decoded comparison complete."}
							</p>
							<For each={result().warnings}>
								{(warning) => <p role="note">{warning}</p>}
							</For>
							<ol {...stylex.attrs(styles.list)}>
								<For each={result().changes.slice(0, 200)}>
									{(change) => (
										<li>
											<details>
												<summary>
													{change.kind} · {change.category} ·{" "}
													{decodeURIComponent(change.path)}
												</summary>
												<pre {...stylex.attrs(styles.values)}>
													{JSON.stringify(
														{
															before: change.before,
															after: change.after
														},
														null,
														2
													)}
												</pre>
											</details>
										</li>
									)}
								</For>
							</ol>
							<Show when={result().changes.length > 200}>
								<p>
									Showing the first 200 changes. Use the CLI to export all
									reported changes.
								</p>
							</Show>
						</div>
					)}
				</Show>
			</details>
		</section>
	);
}

const styles = stylex.create({
	panel: {
		display: "grid",
		gap: 16,
		padding: 16,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText,
		fontSize: 12
	},
	form: { display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap", marginTop: 12 },
	input: {
		display: "block",
		minWidth: 260,
		padding: 8,
		color: tokens.colorText,
		backgroundColor: tokens.colorSurface,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl
	},
	button: {
		padding: "7px 12px",
		borderRadius: tokens.radiusControl,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		color: tokens.colorText,
		backgroundColor: tokens.colorSurface,
		cursor: "pointer"
	},
	list: { maxHeight: 360, overflow: "auto", paddingLeft: 20 },
	reference: { display: "grid", gap: 6, padding: 8, overflowWrap: "anywhere" },
	values: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: tokens.fontMono }
});
