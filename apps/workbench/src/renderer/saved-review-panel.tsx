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
			<details {...stylex.attrs(styles.section)}>
				<summary {...stylex.attrs(styles.summary)}>
					References · {references().length}
				</summary>
				<div {...stylex.attrs(styles.toolbar)}>
					<button type="button" onClick={loadInventory} {...stylex.attrs(styles.button)}>
						Load project references
					</button>
					<p role="status" {...stylex.attrs(styles.muted)}>
						{inventoryMessage()}
					</p>
				</div>
				<ul {...stylex.attrs(styles.list)}>
					<For each={references().slice(0, 200)}>
						{(reference) => {
							const resolution = createMemo(() =>
								resolveSavedReference(reference.targetPath, objectPath(), assets())
							);
							return (
								<li {...stylex.attrs(styles.reference)}>
									<small {...stylex.attrs(styles.muted, styles.referenceText)}>
										{reference.propertyPath}
									</small>
									<code {...stylex.attrs(styles.code, styles.referenceText)}>
										{reference.targetPath}
										{reference.targetRow ? ` · row ${reference.targetRow}` : ""}
									</code>
									<button
										type="button"
										{...stylex.attrs(styles.button, styles.referenceAction)}
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
					<p {...stylex.attrs(styles.muted)}>
						Showing the first 200 references. The CLI includes the full decoded
						inventory.
					</p>
				</Show>
			</details>
			<details {...stylex.attrs(styles.section)}>
				<summary {...stylex.attrs(styles.summary)}>Compare saved versions</summary>
				<form onSubmit={compare} {...stylex.attrs(styles.form)}>
					<label {...stylex.attrs(styles.field)}>
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
						<div aria-label="Saved changes" {...stylex.attrs(styles.changes)}>
							<p {...stylex.attrs(styles.muted)}>
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
		marginTop: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		fontSize: 12,
		overflow: "hidden"
	},
	section: {
		borderBottomWidth: { default: 1, ":last-child": 0 },
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		padding: "0 16px"
	},
	summary: {
		padding: "11px 0",
		color: { default: tokens.colorTextStrong, ":hover": tokens.colorAccent },
		cursor: "pointer",
		fontSize: 13,
		fontWeight: 510
	},
	toolbar: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
	muted: { margin: 0, color: tokens.colorTextMuted, fontSize: 12, lineHeight: 1.5 },
	code: { fontFamily: tokens.fontMono, fontSize: 11, color: tokens.colorText },
	field: { display: "grid", gap: 5, flex: "1 1 320px", color: tokens.colorTextMuted },
	form: {
		display: "flex",
		gap: 8,
		alignItems: "end",
		flexWrap: "wrap",
		padding: "4px 0 14px"
	},
	input: {
		display: "block",
		width: "100%",
		minWidth: 260,
		height: 34,
		padding: "0 10px",
		color: tokens.colorTextStrong,
		backgroundColor: tokens.colorSurfaceInset,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":focus": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		outline: "none",
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	button: {
		flexShrink: 0,
		height: 34,
		padding: "0 12px",
		borderRadius: tokens.radiusControl,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorBorderStrong },
		color: tokens.colorText,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		fontSize: 12,
		opacity: { default: 1, ":disabled": 0.45 },
		whiteSpace: "nowrap"
	},
	changes: { display: "grid", gap: 8, paddingBottom: 14 },
	list: { maxHeight: 360, margin: "8px 0 14px", overflow: "auto", padding: 0, listStyle: "none" },
	referenceText: { gridColumn: 1 },
	referenceAction: { gridColumn: 2, gridRow: "1 / span 2" },
	reference: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		alignItems: "center",
		gap: "2px 12px",
		padding: "7px 0",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		overflowWrap: "anywhere"
	},
	values: {
		margin: "6px 0 0",
		padding: "8px 10px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	}
});
