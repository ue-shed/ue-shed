import * as stylex from "@stylexjs/stylex";
import {
	FramingCandidateId,
	type FramingCandidateId as FramingCandidateIdType,
	FramingCandidateOverride,
	FramingCandidateOverrides,
	FramingGroup,
	FramingParameters
} from "@ue-shed/cameras";
import { For, Show } from "solid-js";
import { ScrubbableNumberField } from "./scrubbable-number-field.js";

const showcaseSliderMaximum = 24;

function replaceGroup(
	parameters: FramingParameters,
	groupId: FramingGroup["id"],
	update: (group: FramingGroup) => FramingGroup
): FramingParameters {
	return {
		...parameters,
		groups: parameters.groups.map((group) => (group.id === groupId ? update(group) : group))
	};
}

function parsedNumber(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function ParameterField(props: {
	readonly label: string;
	readonly max?: number;
	readonly min?: number;
	readonly onInput: (value: number) => void;
	readonly scrubStep?: number;
	readonly step?: number;
	readonly unit?: string;
	readonly value: number;
}) {
	return (
		<ScrubbableNumberField
			label={props.label}
			value={props.value}
			min={props.min}
			max={props.max}
			step={props.step}
			scrubStep={props.scrubStep}
			unit={props.unit}
			onValueChange={props.onInput}
		/>
	);
}

function CountField(props: {
	readonly count: number;
	readonly groupName: string;
	readonly onInput: (value: number) => void;
}) {
	return (
		<div {...stylex.props(styles.countField)}>
			<label {...stylex.props(styles.sliderLabel)}>
				<span>COUNT</span>
				<input
					type="range"
					min={1}
					max={showcaseSliderMaximum}
					step={1}
					value={Math.min(showcaseSliderMaximum, props.count)}
					aria-label={`${props.groupName} camera count`}
					onInput={(event) => props.onInput(Number(event.currentTarget.value))}
				/>
			</label>
			<input
				type="number"
				min={1}
				step={1}
				value={props.count}
				aria-label={`${props.groupName} exact camera count`}
				onInput={(event) => {
					const value = parsedNumber(event.currentTarget.value);
					if (value !== undefined && Number.isInteger(value) && value > 0) {
						props.onInput(value);
					}
				}}
				{...stylex.props(styles.countInput)}
			/>
		</div>
	);
}

export function FramingSettings(props: {
	readonly candidateOverrides: readonly FramingCandidateOverride[];
	readonly onCandidateOverridesChange: (overrides: readonly FramingCandidateOverride[]) => void;
	readonly onParametersChange: (parameters: FramingParameters) => void;
	readonly parameters: FramingParameters;
	readonly selectedCandidate?:
		| {
				readonly displayName: string;
				readonly id: string;
				readonly preset: string;
		  }
		| undefined;
}) {
	const requestedCount = () =>
		props.parameters.groups.reduce(
			(total, group) => total + (group.enabled ? group.pattern.count : 0),
			0
		);
	const selectedOverride = () =>
		props.candidateOverrides.find((entry) => entry.candidateId === props.selectedCandidate?.id)
			?.overrides;
	const setSelectedOverride = (next: FramingCandidateOverrides | undefined) => {
		if (props.selectedCandidate === undefined) return;
		const candidateId: FramingCandidateIdType = FramingCandidateId.make(
			props.selectedCandidate.id
		);
		const retained = props.candidateOverrides.filter(
			(entry) => entry.candidateId !== candidateId
		);
		props.onCandidateOverridesChange(
			next === undefined ? retained : [...retained, { candidateId, overrides: next }]
		);
	};
	const updateOverride = (field: keyof FramingCandidateOverrides, value: number | undefined) => {
		const next = { ...selectedOverride(), [field]: value };
		const compact = Object.fromEntries(
			Object.entries(next).filter((entry) => entry[1] !== undefined)
		) as FramingCandidateOverrides;
		setSelectedOverride(Object.keys(compact).length === 0 ? undefined : compact);
	};
	const selectedGroup = () =>
		props.parameters.groups.find((group) => group.id === props.selectedCandidate?.preset);
	const selectedYawOrigin = () => {
		const group = selectedGroup();
		return group?.pattern.kind === "arc" ? group.pattern.yawOffsetDegrees : 0;
	};

	return (
		<section {...stylex.props(styles.settings)}>
			<details>
				<summary {...stylex.props(styles.summary)}>
					<span>VIEW PRESETS + RIG</span>
					<small>{requestedCount()} GENERATED VIEWS · EDIT ALL</small>
				</summary>
				<div {...stylex.props(styles.settingsBody)}>
					<div {...stylex.props(styles.settingsIntro)}>
						<p {...stylex.props(styles.sectionHint)}>
							These controls regenerate the full contact sheet. Each enabled group is
							a preset that produces one or more views.
						</p>
						<span {...stylex.props(styles.scrubHint)}>
							↔ DRAG LABELS · SHIFT COARSE · ALT FINE
						</span>
					</div>
					<div {...stylex.props(styles.globalGrid)}>
						<ParameterField
							label="FIELD OF VIEW"
							min={5}
							max={170}
							scrubStep={0.25}
							unit="DEG"
							value={props.parameters.fieldOfViewDegrees}
							onInput={(fieldOfViewDegrees) =>
								props.onParametersChange({
									...props.parameters,
									fieldOfViewDegrees
								})
							}
						/>
						<ParameterField
							label="FRAME MARGIN"
							min={0}
							max={0.45}
							step={0.01}
							scrubStep={0.002}
							unit="RATIO"
							value={props.parameters.margin}
							onInput={(margin) =>
								props.onParametersChange({ ...props.parameters, margin })
							}
						/>
					</div>

					<div {...stylex.props(styles.groupList)}>
						<For each={props.parameters.groups}>
							{(group) => (
								<section {...stylex.props(styles.group)}>
									<header {...stylex.props(styles.groupHeader)}>
										<label {...stylex.props(styles.enableLabel)}>
											<input
												type="checkbox"
												checked={group.enabled}
												onChange={(event) =>
													props.onParametersChange(
														replaceGroup(
															props.parameters,
															group.id,
															(current) => ({
																...current,
																enabled: event.currentTarget.checked
															})
														)
													)
												}
											/>
											<strong>{group.displayName}</strong>
										</label>
										<code>{group.pattern.kind.toUpperCase()}</code>
									</header>
									<div {...stylex.props(styles.groupGrid)}>
										<CountField
											count={group.pattern.count}
											groupName={group.displayName}
											onInput={(count) =>
												props.onParametersChange(
													replaceGroup(
														props.parameters,
														group.id,
														(current) => ({
															...current,
															pattern: { ...current.pattern, count }
														})
													)
												)
											}
										/>
										<ParameterField
											label="DISTANCE"
											min={0.01}
											scrubStep={0.01}
											unit="SCALE"
											value={group.distanceScale}
											onInput={(distanceScale) =>
												props.onParametersChange(
													replaceGroup(
														props.parameters,
														group.id,
														(current) => ({
															...current,
															distanceScale
														})
													)
												)
											}
										/>
										<ParameterField
											label="ELEVATION"
											scrubStep={0.01}
											unit="OFFSET"
											value={group.elevation}
											onInput={(elevation) =>
												props.onParametersChange(
													replaceGroup(
														props.parameters,
														group.id,
														(current) => ({
															...current,
															elevation
														})
													)
												)
											}
										/>
										<Show
											when={
												group.pattern.kind === "arc"
													? group.pattern
													: undefined
											}
										>
											{(pattern) => (
												<>
													<ParameterField
														label="YAW"
														scrubStep={0.25}
														unit="DEG"
														value={pattern().yawOffsetDegrees}
														onInput={(yawOffsetDegrees) =>
															props.onParametersChange(
																replaceGroup(
																	props.parameters,
																	group.id,
																	(current) => ({
																		...current,
																		pattern:
																			current.pattern.kind ===
																			"arc"
																				? {
																						...current.pattern,
																						yawOffsetDegrees
																					}
																				: current.pattern
																	})
																)
															)
														}
													/>
													<ParameterField
														label="SPREAD"
														min={0}
														scrubStep={0.25}
														unit="DEG"
														value={pattern().spreadDegrees}
														onInput={(spreadDegrees) =>
															props.onParametersChange(
																replaceGroup(
																	props.parameters,
																	group.id,
																	(current) => ({
																		...current,
																		pattern:
																			current.pattern.kind ===
																			"arc"
																				? {
																						...current.pattern,
																						spreadDegrees
																					}
																				: current.pattern
																	})
																)
															)
														}
													/>
												</>
											)}
										</Show>
										<Show
											when={
												group.pattern.kind === "ring"
													? group.pattern
													: undefined
											}
										>
											{(pattern) => (
												<ParameterField
													label="RING OFFSET"
													scrubStep={0.25}
													unit="DEG"
													value={pattern().ringOffsetDegrees}
													onInput={(ringOffsetDegrees) =>
														props.onParametersChange(
															replaceGroup(
																props.parameters,
																group.id,
																(current) => ({
																	...current,
																	pattern:
																		current.pattern.kind ===
																		"ring"
																			? {
																					...current.pattern,
																					ringOffsetDegrees
																				}
																			: current.pattern
																})
															)
														)
													}
												/>
											)}
										</Show>
									</div>
								</section>
							)}
						</For>
					</div>

					<Show when={requestedCount() > showcaseSliderMaximum}>
						<p role="status" {...stylex.props(styles.performanceHint)}>
							Large rigs are valid. Live preview may take longer or fall back to
							individual captures; the durable definition is unchanged.
						</p>
					</Show>
				</div>
			</details>

			<div {...stylex.props(styles.overridePanel)}>
				<Show
					when={props.selectedCandidate}
					fallback={
						<p {...stylex.props(styles.sectionHint)}>
							Select a preview to tune only that view.
						</p>
					}
				>
					{(candidate) => (
						<>
							<header {...stylex.props(styles.overrideHeader)}>
								<div {...stylex.props(styles.overrideIdentity)}>
									<small>SELECTED VIEW · PER-VIEW OFFSETS</small>
									<strong>{candidate().displayName}</strong>
									<code>{candidate().preset.replaceAll("_", " ")}</code>
								</div>
								<button
									type="button"
									disabled={selectedOverride() === undefined}
									onClick={() => setSelectedOverride(undefined)}
									{...stylex.props(styles.resetButton)}
								>
									RESET OFFSETS
								</button>
							</header>
							<div {...stylex.props(styles.settingsIntro)}>
								<p {...stylex.props(styles.sectionHint)}>
									Blank values inherit the preset. Drag a label to opt in and tune
									this preview without regenerating the rest of the contact sheet.
								</p>
								<span {...stylex.props(styles.scrubHint)}>
									↔ DRAG LABELS · SHIFT COARSE · ALT FINE
								</span>
							</div>
							<div {...stylex.props(styles.overrideGrid)}>
								<section {...stylex.props(styles.overrideGroup)}>
									<header>COMPOSITION</header>
									<div {...stylex.props(styles.compositionFields)}>
										<ScrubbableNumberField
											label="DISTANCE SCALE"
											wide
											value={selectedOverride()?.distanceScale}
											scrubOrigin={selectedGroup()?.distanceScale ?? 1}
											scrubStep={0.01}
											min={0.01}
											placeholder="INHERIT"
											unit="SCALE"
											onValueChange={(value) =>
												updateOverride("distanceScale", value)
											}
											onClear={() =>
												updateOverride("distanceScale", undefined)
											}
										/>
										<ScrubbableNumberField
											label="ELEVATION OFFSET"
											value={selectedOverride()?.elevation}
											scrubOrigin={selectedGroup()?.elevation ?? 0}
											scrubStep={0.01}
											placeholder="INHERIT"
											unit="OFFSET"
											onValueChange={(value) =>
												updateOverride("elevation", value)
											}
											onClear={() => updateOverride("elevation", undefined)}
										/>
										<ScrubbableNumberField
											label="YAW OFFSET"
											value={selectedOverride()?.yawOffsetDegrees}
											scrubOrigin={selectedYawOrigin()}
											scrubStep={0.25}
											placeholder="INHERIT"
											unit="DEG"
											onValueChange={(value) =>
												updateOverride("yawOffsetDegrees", value)
											}
											onClear={() =>
												updateOverride("yawOffsetDegrees", undefined)
											}
										/>
									</div>
								</section>
								<section {...stylex.props(styles.overrideGroup)}>
									<header>OPTICS</header>
									<div {...stylex.props(styles.opticsFields)}>
										<ScrubbableNumberField
											label="FOV OVERRIDE"
											value={selectedOverride()?.fieldOfViewDegrees}
											scrubOrigin={props.parameters.fieldOfViewDegrees}
											scrubStep={0.25}
											min={5}
											max={170}
											placeholder="INHERIT"
											unit="DEG"
											onValueChange={(value) =>
												updateOverride("fieldOfViewDegrees", value)
											}
											onClear={() =>
												updateOverride("fieldOfViewDegrees", undefined)
											}
										/>
										<ScrubbableNumberField
											label="MARGIN OVERRIDE"
											value={selectedOverride()?.margin}
											scrubOrigin={props.parameters.margin}
											scrubStep={0.002}
											step={0.01}
											min={0}
											max={0.45}
											placeholder="INHERIT"
											unit="RATIO"
											onValueChange={(value) =>
												updateOverride("margin", value)
											}
											onClear={() => updateOverride("margin", undefined)}
										/>
									</div>
								</section>
							</div>
						</>
					)}
				</Show>
			</div>
		</section>
	);
}

const styles = stylex.create({
	settings: { marginTop: 10, border: "1px solid #39413c", backgroundColor: "#121613" },
	summary: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "10px 12px",
		color: "#d5ddd5",
		cursor: "pointer",
		fontSize: 10,
		fontWeight: 800,
		letterSpacing: ".12em"
	},
	settingsBody: { display: "grid", gap: 12, padding: "4px 12px 14px" },
	settingsIntro: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12
	},
	sectionHint: { margin: 0, color: "#89948c", fontSize: 9, lineHeight: 1.5 },
	scrubHint: {
		flexShrink: 0,
		color: "#8fa65d",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".08em"
	},
	globalGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(120px, 1fr))", gap: 8 },
	groupList: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 },
	group: { border: "1px solid #303832", backgroundColor: "#0b0e0c", padding: 10 },
	groupHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
	enableLabel: { display: "flex", alignItems: "center", gap: 7, color: "#dce2dc", fontSize: 10 },
	groupGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: 7,
		marginTop: 10
	},
	countField: { display: "grid", gridTemplateColumns: "1fr 52px", gap: 6, alignItems: "end" },
	sliderLabel: { display: "grid", gap: 5, color: "#89948c", fontSize: 8, letterSpacing: ".08em" },
	countInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #536056",
		backgroundColor: "#080a09",
		color: "#b9f227",
		padding: "6px 5px",
		textAlign: "right"
	},
	performanceHint: {
		margin: 0,
		borderLeft: "2px solid #d6a84c",
		padding: "8px 10px",
		color: "#c9b47c",
		backgroundColor: "#18150d",
		fontSize: 10
	},
	overridePanel: { display: "grid", gap: 9, borderTop: "1px solid #303832", padding: 12 },
	overrideHeader: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 12
	},
	overrideIdentity: { display: "grid", gap: 3 },
	resetButton: {
		border: "1px solid #526057",
		backgroundColor: { default: "transparent", ":hover": "#20271f" },
		color: "#b5beb6",
		padding: "7px 9px",
		fontSize: 8,
		fontWeight: 800,
		cursor: { default: "pointer", ":disabled": "default" },
		opacity: { default: 1, ":disabled": 0.4 }
	},
	overrideGrid: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(300px, 1.25fr) minmax(240px, .75fr)",
			"@media (max-width: 760px)": "1fr"
		},
		gap: 9,
		marginTop: 9
	},
	overrideGroup: {
		display: "grid",
		gap: 7,
		padding: 9,
		border: "1px solid #2d352f",
		backgroundColor: "#0d110e",
		color: "#7f8c83",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".11em"
	},
	compositionFields: {
		display: "grid",
		gridTemplateColumns: {
			default: "repeat(2, minmax(150px, 1fr))",
			"@media (max-width: 520px)": "1fr"
		},
		gap: 7
	},
	opticsFields: {
		display: "grid",
		gridTemplateColumns: "1fr",
		gap: 7
	}
});
