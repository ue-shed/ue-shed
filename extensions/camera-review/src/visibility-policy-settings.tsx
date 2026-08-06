import * as stylex from "@stylexjs/stylex";
import {
	ReviewSubjectActorPath,
	VisibilityPolicyId,
	type VisibilityOverrides,
	type VisibilityPolicy
} from "@ue-shed/cameras";
import { createEffectAction } from "@ue-shed/ui";
import { Cause } from "effect";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { MapReviewClientShape, MapReviewResult } from "./map-review-client.js";

type ReadyReview = Extract<MapReviewResult, { status: "ready" }>;
type AssessmentMethod = VisibilityPolicy["assessment"]["method"];
type LowAction = VisibilityPolicy["onLowVisibility"]["action"];
type OutputMode = "natural_only" | "natural_and_clear";

function locatorList(value: string) {
	return value
		.split("\n")
		.map((path) => path.trim())
		.filter((path) => path.length > 0)
		.map((actorPath) => ({
			actorPath: ReviewSubjectActorPath.make(actorPath),
			diagnosticLabel: actorPath,
			kind: "actor_path" as const
		}));
}

function pathList(overrides: VisibilityOverrides | undefined, field: keyof VisibilityOverrides) {
	return overrides?.[field].map((locator) => locator.actorPath).join("\n") ?? "";
}

export function VisibilityPolicySettings(props: {
	readonly client: MapReviewClientShape;
	readonly onUpdated: (review: ReadyReview) => void;
	readonly review: ReadyReview;
}) {
	const action = createEffectAction();
	const [viewId, setViewId] = createSignal(props.review.reviewSet.views[0]?.id ?? "");
	const selectedView = createMemo(() =>
		props.review.reviewSet.views.find((view) => view.id === viewId())
	);
	const [assessment, setAssessment] = createSignal<AssessmentMethod>("automatic");
	const [lowAction, setLowAction] = createSignal<LowAction>("record");
	const [threshold, setThreshold] = createSignal("0.5");
	const [outputMode, setOutputMode] = createSignal<OutputMode>("natural_only");
	const [strategy, setStrategy] = createSignal<"isolate_target" | "hide_explicit">(
		"isolate_target"
	);
	const [hideInClear, setHideInClear] = createSignal("");
	const [neverHide, setNeverHide] = createSignal("");
	const [bulkIds, setBulkIds] = createSignal<ReadonlyArray<string>>([]);
	const [confirmBulk, setConfirmBulk] = createSignal(false);
	const [message, setMessage] = createSignal<string>();

	createEffect(() => {
		const view = selectedView();
		const policy = view?.visibilityPolicy;
		if (!view || !policy) return;
		setAssessment(policy.assessment.method);
		setLowAction(policy.onLowVisibility.action);
		setThreshold(
			policy.onLowVisibility.action === "record"
				? "0.5"
				: String(policy.onLowVisibility.threshold)
		);
		setOutputMode(policy.output.mode);
		if (policy.output.mode === "natural_and_clear")
			setStrategy(policy.output.clearStrategy.type);
		setHideInClear(pathList(view.visibilityOverrides, "hideInClear"));
		setNeverHide(pathList(view.visibilityOverrides, "neverHide"));
		setBulkIds([]);
		setConfirmBulk(false);
	});

	const applyResult = (result: MapReviewResult) => {
		if (result.status === "ready") {
			props.onUpdated(result);
			setMessage("Visibility policy saved.");
			return;
		}
		setMessage(
			result.status === "failed"
				? `${result.error.message} ${result.error.recovery}`
				: "The policy change could not be applied in the current review state."
		);
	};

	const saveReplacement = () => {
		const view = selectedView();
		const current = view?.visibilityPolicy;
		if (!view || !current || props.client.replaceVisibilityPolicy === undefined) return;
		const boundedThreshold = Math.min(1, Math.max(0, Number(threshold()) || 0));
		const policy: VisibilityPolicy = {
			assessment:
				assessment() === "ray_samples"
					? { method: "ray_samples", samplePreset: "standard" }
					: ({ method: assessment() } as VisibilityPolicy["assessment"]),
			id: VisibilityPolicyId.make(`${current.id}-r${Date.now().toString(36)}`),
			name: `${current.name} revision`,
			onLowVisibility:
				lowAction() === "record"
					? { action: "record" }
					: { action: lowAction(), threshold: boundedThreshold },
			output:
				outputMode() === "natural_only"
					? { mode: "natural_only" }
					: { clearStrategy: { type: strategy() }, mode: "natural_and_clear" }
		};
		const visibilityOverrides = {
			hideInClear: locatorList(hideInClear()),
			neverHide: locatorList(neverHide())
		};
		setMessage(undefined);
		action.run(
			props.client.replaceVisibilityPolicy({ policy, viewId: view.id, visibilityOverrides }),
			{
				onFailure: (cause) => setMessage(Cause.pretty(cause)),
				onSuccess: applyResult
			}
		);
	};

	const applyBulk = () => {
		const policy = selectedView()?.visibilityPolicy;
		if (!policy || bulkIds().length === 0 || props.client.applyVisibilityPolicy === undefined)
			return;
		setMessage(undefined);
		action.run(
			props.client.applyVisibilityPolicy({ policyId: policy.id, viewIds: bulkIds() }),
			{
				onFailure: (cause) => setMessage(Cause.pretty(cause)),
				onSuccess: applyResult
			}
		);
	};

	return (
		<section aria-label="Capture and visibility settings" {...stylex.props(styles.panel)}>
			<div {...stylex.props(styles.summary)}>
				<div>
					<span>CAPTURE / VISIBILITY</span>
					<strong>{selectedView()?.captureProfileId ?? "Project default profile"}</strong>
				</div>
				<div>
					<span>POLICY</span>
					<strong>{selectedView()?.visibilityPolicy?.name ?? "Project default"}</strong>
				</div>
				<select value={viewId()} onChange={(event) => setViewId(event.currentTarget.value)}>
					<For each={props.review.reviewSet.views}>
						{(view) => <option value={view.id}>Configure: {view.displayName}</option>}
					</For>
				</select>
			</div>
			<details {...stylex.props(styles.advanced)}>
				<summary>Advanced visibility settings</summary>
				<div {...stylex.props(styles.form)}>
					<label>
						Assessment method
						<select
							value={assessment()}
							onChange={(event) =>
								setAssessment(event.currentTarget.value as AssessmentMethod)
							}
						>
							<option value="automatic">Automatic</option>
							<option value="depth_compare">Depth compare</option>
							<option value="ray_samples">Ray samples (diagnostic)</option>
							<option value="subject_mask">Subject mask</option>
						</select>
					</label>
					<label>
						Low visibility action
						<select
							value={lowAction()}
							onChange={(event) =>
								setLowAction(event.currentTarget.value as LowAction)
							}
						>
							<option value="record">Record</option>
							<option value="warn">Warn</option>
							<option value="fail">Fail</option>
						</select>
					</label>
					<label>
						Threshold (0–1)
						<input
							type="number"
							min="0"
							max="1"
							step="0.05"
							disabled={lowAction() === "record"}
							value={threshold()}
							onInput={(event) => setThreshold(event.currentTarget.value)}
						/>
					</label>
					<label>
						Output
						<select
							value={outputMode()}
							onChange={(event) =>
								setOutputMode(event.currentTarget.value as OutputMode)
							}
						>
							<option value="natural_only">Natural only</option>
							<option value="natural_and_clear">Natural + Clear</option>
						</select>
					</label>
					<Show when={outputMode() === "natural_and_clear"}>
						<label>
							Clear strategy
							<select
								value={strategy()}
								onChange={(event) =>
									setStrategy(
										event.currentTarget.value as
											| "isolate_target"
											| "hide_explicit"
									)
								}
							>
								<option value="isolate_target">Isolate target</option>
								<option value="hide_explicit">Hide explicit objects</option>
								<option disabled>Detected occluders — unsupported</option>
							</select>
						</label>
					</Show>
					<label {...stylex.props(styles.wide)}>
						Hide in Clear actor paths, one per line
						<textarea
							value={hideInClear()}
							onInput={(event) => setHideInClear(event.currentTarget.value)}
						/>
					</label>
					<label {...stylex.props(styles.wide)}>
						Never hide actor paths, one per line
						<textarea
							value={neverHide()}
							onInput={(event) => setNeverHide(event.currentTarget.value)}
						/>
					</label>
				</div>
				<p {...stylex.props(styles.note)}>
					Detected-occluder hiding is unavailable: render-truthful depth evidence cannot
					safely identify which actor to modify. Explicit object paths remain inspectable
					and reversible.
				</p>
				<button type="button" onClick={saveReplacement}>
					SAVE AS NEW PRESET FOR THIS VIEW
				</button>
				<fieldset {...stylex.props(styles.bulk)}>
					<legend>Apply current preset to other Views</legend>
					<For each={props.review.reviewSet.views.filter((view) => view.id !== viewId())}>
						{(view) => (
							<label>
								<input
									type="checkbox"
									checked={bulkIds().includes(view.id)}
									onChange={() =>
										setBulkIds((current) =>
											current.includes(view.id)
												? current.filter((id) => id !== view.id)
												: [...current, view.id]
										)
									}
								/>
								{view.displayName}
							</label>
						)}
					</For>
					<Show
						when={confirmBulk()}
						fallback={
							<button
								type="button"
								disabled={bulkIds().length === 0}
								onClick={() => setConfirmBulk(true)}
							>
								REVIEW BULK APPLY
							</button>
						}
					>
						<p>Apply to: {bulkIds().join(", ")}</p>
						<button type="button" onClick={applyBulk}>
							CONFIRM APPLY
						</button>
						<button type="button" onClick={() => setConfirmBulk(false)}>
							CANCEL
						</button>
					</Show>
				</fieldset>
				<Show when={message()}>{(value) => <p role="status">{value()}</p>}</Show>
			</details>
		</section>
	);
}

const styles = stylex.create({
	panel: { marginTop: 12, border: "1px solid #343a36", backgroundColor: "#111412" },
	summary: {
		display: "grid",
		gridTemplateColumns: "1fr 1fr minmax(180px, .7fr)",
		gap: 16,
		alignItems: "center",
		padding: 14
	},
	advanced: { borderTop: "1px solid #343a36", padding: 14 },
	form: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 },
	wide: { gridColumn: "1 / -1" },
	note: { color: "#9ab6b8", fontSize: 11, lineHeight: 1.6 },
	bulk: { display: "grid", gap: 8, marginTop: 16, border: "1px solid #343a36" }
});
