import * as stylex from "@stylexjs/stylex";
import { workbenchDarkTheme } from "@ue-shed/ui-theme/themes.stylex.js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createEffectAction } from "@ue-shed/ui";
import { AuthoringRoute } from "@ue-shed/extension-data-authoring";
import { GameTextRoute } from "@ue-shed/extension-game-text";
import { InputAtlasRoute } from "@ue-shed/extension-input-atlas";
import { TextureAuditRoute } from "@ue-shed/extension-asset-audits";
import { MapReviewRoute } from "@ue-shed/extension-camera-review";
import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { ShowcaseContext } from "../main/preload.js";
import { assetAuditsClient } from "./asset-audits-client.js";
import { authoringClient } from "./authoring-client.js";
import { gameTextClient } from "./game-text-client.js";
import { inputAtlasClient } from "./input-atlas-client.js";
import { mapReviewClient } from "./map-review-client.js";
import { CameraLab } from "./camera-lab.js";
import { workbenchRendererClient } from "./workbench-client.js";
import { EditorSessionTransport } from "./editor-session-transport.js";

const routes = [
	{ href: "#/", label: "Showcase", route: "#/" },
	{ href: "#/authoring", label: "Data Authoring", route: "#/authoring" },
	{ href: "#/game-text", label: "Game Text", route: "#/game-text" },
	{ href: "#/input-atlas", label: "Input Atlas", route: "#/input-atlas" },
	{ href: "#/asset-audits/textures", label: "Texture Audit", route: "#/asset-audits/textures" },
	{ href: "#/map-review", label: "Map Review", route: "#/map-review" },
	{ href: "#/camera-lab", label: "Camera Lab", route: "#/camera-lab" }
] as const;

type Route = (typeof routes)[number]["route"];

const demos = [
	{
		index: "01",
		kind: "HEADLESS · SAVED ASSETS",
		title: "DataTable Authoring",
		description:
			"Open typed DataTables without launching Unreal; draft cells, then apply and save live when connected.",
		capabilities: ["versioned snapshots", "typed drafts", "apply + save"],
		tone: "green" as const
	},
	{
		index: "02",
		kind: "WORKBENCH · SAVED ASSETS",
		title: "Texture Asset Audit",
		description:
			"Scan project textures for rule hits and open a finding with the asset evidence that triggered it.",
		capabilities: ["editor-free scan", "rule evidence", "partial diagnostics"],
		tone: "amber" as const
	},
	{
		index: "03",
		kind: "WORKBENCH · LIVE UNREAL",
		title: "Camera Load Lab",
		description:
			"Stress live camera feeds: change active count, resolution, and pipeline mode while watching latency.",
		capabilities: ["bounded frames", "pipeline isolation", "live telemetry"],
		tone: "blue" as const
	},
	{
		index: "04",
		kind: "HEADLESS · LANGUAGE CORPUS",
		title: "Game Text Workbench",
		description:
			"Search player-facing strings across DataTables, String Tables, and asset properties.",
		capabilities: ["identity-aware search", "occurrence evidence", "coverage gaps"],
		tone: "coral" as const
	}
] as const;

export function AppShell() {
	const routeFromLocation = (): Route => {
		const value = window.location.hash || "#/";
		return routes.some((route) => route.route === value) ? (value as Route) : "#/";
	};
	const [route, setRoute] = createSignal<Route>(routeFromLocation());
	onMount(() => {
		document.title = "UE Shed Workbench";
		if (!window.location.hash) window.location.hash = "/";
		const onHashChange = () => setRoute(routeFromLocation());
		window.addEventListener("hashchange", onHashChange);
		onCleanup(() => window.removeEventListener("hashchange", onHashChange));
	});
	return (
		<div {...stylex.props(workbenchDarkTheme, styles.app)}>
			<nav aria-label="Workbench" {...stylex.props(styles.nav)}>
				<a href="#/" {...stylex.props(styles.brand)}>
					<span {...stylex.props(styles.brandMark)}>UE</span>
					<span>SHED</span>
				</a>
				<div {...stylex.props(styles.links)}>
					<For each={routes}>
						{(item) => (
							<a
								href={item.href}
								aria-current={route() === item.route ? "page" : undefined}
								{...stylex.props(
									styles.link,
									route() === item.route && styles.linkActive
								)}
							>
								{item.label}
							</a>
						)}
					</For>
				</div>
				<EditorSessionTransport client={workbenchRendererClient} />
				<span {...stylex.props(styles.version)}>0.0.0</span>
			</nav>
			<Switch fallback={<ShowcaseHome />}>
				<Match when={route() === "#/authoring"}>
					<AuthoringRoute client={authoringClient} />
				</Match>
				<Match when={route() === "#/asset-audits/textures"}>
					<TextureAuditRoute client={assetAuditsClient} />
				</Match>
				<Match when={route() === "#/game-text"}>
					<GameTextRoute client={gameTextClient} />
				</Match>
				<Match when={route() === "#/input-atlas"}>
					<InputAtlasRoute client={inputAtlasClient} />
				</Match>
				<Match when={route() === "#/map-review"}>
					<MapReviewRoute client={mapReviewClient} />
				</Match>
				<Match when={route() === "#/camera-lab"}>
					<CameraLab />
				</Match>
			</Switch>
		</div>
	);
}

function ShowcaseHome() {
	const contextAction = createEffectAction();
	const statusAction = createEffectAction();
	const [context, setContext] = createSignal<ShowcaseContext>();
	const [cameraConnected, setCameraConnected] = createSignal(false);
	onMount(() => {
		contextAction.run(workbenchRendererClient.showcaseContext(), {
			onSuccess: setContext
		});
		statusAction.run(workbenchRendererClient.getStatus(), {
			onFailure: () => setCameraConnected(false),
			onSuccess: () => setCameraConnected(true)
		});
	});
	return (
		<main {...stylex.props(styles.home)}>
			<header {...stylex.props(styles.hero)}>
				<nav aria-label="Breadcrumb" {...stylex.props(styles.eyebrow)}>
					Showcase / Workbench
				</nav>
			</header>

			<section aria-label="Showcase readiness" {...stylex.props(styles.readiness)}>
				<Readiness
					label="Runtime health"
					ready={context()?.health.status === "healthy"}
					value={context()?.health.status ?? "loading"}
				/>
				<Readiness
					label="Fixture preset"
					ready={context()?.fixtureConfigured === true}
					value={context()?.fixtureConfigured ? "committed corpus" : "not configured"}
				/>
				<Readiness
					label="Saved-asset reader"
					ready={context()?.reader === "configured"}
					value={context()?.reader === "configured" ? "explicit path" : "using PATH"}
				/>
				<Readiness
					label="Live Unreal"
					ready={cameraConnected()}
					value={cameraConnected() ? "remote control online" : "optional · offline"}
				/>
			</section>

			<section aria-label="Demos" {...stylex.props(styles.demoGrid)}>
				<For each={demos}>
					{(demo) => (
						<article {...stylex.props(styles.demo, styles[demo.tone])}>
							<div {...stylex.props(styles.demoTop)}>
								<span {...stylex.props(styles.demoIndex)}>{demo.index}</span>
								<span {...stylex.props(styles.kind)}>{demo.kind}</span>
							</div>
							<h2 {...stylex.props(styles.demoTitle)}>{demo.title}</h2>
							<p {...stylex.props(styles.description)}>{demo.description}</p>
							<ul {...stylex.props(styles.capabilities)}>
								<For each={demo.capabilities}>{(item) => <li>{item}</li>}</For>
							</ul>
							<Show when={demo.index === "01"}>
								<a href="#/authoring" {...stylex.props(styles.action)}>
									OPEN TABLE <span>→</span>
								</a>
							</Show>
							<Show when={demo.index === "02"}>
								<a href="#/asset-audits/textures" {...stylex.props(styles.action)}>
									OPEN AUDIT <span>→</span>
								</a>
							</Show>
							<Show when={demo.index === "03"}>
								<a href="#/camera-lab" {...stylex.props(styles.action)}>
									OPEN LOAD LAB <span>→</span>
								</a>
							</Show>
							<Show when={demo.index === "04"}>
								<a href="#/game-text" {...stylex.props(styles.action)}>
									OPEN CORPUS <span>→</span>
								</a>
							</Show>
						</article>
					)}
				</For>
			</section>

			<footer {...stylex.props(styles.footer)}>
				<span>START HERE</span>
				<p>
					Saved-asset demos work from committed fixture content. Camera Lab joins when
					Unreal is ready.
				</p>
				<code>docs/showcase.md</code>
			</footer>
		</main>
	);
}

function Readiness(props: {
	readonly label: string;
	readonly ready: boolean;
	readonly value: string;
}) {
	return (
		<div {...stylex.props(styles.readinessItem)}>
			<span
				{...stylex.props(styles.statusDot, props.ready ? styles.ready : styles.optional)}
			/>
			<div>
				<small>{props.label}</small>
				<strong>{props.value}</strong>
			</div>
		</div>
	);
}

const styles = stylex.create({
	app: {
		minHeight: "100vh",
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	nav: {
		height: 52,
		display: "flex",
		alignItems: "center",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorCanvasTranslucent,
		position: "sticky",
		top: 0,
		zIndex: 20
	},
	brand: {
		height: "100%",
		display: "flex",
		alignItems: "center",
		gap: 10,
		padding: "0 24px",
		color: tokens.colorTextStrong,
		textDecoration: "none",
		fontWeight: 800,
		letterSpacing: "0.14em",
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1
	},
	brandMark: {
		color: tokens.colorCanvas,
		backgroundColor: tokens.colorAccent,
		padding: "4px 5px",
		letterSpacing: 0
	},
	links: { display: "flex", alignItems: "stretch", alignSelf: "stretch" },
	link: {
		display: "flex",
		alignItems: "center",
		padding: "0 18px",
		color: { default: tokens.colorTextSubtle, ":hover": tokens.colorText },
		textDecoration: "none",
		fontSize: 10,
		textTransform: "uppercase",
		letterSpacing: "0.08em",
		borderRight: "1px solid #252a27"
	},
	linkActive: {
		borderBottomColor: tokens.colorAccent,
		borderBottomStyle: "solid",
		borderBottomWidth: 2,
		color: tokens.colorText
	},
	version: {
		padding: "0 12px",
		color: "#4f5852",
		fontSize: 9,
		letterSpacing: "0.12em"
	},
	home: {
		minHeight: "calc(100vh - 52px)",
		padding: "44px 48px 28px",
		color: tokens.colorText,
		backgroundImage:
			"linear-gradient(90deg, transparent 49.8%, #ffffff08 50%, transparent 50.2%), radial-gradient(circle at 85% 3%, #b7e26d12, transparent 28%)"
	},
	hero: {
		display: "flex",
		alignItems: "center",
		minHeight: 32
	},
	eyebrow: { margin: 0, color: "#89938c", fontSize: 10, letterSpacing: "0.18em" },
	readiness: {
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		margin: "16px 0 18px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1
	},
	readinessItem: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		padding: "12px 16px",
		borderRight: "1px solid #303632"
	},
	statusDot: { width: 7, height: 7, borderRadius: "50%" },
	ready: { backgroundColor: "#8fcf71", boxShadow: "0 0 10px #8fcf7166" },
	optional: { backgroundColor: "#715f4c" },
	demoGrid: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 },
	demo: {
		minHeight: 350,
		padding: 22,
		border: "1px solid #343a36",
		display: "flex",
		flexDirection: "column",
		backgroundColor: tokens.colorSurface
	},
	green: { borderTop: "3px solid #91c976" },
	amber: { borderTop: "3px solid #d98f53" },
	blue: { borderTop: "3px solid #70a9b2" },
	coral: { borderTop: "3px solid #e76b49" },
	demoTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
	demoIndex: { fontFamily: "Georgia, serif", fontSize: 30, color: "#59615b" },
	kind: { color: "#79827c", fontSize: 9, letterSpacing: "0.12em" },
	demoTitle: {
		margin: "32px 0 12px",
		fontFamily: "Georgia, serif",
		fontWeight: 400,
		fontSize: 29
	},
	description: { color: "#969f98", fontSize: 11, lineHeight: 1.7, maxWidth: 390 },
	capabilities: {
		listStyle: "square",
		paddingLeft: 16,
		margin: "12px 0 28px",
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: "#7f8982",
		fontSize: 9,
		textTransform: "uppercase",
		letterSpacing: ".08em"
	},
	action: {
		marginTop: "auto",
		display: "flex",
		justifyContent: "space-between",
		width: "100%",
		border: 0,
		borderTop: "1px solid #3c433e",
		padding: "14px 2px 0",
		color: { default: tokens.colorText, ":hover": tokens.colorAccent },
		backgroundColor: "transparent",
		cursor: "pointer",
		textDecoration: "none",
		fontSize: 10,
		letterSpacing: ".1em"
	},
	footer: {
		marginTop: 28,
		paddingTop: 16,
		borderTop: "1px solid #303632",
		display: "grid",
		gridTemplateColumns: "140px 1fr auto",
		alignItems: "center",
		color: "#79827c",
		fontSize: 10
	}
});
