import * as stylex from "@stylexjs/stylex";
import { workbenchDarkTheme } from "@ue-shed/ui-theme/themes.stylex.js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createEffectAction } from "@ue-shed/ui";
import { AuthoringRoute } from "@ue-shed/extension-data-authoring";
import { GameTextRoute } from "@ue-shed/extension-game-text";
import { InputAtlasRoute } from "@ue-shed/extension-input-atlas";
import { TextureAuditRoute } from "@ue-shed/extension-asset-audits";
import { MapReviewRoute } from "@ue-shed/extension-camera-review";
import { ContentObservatoryRoute } from "@ue-shed/extension-content-observatory";
import { ScenarioStudioRoute } from "@ue-shed/extension-scenarios";
import type { CameraStatus } from "@ue-shed/protocol";
import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { ShowcaseContext } from "../main/preload.js";
import { assetAuditsClient } from "./asset-audits-client.js";
import { authoringClient } from "./authoring-client.js";
import { gameTextClient } from "./game-text-client.js";
import { inputAtlasClient } from "./input-atlas-client.js";
import { mapReviewClient } from "./map-review-client.js";
import { contentObservatoryClient } from "./content-observatory-client.js";
import { CameraLab } from "./camera-lab.js";
import { workbenchRendererClient } from "./workbench-client.js";
import { scenarioStudioClient } from "./scenario-studio-client.js";
import { EditorSessionTransport } from "./editor-session-transport.js";
import { ProjectChooser } from "./project-chooser.js";

const routes = [
	{ href: "#/", label: "Showcase", route: "#/" },
	{ href: "#/authoring", label: "Data Authoring", route: "#/authoring" },
	{ href: "#/game-text", label: "Game Text", route: "#/game-text" },
	{ href: "#/input-atlas", label: "Input Atlas", route: "#/input-atlas" },
	{ href: "#/asset-audits/textures", label: "Texture Audit", route: "#/asset-audits/textures" },
	{ href: "#/map-review", label: "Map Review", route: "#/map-review" },
	{ href: "#/content-observatory", label: "World Log", route: "#/content-observatory" },
	{ href: "#/scenarios", label: "Scenarios", route: "#/scenarios" },
	{ href: "#/camera-lab", label: "Camera Lab", route: "#/camera-lab" }
] as const;

type Route = (typeof routes)[number]["route"];

const workflowGroups = [
	{
		id: "saved",
		label: "Saved project",
		requirement: "UNREAL CAN STAY CLOSED",
		workflows: [
			{
				action: "OPEN STUDIO",
				description:
					"Edit the portable timeline offline, then run Movement Gym against PIE with live status and cancellation.",
				evidence: "scenarios",
				href: "#/scenarios",
				title: "Scenario Studio",
				tone: "lime"
			},
			{
				action: "OPEN TABLES",
				description:
					"Inspect typed rows, draft cell changes, and apply through a live session.",
				evidence: "data_tables",
				href: "#/authoring",
				title: "Data Authoring",
				tone: "green"
			},
			{
				action: "OPEN ATLAS",
				description: "Trace contexts, actions, mappings, and contested input chords.",
				evidence: "enhanced_input",
				href: "#/input-atlas",
				title: "Input Atlas",
				tone: "blue"
			},
			{
				action: "OPEN CORPUS",
				description: "Find player-facing text and jump back to its package and property.",
				evidence: "game_text",
				href: "#/game-text",
				title: "Game Text",
				tone: "coral"
			},
			{
				action: "OPEN AUDIT",
				description:
					"Run texture rules and inspect the asset evidence behind each finding.",
				evidence: "textures",
				href: "#/asset-audits/textures",
				title: "Texture Audit",
				tone: "amber"
			},
			{
				action: "OPEN REVIEW",
				description:
					"Review saved maps and capture comparison frames when Unreal is available.",
				evidence: "maps",
				href: "#/map-review",
				title: "Map Review",
				tone: "violet"
			}
		]
	},
	{
		id: "source_control",
		label: "Source control",
		requirement: "PERFORCE ON DEMAND",
		workflows: [
			{
				action: "OPEN WORLD LOG",
				description: "Read map history, changelists, and the people behind world changes.",
				evidence: "world_log",
				href: "#/content-observatory",
				title: "World Log",
				tone: "steel"
			}
		]
	},
	{
		id: "live",
		label: "Live editor",
		requirement: "RUNNING UNREAL SESSION",
		workflows: [
			{
				action: "OPEN LOAD LAB",
				description:
					"Change camera count, resolution, and pipeline mode while measuring delivery.",
				evidence: "cameras",
				href: "#/camera-lab",
				title: "Camera Lab",
				tone: "cyan"
			}
		]
	}
] as const;

type Workflow = (typeof workflowGroups)[number]["workflows"][number];

interface WorkflowEvidence {
	readonly detail: string;
	readonly label: string;
	readonly ready: boolean;
}

type ReadyProjectEvidence = Extract<ShowcaseContext["project"], { readonly status: "ready" }>;

function readyProjectEvidence(
	context: ShowcaseContext | undefined
): ReadyProjectEvidence | undefined {
	return context?.project.status === "ready" ? context.project : undefined;
}

function packageLabel(count: number, subject: string): string {
	return `${count.toLocaleString()} ${subject} package${count === 1 ? "" : "s"} indexed`;
}

function workflowEvidence(
	workflow: Workflow,
	context: ShowcaseContext | undefined,
	camera: CameraStatus | undefined
): WorkflowEvidence {
	if (workflow.evidence === "cameras") {
		if (camera === undefined) {
			return {
				detail: "Reading camera service",
				label: "Checking live session…",
				ready: false
			};
		}
		return {
			detail: `${camera.config.activeCameraCount} scheduled · ${camera.config.resolution} · ${camera.config.pipelineMode.replaceAll("_", " ")}`,
			label: camera.stats.pipeConnected ? "Camera pipe connected" : "Unreal is offline",
			ready: camera.stats.pipeConnected
		};
	}
	if (workflow.evidence === "scenarios") {
		return {
			detail: "Portable draft + live PIE run console when UEShedScenarios is enabled",
			label: "Movement Gym · preview or execute",
			ready: true
		};
	}
	if (context === undefined) {
		return {
			detail: "Reading Project Index",
			label: "Loading project evidence…",
			ready: false
		};
	}
	if (context.project.status === "not_configured") {
		return {
			detail: "Use Choose project in the header",
			label: "No project selected",
			ready: false
		};
	}
	if (context.project.status === "failed") {
		return {
			detail: context.project.message,
			label: "Project Index unavailable",
			ready: false
		};
	}
	if (workflow.evidence === "maps") {
		return {
			detail: "Saved review works now · live capture is optional",
			label: `${context.project.mapCount.toLocaleString()} saved map${context.project.mapCount === 1 ? "" : "s"} indexed`,
			ready: true
		};
	}
	if (workflow.evidence === "world_log") {
		return {
			detail: "Perforce history is queried when opened",
			label: `${context.project.mapCount.toLocaleString()} map${context.project.mapCount === 1 ? "" : "s"} ready for history`,
			ready: true
		};
	}
	if (context.project.candidates.status === "failed") {
		return {
			detail: context.project.candidates.message,
			label: "Candidate evidence unavailable",
			ready: false
		};
	}
	if (workflow.evidence === "data_tables") {
		return {
			detail: "Header scan only · rows load when opened",
			label: packageLabel(context.project.candidates.dataTablePackages, "DataTable"),
			ready: true
		};
	}
	if (workflow.evidence === "enhanced_input") {
		return {
			detail: "Mappings are decoded when opened",
			label: packageLabel(context.project.candidates.enhancedInputPackages, "Enhanced Input"),
			ready: true
		};
	}
	if (workflow.evidence === "game_text") {
		return {
			detail: "String Tables and serialized FText candidates",
			label: packageLabel(context.project.candidates.gameTextPackages, "text-bearing"),
			ready: true
		};
	}
	return {
		detail: context.ruleFile ? "Audit rules configured" : "Choose a rule file in Texture Audit",
		label: packageLabel(context.project.candidates.texturePackages, "Texture2D"),
		ready: context.ruleFile !== undefined
	};
}

export function AppShell() {
	const routeFromLocation = (): Route => {
		const value = window.location.hash || "#/";
		return routes.some((route) => route.route === value) ? (value as Route) : "#/";
	};
	const [route, setRoute] = createSignal<Route>(routeFromLocation());
	const [projectRevision, setProjectRevision] = createSignal(1);
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
				<ProjectChooser
					client={workbenchRendererClient}
					onChosen={() => setProjectRevision((revision) => revision + 1)}
				/>
				<EditorSessionTransport client={workbenchRendererClient} />
				<span {...stylex.props(styles.version)}>0.0.0</span>
			</nav>
			<Show when={projectRevision()} keyed>
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
					<Match when={route() === "#/content-observatory"}>
						<ContentObservatoryRoute client={contentObservatoryClient} />
					</Match>
					<Match when={route() === "#/scenarios"}>
						<ScenarioStudioRoute client={scenarioStudioClient} showDemoGuide />
					</Match>
					<Match when={route() === "#/camera-lab"}>
						<CameraLab />
					</Match>
				</Switch>
			</Show>
		</div>
	);
}

function ShowcaseHome() {
	const contextAction = createEffectAction();
	const statusAction = createEffectAction();
	const [context, setContext] = createSignal<ShowcaseContext>();
	const [cameraStatus, setCameraStatus] = createSignal<CameraStatus>();
	onMount(() => {
		contextAction.run(workbenchRendererClient.showcaseContext(), {
			onSuccess: setContext
		});
		statusAction.run(workbenchRendererClient.getStatus(), {
			onFailure: () => setCameraStatus(undefined),
			onSuccess: setCameraStatus
		});
	});
	return (
		<main {...stylex.props(styles.home)}>
			<header {...stylex.props(styles.hero)}>
				<div>
					<nav aria-label="Breadcrumb" {...stylex.props(styles.eyebrow)}>
						Showcase / Workbench
					</nav>
					<h1 {...stylex.props(styles.homeTitle)}>Pick the evidence you need.</h1>
				</div>
				<p {...stylex.props(styles.homeIntro)}>
					Every workflow is listed below. Requirements are explicit; counts come from the
					selected project.
				</p>
			</header>

			<section aria-label="Current project" {...stylex.props(styles.projectStrip)}>
				<ProjectMetric
					label="Project"
					value={
						readyProjectEvidence(context())?.projectName ??
						(context()?.project.status === "failed"
							? "Index unavailable"
							: "Not selected")
					}
				/>
				<ProjectMetric
					label="Packages"
					value={readyProjectEvidence(context())?.packageCount.toLocaleString() ?? "—"}
				/>
				<ProjectMetric
					label="Saved maps"
					value={readyProjectEvidence(context())?.mapCount.toLocaleString() ?? "—"}
				/>
				<ProjectMetric
					label="Live Unreal"
					ready={cameraStatus()?.stats.pipeConnected === true}
					value={cameraStatus()?.stats.pipeConnected ? "Connected" : "Offline"}
				/>
			</section>

			<section aria-label="Workbench workflows" {...stylex.props(styles.workflowGroups)}>
				<For each={workflowGroups}>
					{(group) => (
						<section
							aria-labelledby={`workflow-${group.id}`}
							{...stylex.props(styles.workflowGroup)}
						>
							<header {...stylex.props(styles.groupHeader)}>
								<h2
									id={`workflow-${group.id}`}
									{...stylex.props(styles.groupTitle)}
								>
									{group.label}
								</h2>
								<span {...stylex.props(styles.groupRequirement)}>
									{group.requirement}
								</span>
							</header>
							<div {...stylex.props(styles.workflowList)}>
								<For each={group.workflows}>
									{(workflow) => (
										<WorkflowRow
											evidence={() =>
												workflowEvidence(
													workflow,
													context(),
													cameraStatus()
												)
											}
											workflow={workflow}
										/>
									)}
								</For>
							</div>
						</section>
					)}
				</For>
			</section>

			<footer {...stylex.props(styles.footer)}>
				<span>{context()?.health.status ?? "LOADING"}</span>
				<p>
					{readyProjectEvidence(context())?.projectRoot ??
						"Choose any Unreal project directory to begin."}
				</p>
				<code>docs/showcase.md</code>
			</footer>
		</main>
	);
}

function ProjectMetric(props: {
	readonly label: string;
	readonly ready?: boolean;
	readonly value: string;
}) {
	return (
		<div {...stylex.props(styles.projectMetric)}>
			<small {...stylex.props(styles.metricLabel)}>{props.label}</small>
			<strong {...stylex.props(styles.metricValue, props.ready && styles.connectedValue)}>
				{props.value}
			</strong>
		</div>
	);
}

function WorkflowRow(props: {
	readonly evidence: () => WorkflowEvidence;
	readonly workflow: Workflow;
}) {
	return (
		<a
			href={props.workflow.href}
			{...stylex.props(styles.workflow, styles[props.workflow.tone])}
		>
			<div {...stylex.props(styles.workflowIdentity)}>
				<h3 {...stylex.props(styles.rowTitle)}>{props.workflow.title}</h3>
				<p {...stylex.props(styles.rowDescription)}>{props.workflow.description}</p>
			</div>
			<div {...stylex.props(styles.evidence)}>
				<span
					{...stylex.props(
						styles.statusDot,
						props.evidence().ready ? styles.ready : styles.optional
					)}
				/>
				<div>
					<strong {...stylex.props(styles.evidenceLabel)}>
						{props.evidence().label}
					</strong>
					<small {...stylex.props(styles.evidenceDetail)}>
						{props.evidence().detail}
					</small>
				</div>
			</div>
			<span {...stylex.props(styles.rowAction)}>
				{props.workflow.action} <b>→</b>
			</span>
		</a>
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
		justifyContent: "space-between",
		gap: 40,
		minHeight: 76
	},
	eyebrow: { margin: 0, color: "#89938c", fontSize: 10, letterSpacing: "0.18em" },
	homeTitle: {
		margin: "8px 0 0",
		fontFamily: "Georgia, serif",
		fontSize: 30,
		fontWeight: 400,
		letterSpacing: "-0.015em"
	},
	homeIntro: {
		maxWidth: 440,
		margin: 0,
		color: "#89938c",
		fontSize: 11,
		lineHeight: 1.65
	},
	projectStrip: {
		display: "grid",
		gridTemplateColumns: "minmax(240px, 1.5fr) repeat(3, minmax(130px, 0.6fr))",
		margin: "18px 0 24px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: "#111513cc"
	},
	projectMetric: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		minWidth: 0,
		padding: "11px 16px",
		borderRight: "1px solid #303632",
		color: "#d9dfda"
	},
	metricLabel: {
		color: "#68726b",
		fontSize: 8,
		letterSpacing: ".12em",
		textTransform: "uppercase"
	},
	metricValue: {
		overflow: "hidden",
		fontFamily: tokens.fontBody,
		fontSize: 11,
		fontWeight: 500,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	connectedValue: { color: "#a8d88e" },
	workflowGroups: {
		display: "flex",
		flexDirection: "column",
		gap: 22
	},
	workflowGroup: { display: "grid", gridTemplateColumns: "190px minmax(0, 1fr)", gap: 14 },
	groupHeader: {
		padding: "12px 0",
		borderTop: "1px solid #343a36"
	},
	groupTitle: { margin: 0, fontFamily: "Georgia, serif", fontSize: 18, fontWeight: 400 },
	groupRequirement: {
		display: "block",
		marginTop: 7,
		color: "#68726b",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	workflowList: {
		display: "flex",
		flexDirection: "column",
		borderBottom: "1px solid #343a36"
	},
	workflow: {
		position: "relative",
		display: "grid",
		gridTemplateColumns: "minmax(250px, 1fr) minmax(320px, 1.15fr) 150px",
		alignItems: "center",
		gap: 20,
		minHeight: 88,
		padding: "14px 18px 14px 22px",
		borderTop: "1px solid #343a36",
		borderRight: "1px solid #343a36",
		borderLeftStyle: "solid",
		borderLeftWidth: 3,
		backgroundColor: { default: "#121614e6", ":hover": "#191f1be6" },
		color: tokens.colorText,
		textDecoration: "none"
	},
	green: { borderLeftColor: "#91c976" },
	amber: { borderLeftColor: "#d98f53" },
	blue: { borderLeftColor: "#70a9b2" },
	coral: { borderLeftColor: "#e76b49" },
	violet: { borderLeftColor: "#9d8cc7" },
	steel: { borderLeftColor: "#758991" },
	cyan: { borderLeftColor: "#5eb8c7" },
	lime: { borderLeftColor: "#b7e26d" },
	workflowIdentity: { minWidth: 0 },
	rowTitle: { margin: 0, fontFamily: "Georgia, serif", fontSize: 19, fontWeight: 400 },
	rowDescription: {
		margin: "6px 0 0",
		color: "#89938c",
		fontSize: 10,
		lineHeight: 1.5
	},
	evidence: {
		display: "grid",
		gridTemplateColumns: "7px minmax(0, 1fr)",
		alignItems: "start",
		gap: 11,
		minWidth: 0
	},
	evidenceLabel: {
		display: "block",
		overflow: "hidden",
		color: "#c7cec8",
		fontFamily: tokens.fontBody,
		fontSize: 10,
		fontWeight: 500,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	evidenceDetail: {
		display: "block",
		overflow: "hidden",
		marginTop: 5,
		color: "#69736c",
		fontSize: 9,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	statusDot: { width: 7, height: 7, marginTop: 4, borderRadius: "50%" },
	ready: { backgroundColor: "#8fcf71", boxShadow: "0 0 10px #8fcf7166" },
	optional: { backgroundColor: "#715f4c" },
	rowAction: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		color: "#9da69f",
		fontSize: 9,
		letterSpacing: ".1em"
	},
	footer: {
		marginTop: 26,
		paddingTop: 16,
		borderTop: "1px solid #303632",
		display: "grid",
		gridTemplateColumns: "140px 1fr auto",
		alignItems: "center",
		color: "#79827c",
		fontSize: 10
	}
});
