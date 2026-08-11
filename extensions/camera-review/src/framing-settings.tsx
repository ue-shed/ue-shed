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
	readonly step?: number;
	readonly value: number;
}) {
	return (
		<label {...stylex.props(styles.parameterField)}>
			<span>{props.label}</span>
			<input
				type="number"
				value={props.value}
				min={props.min}
				max={props.max}
				step={props.step ?? 0.1}
				onInput={(event) => {
					const value = parsedNumber(event.currentTarget.value);
					if (value !== undefined) props.onInput(value);
				}}
				{...stylex.props(styles.numberInput)}
			/>
		</label>
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

	return (
		<section {...stylex.props(styles.settings)}>
			<details>
				<summary {...stylex.props(styles.summary)}>
					<span>VIEW PRESETS + RIG</span>
					<small>{requestedCount()} GENERATED VIEWS · EDIT ALL</small>
				</summary>
				<div {...stylex.props(styles.settingsBody)}>
					<p {...stylex.props(styles.sectionHint)}>
						These controls regenerate the full contact sheet. Each enabled group is a
						preset that produces one or more views.
					</p>
					<div {...stylex.props(styles.globalGrid)}>
						<ParameterField
							label="FIELD OF VIEW"
							min={5}
							max={170}
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
							<p {...stylex.props(styles.sectionHint)}>
								Blank values inherit the preset. Editing an offset updates this
								preview without regenerating the rest of the contact sheet.
							</p>
							<div {...stylex.props(styles.overrideGrid)}>
								<For
									each={
										[
											["DISTANCE SCALE", "distanceScale"],
											["ELEVATION OFFSET", "elevation"],
											["YAW OFFSET", "yawOffsetDegrees"],
											["FOV OVERRIDE", "fieldOfViewDegrees"],
											["MARGIN OVERRIDE", "margin"]
										] as const
									}
								>
									{([label, field]) => (
										<label {...stylex.props(styles.parameterField)}>
											<span>{label}</span>
											<input
												type="number"
												step="0.1"
												value={selectedOverride()?.[field] ?? ""}
												placeholder="INHERIT"
												onInput={(event) =>
													updateOverride(
														field,
														event.currentTarget.value === ""
															? undefined
															: parsedNumber(
																	event.currentTarget.value
																)
													)
												}
												{...stylex.props(styles.numberInput)}
											/>
										</label>
									)}
								</For>
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
	sectionHint: { margin: 0, color: "#89948c", fontSize: 9, lineHeight: 1.5 },
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
	parameterField: {
		display: "grid",
		gap: 4,
		color: "#89948c",
		fontSize: 8,
		letterSpacing: ".08em"
	},
	numberInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #424c44",
		backgroundColor: "#080a09",
		color: "#eef3ee",
		padding: "6px 7px"
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
		gridTemplateColumns: "repeat(5, minmax(80px, 1fr))",
		gap: 7,
		marginTop: 9
	}
});
