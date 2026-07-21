import * as stylex from "@stylexjs/stylex";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { observatoryActors, type ObservatoryActor, type ObservatoryFamily } from "./data.js";
import { WindowFrame } from "./WindowFrame.js";

const ORBIT_CENTER = { x: 150, y: 140 };
const PATH = { x0: 310, y0: 30, x1: 420, y1: 250 };
const WANDER_BOUNDS = { x0: 268, y0: 24, x1: 444, y1: 256 };

type Point = { readonly x: number; readonly y: number };

type WanderState = {
	x: number;
	y: number;
	targetX: number;
	targetY: number;
	rng: () => number;
};

type SimState = {
	t: number;
	wander: Map<string, WanderState>;
};

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function initSim(actors: readonly ObservatoryActor[]): SimState {
	const wander = new Map<string, WanderState>();
	for (const actor of actors) {
		if (actor.family !== "wander") {
			continue;
		}
		const rng = mulberry32(actor.seed);
		const pick = (min: number, max: number) => min + rng() * (max - min);
		wander.set(actor.id, {
			x: pick(WANDER_BOUNDS.x0, WANDER_BOUNDS.x1),
			y: pick(WANDER_BOUNDS.y0, WANDER_BOUNDS.y1),
			targetX: pick(WANDER_BOUNDS.x0, WANDER_BOUNDS.x1),
			targetY: pick(WANDER_BOUNDS.y0, WANDER_BOUNDS.y1),
			rng
		});
	}
	return { t: 0, wander };
}

function stepSim(
	state: SimState,
	actors: readonly ObservatoryActor[],
	dt: number
): Record<string, Point> {
	state.t += dt;
	const positions: Record<string, Point> = {};
	for (const actor of actors) {
		if (actor.family === "orbit") {
			const angle = actor.phase + state.t * actor.speed;
			positions[actor.id] = {
				x: ORBIT_CENTER.x + actor.radius * Math.cos(angle),
				y: ORBIT_CENTER.y + actor.radius * Math.sin(angle)
			};
		} else if (actor.family === "path") {
			const cycle = (state.t * actor.speed + actor.phase) % 2;
			const u = cycle < 1 ? cycle : 2 - cycle;
			positions[actor.id] = {
				x: PATH.x0 + (PATH.x1 - PATH.x0) * u,
				y: PATH.y0 + (PATH.y1 - PATH.y0) * u
			};
		} else {
			const w = state.wander.get(actor.id);
			if (!w) {
				continue;
			}
			const dx = w.targetX - w.x;
			const dy = w.targetY - w.y;
			const distance = Math.hypot(dx, dy);
			if (distance < 4) {
				const pick = (min: number, max: number) => min + w.rng() * (max - min);
				w.targetX = pick(WANDER_BOUNDS.x0, WANDER_BOUNDS.x1);
				w.targetY = pick(WANDER_BOUNDS.y0, WANDER_BOUNDS.y1);
			} else {
				const step = Math.min(actor.speed * dt, distance);
				w.x += (dx / distance) * step;
				w.y += (dy / distance) * step;
			}
			positions[actor.id] = { x: w.x, y: w.y };
		}
	}
	return positions;
}

const familyColors: Record<ObservatoryFamily, string> = {
	orbit: "#b7e26d",
	path: "#d6a363",
	wander: "#91c976"
};

export function ObservatoryMock() {
	const [positions, setPositions] = createSignal<Record<string, Point>>(
		stepSim(initSim(observatoryActors), observatoryActors, 0)
	);
	const [selected, setSelected] = createSignal<string | null>("Orbit_02");
	const [toast, setToast] = createSignal<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			return;
		}
		const state = initSim(observatoryActors);
		const interval = setInterval(() => {
			setPositions(stepSim(state, observatoryActors, 0.1));
		}, 100);
		onCleanup(() => clearInterval(interval));
	});

	onCleanup(() => {
		if (toastTimer !== undefined) {
			clearTimeout(toastTimer);
		}
	});

	const focusSelected = () => {
		const id = selected();
		if (!id) {
			return;
		}
		setToast(`focused ${id} in editor (simulated)`);
		if (toastTimer !== undefined) {
			clearTimeout(toastTimer);
		}
		toastTimer = setTimeout(() => setToast(null), 2400);
	};

	const positionOf = (id: string): Point => positions()[id] ?? { x: 0, y: 0 };

	return (
		<WindowFrame title="Actor Observatory — L_Observatory" badge="simulated stream">
			<div {...stylex.props(styles.toolbar)}>
				<span {...stylex.props(styles.chip)}>10 Hz · coalesced</span>
				<span {...stylex.props(styles.chip)}>{observatoryActors.length} actors</span>
				<span {...stylex.props(styles.chip)}>world: L_Observatory</span>
				<span {...stylex.props(styles.spacer)} />
				<button
					type="button"
					disabled={selected() === null}
					onClick={focusSelected}
					{...stylex.props(styles.focusButton)}
				>
					Focus in Unreal
				</button>
			</div>
			<div {...stylex.props(styles.body)}>
				<div {...stylex.props(styles.canvasWrap)}>
					<svg
						viewBox="0 0 460 280"
						role="img"
						aria-label="Simulated actor positions"
						{...stylex.props(styles.canvas)}
					>
						<rect width="460" height="280" fill="#0b0d0d" />
						<circle
							cx={ORBIT_CENTER.x}
							cy={ORBIT_CENTER.y}
							r="42"
							fill="none"
							stroke="#202720"
						/>
						<circle
							cx={ORBIT_CENTER.x}
							cy={ORBIT_CENTER.y}
							r="68"
							fill="none"
							stroke="#202720"
						/>
						<circle
							cx={ORBIT_CENTER.x}
							cy={ORBIT_CENTER.y}
							r="94"
							fill="none"
							stroke="#202720"
						/>
						<line
							x1={PATH.x0}
							y1={PATH.y0}
							x2={PATH.x1}
							y2={PATH.y1}
							stroke="#202720"
							stroke-dasharray="4 4"
						/>
						<rect
							x={WANDER_BOUNDS.x0}
							y={WANDER_BOUNDS.y0}
							width={WANDER_BOUNDS.x1 - WANDER_BOUNDS.x0}
							height={WANDER_BOUNDS.y1 - WANDER_BOUNDS.y0}
							fill="none"
							stroke="#202720"
							stroke-dasharray="3 5"
						/>
						<For each={observatoryActors}>
							{(actor) => {
								const pos = () => positionOf(actor.id);
								return (
									<g>
										<Show when={selected() === actor.id}>
											<circle
												cx={pos().x}
												cy={pos().y}
												r="10"
												fill="none"
												stroke={familyColors[actor.family]}
												stroke-opacity="0.4"
											/>
										</Show>
										<circle
											cx={pos().x}
											cy={pos().y}
											r="5"
											fill={familyColors[actor.family]}
											onClick={() => setSelected(actor.id)}
											style={{ cursor: "pointer" }}
										/>
									</g>
								);
							}}
						</For>
					</svg>
					<Show when={toast()}>
						<div {...stylex.props(styles.toast)}>{toast()}</div>
					</Show>
				</div>
				<div {...stylex.props(styles.list)}>
					<For each={observatoryActors}>
						{(actor) => (
							<button
								type="button"
								onClick={() => setSelected(actor.id)}
								{...stylex.props(
									styles.actorRow,
									selected() === actor.id && styles.actorRowSelected
								)}
							>
								<span {...stylex.props(styles.actorId)}>
									<span
										{...stylex.props(styles.familyDot)}
										style={{ "background-color": familyColors[actor.family] }}
									/>
									{actor.id}
								</span>
								<span {...stylex.props(styles.actorPos)}>
									({Math.round(positionOf(actor.id).x)},{" "}
									{Math.round(positionOf(actor.id).y)})
								</span>
							</button>
						)}
					</For>
				</div>
			</div>
			<div {...stylex.props(styles.footer)}>
				Positions stream over a bounded subscription with stable actor identity. Movement
				here is simulated in-page; the fixture map ships stationary, flying, and intermittent
				families.
			</div>
		</WindowFrame>
	);
}

const styles = stylex.create({
	toolbar: {
		alignItems: "center",
		backgroundColor: tokens.colorSurface,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		flexWrap: "wrap",
		gap: 8,
		padding: "8px 12px"
	},
	chip: {
		borderColor: tokens.colorBorderInteractive,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 9,
		letterSpacing: ".08em",
		padding: "3px 8px"
	},
	spacer: {
		flexGrow: 1
	},
	focusButton: {
		backgroundColor: {
			default: tokens.colorAccent,
			":hover:not(:disabled)": tokens.colorAccentStrong,
			":disabled": "transparent"
		},
		borderColor: tokens.colorAccent,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		color: {
			default: tokens.colorAccentText,
			":disabled": tokens.colorTextFaint
		},
		cursor: {
			default: "pointer",
			":disabled": "default"
		},
		fontFamily: tokens.fontBody,
		fontSize: 10,
		fontWeight: 700,
		letterSpacing: ".06em",
		padding: "4px 10px",
		textTransform: "uppercase"
	},
	body: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))"
	},
	canvasWrap: {
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		position: "relative"
	},
	canvas: {
		display: "block",
		height: "auto",
		width: "100%"
	},
	toast: {
		backgroundColor: tokens.colorSurfaceRaised,
		borderColor: tokens.colorAccent,
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		bottom: 12,
		color: tokens.colorAccent,
		fontSize: 10,
		left: "50%",
		letterSpacing: ".06em",
		padding: "6px 12px",
		position: "absolute",
		transform: "translateX(-50%)",
		whiteSpace: "nowrap"
	},
	list: {
		display: "flex",
		flexDirection: "column",
		maxHeight: 280,
		overflowY: "auto"
	},
	actorRow: {
		alignItems: "center",
		backgroundColor: {
			default: "transparent",
			":hover": tokens.colorSurfaceHover
		},
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		borderLeftColor: "transparent",
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		borderRightWidth: 0,
		borderTopWidth: 0,
		color: tokens.colorText,
		cursor: "pointer",
		display: "flex",
		fontFamily: tokens.fontBody,
		fontSize: 11,
		justifyContent: "space-between",
		padding: "8px 12px"
	},
	actorRowSelected: {
		backgroundColor: tokens.colorSurface,
		borderLeftColor: tokens.colorAccent
	},
	actorId: {
		alignItems: "center",
		color: tokens.colorTextStrong,
		display: "flex",
		gap: 8
	},
	familyDot: {
		borderRadius: "50%",
		height: 7,
		width: 7
	},
	actorPos: {
		color: tokens.colorTextMuted,
		fontVariantNumeric: "tabular-nums"
	},
	footer: {
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextFaint,
		fontSize: 10,
		padding: "8px 12px"
	}
});
