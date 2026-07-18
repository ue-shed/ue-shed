import * as stylex from "@stylexjs/stylex";
import {
	ActorId,
	projectActors,
	type ObservedActor,
	WorldScoutRefreshRate,
	type WorldScoutResult
} from "@ue-shed/observatory";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { MapReviewClientShape } from "./map-review-client.js";

const classColors = ["#b9f227", "#61d5df", "#f4a261", "#e76f8a", "#9a8cff", "#e9c46a"];

function colorForClass(className: string): string {
	let hash = 0;
	for (const character of className) hash = (hash * 31 + character.charCodeAt(0)) | 0;
	return classColors[Math.abs(hash) % classColors.length] ?? "#b9f227";
}

function formatCoordinate(value: number): string {
	return `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value)).toLocaleString()}`;
}

export function WorldScout(props: {
	readonly client: Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldSnapshots">;
	readonly onActorFocused: (actor: ObservedActor) => void;
}) {
	const subscription = createEffectSubscription();
	const connectAction = createEffectAction();
	const focusAction = createEffectAction();
	const followAction = createEffectAction();
	const [result, setResult] = createSignal<WorldScoutResult>();
	const [lastSnapshot, setLastSnapshot] =
		createSignal<Extract<WorldScoutResult, { readonly status: "ready" }>["snapshot"]>();
	const [refreshRate, setRefreshRate] = createSignal(WorldScoutRefreshRate.make(5));
	const [query, setQuery] = createSignal("");
	const [hiddenClasses, setHiddenClasses] = createSignal<ReadonlySet<string>>(new Set());
	const [selectedId, setSelectedId] = createSignal<ActorId>();
	const [following, setFollowing] = createSignal(false);
	const [navigationStatus, setNavigationStatus] = createSignal("SELECTED FOR REVIEW");
	const snapshot = createMemo(() => lastSnapshot());
	const connectionLabel = createMemo(() => {
		const current = result();
		if (current?.status === "ready") return current.snapshot.worldKind;
		return snapshot() === undefined ? "OFFLINE" : "RECONNECTING";
	});
	const sampleAge = createMemo(() => {
		const capturedAt = snapshot()?.capturedAt;
		if (capturedAt === undefined) return undefined;
		return Math.max(0, Date.now() - Date.parse(capturedAt));
	});
	const classes = createMemo(() => {
		const counts = new Map<string, number>();
		for (const actor of snapshot()?.actors ?? []) {
			counts.set(actor.className, (counts.get(actor.className) ?? 0) + 1);
		}
		return [...counts].toSorted(([left], [right]) => left.localeCompare(right));
	});
	const visibleActors = createMemo(() => {
		const normalized = query().trim().toLocaleLowerCase();
		return (snapshot()?.actors ?? []).filter(
			(actor) =>
				!hiddenClasses().has(actor.className) &&
				(!normalized ||
					actor.displayName.toLocaleLowerCase().includes(normalized) ||
					actor.className.toLocaleLowerCase().includes(normalized))
		);
	});
	const projection = createMemo(() => projectActors(visibleActors()));
	const selected = createMemo(() =>
		snapshot()?.actors.find((actor) => actor.id === selectedId())
	);
	const acceptResult = (current: WorldScoutResult) => {
		setResult(current);
		if (current.status === "ready") setLastSnapshot(current.snapshot);
	};

	const subscribe = (rate: WorldScoutRefreshRate) => {
		subscription.subscribe(props.client.worldSnapshots(rate), {
			onValue: (current) => {
				acceptResult(current);
				if (!following() || current.status !== "ready") return;
				const actor = current.snapshot.actors.find(
					(candidate) => candidate.id === selectedId()
				);
				if (!actor) {
					setFollowing(false);
					setNavigationStatus("ACTOR LEFT THE OBSERVED WORLD");
					return;
				}
				followAction.run(props.client.focusActor(actor.id, false), {
					onSuccess: (focus) => {
						if (focus.status !== "focused") {
							setFollowing(false);
							setNavigationStatus("FOLLOW UNAVAILABLE");
						}
					}
				});
			}
		});
	};

	onMount(() => subscribe(refreshRate()));

	const connect = () =>
		connectAction.run(props.client.connectWorld(), { onSuccess: acceptResult });
	const updateRefreshRate = (value: string) => {
		const parsed = Number(value);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) return;
		const next = WorldScoutRefreshRate.make(parsed);
		setRefreshRate(next);
		subscribe(next);
	};
	const toggleClass = (className: string) =>
		setHiddenClasses((current) => {
			const next = new Set(current);
			if (next.has(className)) next.delete(className);
			else next.add(className);
			return next;
		});
	const selectActor = (actor: ObservedActor) => {
		setSelectedId(actor.id);
		setFollowing(false);
		setNavigationStatus("SELECTED FOR REVIEW");
	};
	const goToActor = (actor: ObservedActor, follow: boolean) => {
		focusAction.run(props.client.focusActor(actor.id, true), {
			onSuccess: (focus) => {
				if (focus.status === "focused") {
					setFollowing(follow);
					setNavigationStatus(
						follow
							? "FOLLOWING IN UNREAL"
							: focus.authoringSubject === "selected"
								? "FOCUSED IN UNREAL"
								: "FOCUSED RUNTIME ACTOR"
					);
					if (focus.authoringSubject === "selected") props.onActorFocused(actor);
				} else {
					setFollowing(false);
					setNavigationStatus("FOCUS UNAVAILABLE");
				}
			}
		});
	};

	return (
		<section aria-label="Live top-down actor map" {...stylex.props(styles.scout)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>LIVE WORLD SCOUT / XY ORTHOGRAPHIC</p>
					<h2 {...stylex.props(styles.title)}>The level is the index.</h2>
				</div>
				<div {...stylex.props(styles.worldStatus)}>
					<span {...stylex.props(styles.liveDot)} />
					<strong>{connectionLabel()}</strong>
					<code {...stylex.props(styles.worldStatusCode)}>
						{snapshot()?.mapPath ?? "No observed world"}
					</code>
					<Show when={sampleAge()}>
						{(age) => (
							<small {...stylex.props(styles.sampleAge)}>
								{age() < 1_000
									? "LIVE SAMPLE"
									: `${(age() / 1_000).toFixed(1)}s OLD`}
							</small>
						)}
					</Show>
				</div>
			</header>

			<Show
				when={snapshot()}
				fallback={
					<div {...stylex.props(styles.offline)}>
						<div {...stylex.props(styles.offlineReticle)}>＋</div>
						<h3>Open a world to survey it.</h3>
						<p>
							Map Review needs the optional Observatory capability before it can place
							actors in world space.
						</p>
						<button
							type="button"
							onClick={connect}
							{...stylex.props(styles.connectButton)}
						>
							CONNECT LIVE WORLD
						</button>
						<Show when={result()?.status === "unavailable"}>
							{(() => {
								const current = result();
								return current?.status === "unavailable" ? (
									<small>{current.message}</small>
								) : null;
							})()}
						</Show>
					</div>
				}
			>
				<div {...stylex.props(styles.tools)}>
					<label {...stylex.props(styles.search)}>
						<span>FIND ACTOR</span>
						<input
							value={query()}
							onInput={(event) => setQuery(event.currentTarget.value)}
							placeholder="label or class"
							{...stylex.props(styles.searchInput)}
						/>
					</label>
					<div aria-label="Actor class filters" {...stylex.props(styles.classFilters)}>
						<For each={classes()}>
							{([className, count]) => (
								<button
									type="button"
									aria-pressed={!hiddenClasses().has(className)}
									onClick={() => toggleClass(className)}
									{...stylex.props(
										styles.classFilter,
										hiddenClasses().has(className) && styles.classHidden
									)}
								>
									<i
										{...stylex.props(styles.classSwatch)}
										style={{ "background-color": colorForClass(className) }}
									/>
									{className.replace(/^(BP_|A)/, "")} <b>{count}</b>
								</button>
							)}
						</For>
					</div>
					<div {...stylex.props(styles.sampleMeta)}>
						<strong>{visibleActors().length}</strong>
						<span>VISIBLE / {snapshot()?.actors.length ?? 0} OBSERVED</span>
					</div>
					<label {...stylex.props(styles.rateControl)}>
						<span>REFRESH RATE</span>
						<input
							type="range"
							aria-label="World refresh rate"
							min="1"
							max="30"
							step="1"
							value={refreshRate()}
							onInput={(event) => updateRefreshRate(event.currentTarget.value)}
							{...stylex.props(styles.rateSlider)}
						/>
						<strong>{refreshRate()} HZ</strong>
					</label>
				</div>

				<div {...stylex.props(styles.workspace)}>
					<div {...stylex.props(styles.mapFrame)}>
						<div {...stylex.props(styles.north)}>N ↑</div>
						<div {...stylex.props(styles.extentLabel)}>
							{Math.round(projection().width).toLocaleString()} ×{" "}
							{Math.round(projection().height).toLocaleString()} UU
						</div>
						<svg
							viewBox="0 0 100 100"
							preserveAspectRatio="xMidYMid meet"
							{...stylex.props(styles.map)}
						>
							<For each={projection().points}>
								{(point) => (
									<g
										role="button"
										tabindex="0"
										aria-label={`Select ${point.actor.displayName}`}
										onClick={() => selectActor(point.actor)}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ")
												selectActor(point.actor);
										}}
										{...stylex.props(styles.actorPoint)}
									>
										<circle
											cx={point.xPercent}
											cy={point.yPercent}
											r={selectedId() === point.actor.id ? 2.15 : 1.25}
											fill={colorForClass(point.actor.className)}
											stroke={
												selectedId() === point.actor.id
													? "#ffffff"
													: "#0a0d0b"
											}
											stroke-width={
												selectedId() === point.actor.id ? 0.65 : 0.35
											}
											vector-effect="non-scaling-stroke"
										/>
									</g>
								)}
							</For>
						</svg>
						<div {...stylex.props(styles.axisX)}>WORLD X →</div>
						<div {...stylex.props(styles.axisY)}>WORLD Y →</div>
					</div>

					<aside {...stylex.props(styles.inspector)}>
						<Show
							when={selected()}
							fallback={
								<div {...stylex.props(styles.noSelection)}>
									<span>SELECT A POINT</span>
									<p>
										Focus an actor in Unreal and generate transient review
										framing.
									</p>
								</div>
							}
						>
							{(actor) => (
								<div {...stylex.props(styles.actorDetails)}>
									<p>OBSERVED ACTOR</p>
									<h3 {...stylex.props(styles.actorDetailsHeading)}>
										{actor().displayName}
									</h3>
									<code>{actor().className}</code>
									<dl {...stylex.props(styles.coordinates)}>
										<div>
											<dt>X</dt>
											<dd>{formatCoordinate(actor().location.x)}</dd>
										</div>
										<div>
											<dt>Y</dt>
											<dd>{formatCoordinate(actor().location.y)}</dd>
										</div>
										<div>
											<dt>Z</dt>
											<dd>{formatCoordinate(actor().location.z)}</dd>
										</div>
									</dl>
									<div {...stylex.props(styles.actorActions)}>
										<button
											type="button"
											onClick={() => goToActor(actor(), false)}
											{...stylex.props(styles.goToButton)}
										>
											GO TO ACTOR ↗
										</button>
										<button
											type="button"
											aria-pressed={following()}
											onClick={() => {
												if (following()) {
													setFollowing(false);
													setNavigationStatus("FOLLOW STOPPED");
												} else goToActor(actor(), true);
											}}
											{...stylex.props(
												styles.followButton,
												following() && styles.followButtonActive
											)}
										>
											{following() ? "STOP FOLLOWING" : "FOLLOW ACTOR"}
										</button>
									</div>
									<span {...stylex.props(styles.focusedCopy)}>
										{navigationStatus()}
									</span>
								</div>
							)}
						</Show>
					</aside>
				</div>
			</Show>
		</section>
	);
}

const styles = stylex.create({
	scout: {
		minWidth: 0,
		maxWidth: "100%",
		border: "1px solid #384039",
		backgroundColor: "#0a0d0b",
		boxShadow: "inset 4px 0 #b9f227"
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "end",
		padding: "20px 22px",
		borderBottom: "1px solid #303632",
		minWidth: 0
	},
	eyebrow: { margin: "0 0 8px", color: "#89938c", fontSize: 9, letterSpacing: ".16em" },
	title: { margin: 0, fontFamily: "Georgia, serif", fontWeight: 400, fontSize: 28 },
	worldStatus: {
		display: "grid",
		gridTemplateColumns: "8px auto",
		gap: "3px 8px",
		alignItems: "center",
		textAlign: "right",
		fontSize: 8,
		minWidth: 0,
		maxWidth: "42vw"
	},
	liveDot: {
		width: 6,
		height: 6,
		borderRadius: "50%",
		backgroundColor: "#b9f227",
		boxShadow: "0 0 10px #b9f277"
	},
	worldStatusCode: {
		color: "#7d8780",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	sampleAge: { gridColumn: "2", color: "#657068", fontSize: 7, letterSpacing: ".1em" },
	offline: {
		minHeight: 410,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		textAlign: "center",
		backgroundImage:
			"linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px)",
		backgroundSize: "32px 32px"
	},
	offlineReticle: { color: "#b9f227", fontSize: 40 },
	connectButton: {
		marginTop: 14,
		border: "1px solid #b9f227",
		backgroundColor: { default: "#b9f227", ":hover": "#d4ff62" },
		color: "#11150d",
		padding: "11px 16px",
		fontWeight: 900,
		fontSize: 9,
		letterSpacing: ".1em",
		cursor: "pointer"
	},
	tools: {
		display: "grid",
		gap: 12,
		alignItems: "end",
		padding: "12px 14px",
		borderBottom: "1px solid #303632",
		backgroundColor: "#111512",
		minWidth: 0,
		gridTemplateColumns: {
			default: "220px minmax(0,1fr) 130px 150px",
			"@media (max-width: 1050px)": "minmax(170px, .7fr) minmax(0, 1.3fr) 100px 130px"
		}
	},
	search: { display: "grid", gap: 5, color: "#879188", fontSize: 8, letterSpacing: ".1em" },
	searchInput: {
		border: "1px solid #465048",
		backgroundColor: "#080a09",
		color: "#edf1ed",
		padding: "8px 9px"
	},
	classFilters: { display: "flex", gap: 6, overflowX: "auto", minWidth: 0 },
	classFilter: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		border: "1px solid #3c443e",
		backgroundColor: { default: "#171b18", ":hover": "#222923" },
		color: "#aab2ac",
		padding: "7px 9px",
		whiteSpace: "nowrap",
		fontSize: 8,
		cursor: "pointer"
	},
	classHidden: { opacity: 0.35 },
	classSwatch: { width: 6, height: 6, borderRadius: "50%" },
	sampleMeta: { display: "grid", textAlign: "right", color: "#7f8882", fontSize: 8 },
	rateControl: {
		display: "grid",
		gridTemplateColumns: "1fr auto",
		gap: "5px 10px",
		alignItems: "center",
		color: "#879188",
		fontSize: 8,
		letterSpacing: ".1em"
	},
	rateSlider: {
		gridColumn: "1 / -1",
		width: "100%",
		accentColor: "#b9f227",
		cursor: "ew-resize"
	},
	workspace: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0,1fr) minmax(240px, 280px)",
			"@media (max-width: 900px)": "minmax(0, 1fr)"
		},
		minHeight: 480,
		minWidth: 0
	},
	mapFrame: {
		position: "relative",
		minHeight: 480,
		overflow: "hidden",
		backgroundColor: "#0c100d",
		backgroundImage:
			"linear-gradient(#a7b2aa12 1px,transparent 1px),linear-gradient(90deg,#a7b2aa12 1px,transparent 1px),linear-gradient(#a7b2aa08 1px,transparent 1px),linear-gradient(90deg,#a7b2aa08 1px,transparent 1px)",
		backgroundSize: "80px 80px,80px 80px,16px 16px,16px 16px",
		minWidth: 0
	},
	map: {
		position: "absolute",
		inset: 28,
		width: "calc(100% - 56px)",
		height: "calc(100% - 56px)",
		overflow: "visible"
	},
	actorPoint: { cursor: "pointer", outline: { ":focus": "1px solid #fff" } },
	north: {
		position: "absolute",
		top: 12,
		left: 14,
		color: "#b9f227",
		fontSize: 9,
		letterSpacing: ".12em"
	},
	extentLabel: { position: "absolute", top: 12, right: 14, color: "#667069", fontSize: 8 },
	axisX: { position: "absolute", right: 12, bottom: 10, color: "#59625c", fontSize: 7 },
	axisY: {
		position: "absolute",
		left: 8,
		bottom: 46,
		color: "#59625c",
		fontSize: 7,
		transform: "rotate(-90deg)",
		transformOrigin: "left bottom"
	},
	inspector: {
		borderLeft: {
			default: "1px solid #303632",
			"@media (max-width: 900px)": 0
		},
		borderTop: {
			default: 0,
			"@media (max-width: 900px)": "1px solid #303632"
		},
		backgroundColor: "#111512",
		padding: 18,
		minWidth: 0
	},
	noSelection: { marginTop: 80, color: "#778078", textAlign: "center", fontSize: 9 },
	actorDetails: { display: "flex", flexDirection: "column", gap: 8 },
	actorDetailsHeading: { margin: 0, fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 400 },
	coordinates: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", marginTop: 18 },
	actorActions: { display: "grid", gap: 7, marginTop: 16 },
	goToButton: {
		border: "1px solid #b9f227",
		backgroundColor: { default: "#b9f227", ":hover": "#d4ff62" },
		color: "#10130c",
		padding: "11px 12px",
		fontSize: 9,
		fontWeight: 900,
		letterSpacing: ".1em",
		cursor: "pointer"
	},
	followButton: {
		border: "1px solid #566058",
		backgroundColor: { default: "transparent", ":hover": "#202721" },
		color: "#aeb7b0",
		padding: "10px 12px",
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".09em",
		cursor: "pointer"
	},
	followButtonActive: {
		borderColor: "#b9f227",
		backgroundColor: "#1c2612",
		color: "#b9f227"
	},
	focusedCopy: {
		marginTop: 16,
		borderTop: "1px solid #3c443e",
		paddingTop: 12,
		color: "#b9f227",
		fontSize: 8,
		letterSpacing: ".09em"
	}
});
