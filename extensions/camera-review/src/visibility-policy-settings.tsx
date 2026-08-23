import * as stylex from "@stylexjs/stylex";
import {
	ReviewSubjectActorPath,
	VisibilityPolicyId,
	type VisibilityOverrides,
	type VisibilityPolicy
} from "@ue-shed/cameras";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Schema } from "effect";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { MapReviewClientApi, MapReviewResult } from "./map-review-client.js";

type ReadyReview = Extract<MapReviewResult, { status: "ready" }>;
type AssessmentMethod = VisibilityPolicy["assessment"]["method"];
type LowAction = VisibilityPolicy["onLowVisibility"]["action"];
type OutputMode = "natural_only" | "natural_and_clear";
type PolicyNotice = {
	readonly technical?: string;
	readonly text: string;
	readonly tone: "error" | "success";
};

const decodeAssessmentMethod = Schema.decodeUnknownSync(
	Schema.Literals(["automatic", "depth_compare", "ray_samples", "subject_mask"])
);
const decodeLowAction = Schema.decodeUnknownSync(Schema.Literals(["record", "warn", "fail"]));
const decodeOutputMode = Schema.decodeUnknownSync(
	Schema.Literals(["natural_only", "natural_and_clear"])
);
const decodeClearStrategy = Schema.decodeUnknownSync(
	Schema.Literals(["isolate_target", "hide_explicit"])
);

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
	readonly client: MapReviewClientApi;
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
	const [message, setMessage] = createSignal<PolicyNotice>();

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
			setMessage({ text: "Visibility policy saved.", tone: "success" });
			return;
		}
		setMessage({
			text:
				result.status === "failed"
					? `${result.error.message} ${result.error.recovery}`
					: "The policy change could not be applied in the current review state.",
			tone: "error"
		});
	};

	const saveReplacement = () => {
		const view = selectedView();
		const current = view?.visibilityPolicy;
		if (!view || !current || props.client.replaceVisibilityPolicy === undefined) return;
		const boundedThreshold = Math.min(1, Math.max(0, Number(threshold()) || 0));
		const assessmentMethod = assessment();
		const policy: VisibilityPolicy = {
			assessment:
				assessmentMethod === "ray_samples"
					? { method: "ray_samples", samplePreset: "standard" }
					: { method: assessmentMethod },
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
				onFailure: (cause) =>
					setMessage({
						text: "Couldn't save the policy.",
						technical: Cause.pretty(cause),
						tone: "error"
					}),
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
				onFailure: (cause) =>
					setMessage({
						text: "Couldn't apply the policy.",
						technical: Cause.pretty(cause),
						tone: "error"
					}),
				onSuccess: applyResult
			}
		);
	};

	return (
		<section aria-label="Capture and visibility settings" {...stylex.props(styles.panel)}>
			<div {...stylex.props(styles.summary)}>
				<div {...stylex.props(styles.fact)}>
					<span>Profile</span>
					<strong>{selectedView()?.captureProfileId ?? "Project default"}</strong>
				</div>
				<div {...stylex.props(styles.fact)}>
					<span>Policy</span>
					<strong>{selectedView()?.visibilityPolicy?.name ?? "Project default"}</strong>
				</div>
				<label {...stylex.props(styles.viewPicker)}>
					<span>View</span>
					<select
						aria-label="View to configure"
						value={viewId()}
						onChange={(event) => setViewId(event.currentTarget.value)}
					>
						<For each={props.review.reviewSet.views}>
							{(view) => <option value={view.id}>{view.displayName}</option>}
						</For>
					</select>
				</label>
			</div>
			<details {...stylex.props(styles.advanced)}>
				<summary>Visibility settings</summary>
				<div {...stylex.props(styles.form)}>
					<label {...stylex.props(styles.field)}>
						Assessment method
						<select
							value={assessment()}
							onChange={(event) =>
								setAssessment(decodeAssessmentMethod(event.currentTarget.value))
							}
						>
							<option value="automatic">Automatic</option>
							<option value="depth_compare">Depth compare</option>
							<option value="ray_samples">Ray samples (diagnostic)</option>
							<option value="subject_mask">Subject mask</option>
						</select>
					</label>
					<label {...stylex.props(styles.field)}>
						Low visibility action
						<select
							value={lowAction()}
							onChange={(event) =>
								setLowAction(decodeLowAction(event.currentTarget.value))
							}
						>
							<option value="record">Record only</option>
							<option value="warn">Warn</option>
							<option value="fail">Fail the view</option>
						</select>
					</label>
					<label {...stylex.props(styles.field)}>
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
					<label {...stylex.props(styles.field)}>
						Output
						<select
							value={outputMode()}
							onChange={(event) =>
								setOutputMode(decodeOutputMode(event.currentTarget.value))
							}
						>
							<option value="natural_only">Natural only</option>
							<option value="natural_and_clear">Natural + clear</option>
						</select>
					</label>
					<Show when={outputMode() === "natural_and_clear"}>
						<label {...stylex.props(styles.field)}>
							Clear strategy
							<select
								value={strategy()}
								onChange={(event) =>
									setStrategy(decodeClearStrategy(event.currentTarget.value))
								}
							>
								<option value="isolate_target">Isolate target</option>
								<option value="hide_explicit">Hide listed objects</option>
								<option disabled>Detected occluders — unavailable</option>
							</select>
						</label>
					</Show>
					<label {...stylex.props(styles.field, styles.wide)}>
						Hide in clear — actor paths, one per line
						<textarea
							value={hideInClear()}
							onInput={(event) => setHideInClear(event.currentTarget.value)}
						/>
					</label>
					<label {...stylex.props(styles.field, styles.wide)}>
						Never hide — actor paths, one per line
						<textarea
							value={neverHide()}
							onInput={(event) => setNeverHide(event.currentTarget.value)}
						/>
					</label>
				</div>
				<p {...stylex.props(styles.note)}>
					Hiding detected occluders is not supported: depth evidence cannot safely
					identify which actor to change. Listed object paths stay reviewable and
					reversible.
				</p>
				<button type="button" onClick={saveReplacement} {...stylex.props(styles.primary)}>
					Save preset for this view
				</button>
				<fieldset {...stylex.props(styles.bulk)}>
					<legend>Apply current preset to other views</legend>
					<For each={props.review.reviewSet.views.filter((view) => view.id !== viewId())}>
						{(view) => (
							<label {...stylex.props(styles.bulkChoice)}>
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
								{...stylex.props(styles.quietButton)}
							>
								Review changes
							</button>
						}
					>
						<p {...stylex.props(styles.bulkTargets)}>
							Apply to: {bulkIds().join(", ")}
						</p>
						<button
							type="button"
							onClick={applyBulk}
							{...stylex.props(styles.quietButton)}
						>
							Apply
						</button>
						<button
							type="button"
							onClick={() => setConfirmBulk(false)}
							{...stylex.props(styles.quietButton)}
						>
							Cancel
						</button>
					</Show>
				</fieldset>
				<Show when={message()}>
					{(value) => (
						<p
							role={value().tone === "error" ? "alert" : "status"}
							{...stylex.props(
								styles.message,
								value().tone === "success" && styles.messageSuccess
							)}
						>
							{value().text}
							<Show when={value().technical}>
								{(technical) => (
									<details {...stylex.props(styles.technical)}>
										<summary>Technical details</summary>
										<code>{technical()}</code>
									</details>
								)}
							</Show>
						</p>
					)}
				</Show>
			</details>
		</section>
	);
}

const styles = stylex.create({
	panel: {
		marginTop: tokens.space3,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText
	},
	summary: {
		display: "grid",
		gridTemplateColumns: "1fr 1fr minmax(180px, .7fr)",
		gap: tokens.space4,
		alignItems: "end",
		padding: tokens.space3
	},
	fact: { display: "grid", gap: 4 },
	viewPicker: { display: "grid", gap: 4 },
	advanced: { borderTop: `1px solid ${tokens.colorBorder}`, padding: tokens.space3 },
	form: {
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: tokens.space3
	},
	field: {
		display: "grid",
		gap: 4,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	wide: { gridColumn: "1 / -1" },
	note: {
		margin: `${tokens.space3}px 0`,
		padding: `${tokens.space2}px ${tokens.space3}px`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.5
	},
	primary: {
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "6px 12px",
		fontSize: 13,
		fontWeight: 500,
		cursor: "pointer"
	},
	quietButton: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "5px 10px",
		fontSize: 12,
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "not-allowed" },
		opacity: { default: 1, ":disabled": 0.5 }
	},
	bulk: {
		display: "grid",
		justifyContent: "start",
		gap: tokens.space2,
		marginTop: tokens.space4,
		padding: tokens.space3,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl
	},
	bulkChoice: {
		display: "flex",
		alignItems: "center",
		gap: tokens.space2,
		fontSize: 13
	},
	bulkTargets: {
		margin: 0,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	message: {
		position: "relative",
		display: "grid",
		gap: tokens.space2,
		margin: `${tokens.space3}px 0 0`,
		padding: tokens.space3,
		borderColor: "rgba(235, 87, 87, 0.45)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		color: tokens.colorDanger,
		fontSize: 12,
		lineHeight: 1.5
	},
	messageSuccess: {
		borderColor: tokens.colorSuccess,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorText
	},
	technical: { color: tokens.colorTextSubtle, fontSize: 11 }
});
