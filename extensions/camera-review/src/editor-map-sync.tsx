import * as stylex from "@stylexjs/stylex";
import { savedMapPathToGameMapPath } from "@ue-shed/cameras/browser";
import { Button, createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Schedule, Stream } from "effect";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { MapReviewClientApi, MapReviewEditorState } from "./map-review-client.js";
import { MapSwitchDialog } from "./map-switch-dialog.js";

export function EditorMapSync(props: {
	readonly client: Pick<MapReviewClientApi, "editorWorld" | "openMapInUnreal">;
	readonly mapPath?: string | undefined;
	readonly onFollow: (mapPath: string) => void;
	readonly onState: (state: MapReviewEditorState) => void;
}) {
	const subscription = createEffectSubscription();
	const action = createEffectAction();
	const [state, setState] = createSignal<MapReviewEditorState>();
	const [switchMap, setSwitchMap] = createSignal<string>();
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const map = createMemo(() => {
		const current = state();
		return current?.status === "ready" ? current.world.snapshot.mapPath : undefined;
	});
	const target = () =>
		props.mapPath?.startsWith("/Game/")
			? props.mapPath
			: savedMapPathToGameMapPath(props.mapPath ?? "");
	const receive = (next: MapReviewEditorState) => {
		setState(next);
		props.onState(next);
	};
	onSettled(() => {
		const read = props.client.editorWorld;
		if (!read) return;
		subscription.subscribe(
			Stream.fromEffectSchedule(
				read().pipe(
					Effect.catch((cause) =>
						Effect.succeed({
							status: "unavailable" as const,
							message: Cause.pretty(Cause.fail(cause)),
							recovery:
								"Waiting for the editor to respond; the last known map is not treated as current."
						})
					)
				),
				Schedule.spaced("2 seconds")
			),
			{ onValue: receive }
		);
	});
	const confirm = () => {
		const path = switchMap();
		const open = props.client.openMapInUnreal;
		if (!open || !path || busy()) return;
		setBusy(true);
		setError(undefined);
		action.run(open(path), {
			onFailure: (cause) => {
				setBusy(false);
				setError(Cause.pretty(cause));
			},
			onSuccess: (result) => {
				setBusy(false);
				if (result.outcome === "failed" || result.outcome === "rejected")
					setError(`${result.message} ${result.recovery}`);
				else {
					setSwitchMap(undefined);
					if (props.client.editorWorld)
						action.run(props.client.editorWorld(), { onSuccess: receive });
				}
			}
		});
	};
	return (
		<Show when={props.client.editorWorld}>
			<section aria-label="Editor map connection" {...stylex.attrs(styles.panel)}>
				<Show
					when={map()}
					fallback={
						<span role="status">
							{state()?.status === "opening" || busy()
								? "Unreal is opening a map… Large maps can take several minutes."
								: "Checking editor map… Unreal may be busy or disconnected."}
						</span>
					}
				>
					{(current) => (
						<>
							<span>
								Open in Unreal: <code>{current()}</code>
							</span>
							<Show when={target() && target() !== current()}>
								<span>
									Saved map differs: <code>{target()}</code>
								</span>
								<div {...stylex.attrs(styles.actions)}>
									<Button
										disabled={busy()}
										onClick={() => props.onFollow(current())}
									>
										Follow editor map
									</Button>
									<Show when={props.client.openMapInUnreal}>
										<Button
											disabled={busy()}
											onClick={() => {
												setError(undefined);
												setSwitchMap(target());
											}}
										>
											Open saved map in Unreal
										</Button>
									</Show>
								</div>
							</Show>
						</>
					)}
				</Show>
				<Show when={state()?.status === "unavailable"}>
					{(() => {
						const current = state();
						return current?.status === "unavailable" ? (
							<small>
								{current.message} {current.recovery}
							</small>
						) : null;
					})()}
				</Show>
			</section>
			<Show when={switchMap()}>
				{(path) => (
					<MapSwitchDialog
						targetMap={path()}
						currentMap={map()}
						busy={busy()}
						error={error()}
						onConfirm={confirm}
						onCancel={() => setSwitchMap(undefined)}
					/>
				)}
			</Show>
		</Show>
	);
}

const styles = stylex.create({
	panel: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: "8px 16px",
		padding: "10px 12px",
		marginBottom: 12,
		backgroundColor: tokens.colorSurface,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		fontSize: 13,
		overflowWrap: "anywhere"
	},
	actions: { display: "flex", flexWrap: "wrap", gap: 8 }
});
