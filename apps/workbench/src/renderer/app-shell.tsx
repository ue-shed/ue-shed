import * as stylex from "@stylexjs/stylex";
import { workbenchDarkTheme } from "@ue-shed/ui-theme/themes.stylex.js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { createEffectAction } from "@ue-shed/ui";
const AuthoringRoute = lazy(async () => {
	const [route, { authoringClient }] = await Promise.all([
		import("@ue-shed/extension-data-authoring"),
		import("./authoring-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.AuthoringRoute>, "client">) => (
			<route.AuthoringRoute {...props} client={authoringClient} />
		)
	};
});
import { type GameTextPreferences } from "@ue-shed/extension-game-text";
const GameTextRoute = lazy(async () => {
	const [route, { gameTextClient }] = await Promise.all([
		import("@ue-shed/extension-game-text"),
		import("./game-text-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.GameTextRoute>, "client">) => (
			<route.GameTextRoute {...props} client={gameTextClient} />
		)
	};
});
const InputAtlasRoute = lazy(async () => {
	const [route, { inputAtlasClient }] = await Promise.all([
		import("@ue-shed/extension-input-atlas"),
		import("./input-atlas-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.InputAtlasRoute>, "client">) => (
			<route.InputAtlasRoute {...props} client={inputAtlasClient} />
		)
	};
});
import { type TextureAuditPreferences } from "@ue-shed/extension-asset-audits";
const TextureAuditRoute = lazy(async () => {
	const [route, { assetAuditsClient }] = await Promise.all([
		import("@ue-shed/extension-asset-audits"),
		import("./asset-audits-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.TextureAuditRoute>, "client">) => (
			<route.TextureAuditRoute {...props} client={assetAuditsClient} />
		)
	};
});
const MapReviewRoute = lazy(async () => {
	const [route, { mapReviewClient }] = await Promise.all([
		import("@ue-shed/extension-camera-review"),
		import("./map-review-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.MapReviewRoute>, "client">) => (
			<route.MapReviewRoute {...props} client={mapReviewClient} />
		)
	};
});
const MapCaptureRoute = lazy(async () => {
	const [route, { mapCaptureClient }] = await Promise.all([
		import("@ue-shed/extension-camera-review"),
		import("./map-capture-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.MapCaptureRoute>, "client">) => (
			<route.MapCaptureRoute {...props} client={mapCaptureClient} />
		)
	};
});
const ContentObservatoryRoute = lazy(async () => {
	const [route, { contentObservatoryClient }] = await Promise.all([
		import("@ue-shed/extension-content-observatory"),
		import("./content-observatory-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.ContentObservatoryRoute>, "client">) => (
			<route.ContentObservatoryRoute {...props} client={contentObservatoryClient} />
		)
	};
});
const ProjectCustodianRoute = lazy(async () => {
	const [route, { projectCustodianClient }] = await Promise.all([
		import("@ue-shed/extension-project-custodian"),
		import("./project-custodian-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.ProjectCustodianRoute>, "client">) => (
			<route.ProjectCustodianRoute {...props} client={projectCustodianClient} />
		)
	};
});
const NiagaraPreviewRoute = lazy(async () => {
	const [route, { niagaraPreviewClient }] = await Promise.all([
		import("@ue-shed/extension-niagara-preview"),
		import("./niagara-preview-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.NiagaraPreviewRoute>, "client">) => (
			<route.NiagaraPreviewRoute {...props} client={niagaraPreviewClient} />
		)
	};
});
const ConfigExplorerShowcase = lazy(() =>
	import("./config-explorer-showcase.js").then((module) => ({
		default: module.ConfigExplorerShowcase
	}))
);
const BlueprintGraphViewer = lazy(() =>
	import("./blueprint-graph-viewer.js").then((module) => ({
		default: module.BlueprintGraphViewer
	}))
);
import { type ScenarioStudioDraft } from "@ue-shed/extension-scenarios";
const ScenarioStudioRoute = lazy(async () => {
	const [route, { scenarioStudioClient }] = await Promise.all([
		import("@ue-shed/extension-scenarios"),
		import("./scenario-studio-client.js")
	]);
	return {
		default: (props: Omit<ComponentProps<typeof route.ScenarioStudioRoute>, "client">) => (
			<route.ScenarioStudioRoute {...props} client={scenarioStudioClient} />
		)
	};
});
import type { CameraStatus } from "@ue-shed/protocol";
import {
	lazy,
	Suspense,
	For,
	Match,
	Show,
	Switch,
	createSignal,
	onCleanup,
	onMount
} from "solid-js";
import type { ComponentProps, JSX } from "solid-js";
import type { ShowcaseContext } from "../shared/ipc-contracts.js";

const CameraLab = lazy(() =>
	import("./camera-lab.js").then((module) => ({ default: module.CameraLab }))
);
import { workbenchRendererClient } from "./workbench-client.js";

import { EditorSessionTransport } from "./editor-session-transport.js";
import { ProjectChooser } from "./project-chooser.js";

import {
	IconGamepad,
	IconBlueprint,
	IconGrid,
	IconHistory,
	IconImage,
	IconLayers,
	IconMap,
	IconShield,
	IconSliders,
	IconSparkles,
	IconTable,
	IconTimeline,
	IconType,
	IconVideo
} from "./icons.js";

interface NavItem {
	readonly description?: string;
	readonly evidence?: string;
	readonly icon: () => JSX.Element;
	readonly label: string;
	readonly route: string;
}

interface NavSection {
	readonly id: string;
	readonly items: readonly NavItem[];
	readonly label: string;
	readonly note?: string;
}

const navSections: readonly NavSection[] = [
	{
		id: "overview",
		items: [{ icon: IconGrid, label: "Showcase", route: "#/" }],
		label: "Overview"
	},
	{
		id: "inspect",
		items: [
			{
				description: "Reconstruct saved Blueprint nodes, pins, defaults, and links.",
				evidence: "blueprints",
				icon: IconBlueprint,
				label: "Blueprint Graphs",
				route: "#/blueprint-graphs"
			},
			{
				description: "Check texture sizes, groups, and compression against your rules.",
				evidence: "textures",
				icon: IconImage,
				label: "Texture Audit",
				route: "#/asset-audits/textures"
			},
			{
				description: "Explain any saved .ini value through every override that shaped it.",
				evidence: "config",
				icon: IconSliders,
				label: "Config Explorer",
				route: "#/config-explorer"
			},
			{
				description: "Decode Enhanced Input mappings, actions, and contested chords.",
				evidence: "enhanced_input",
				icon: IconGamepad,
				label: "Input Atlas",
				route: "#/input-atlas"
			},
			{
				description: "Find player-facing text down to its source package.",
				evidence: "game_text",
				icon: IconType,
				label: "Game Text",
				route: "#/game-text"
			}
		],
		label: "Inspect",
		note: "Reads saved project files — no editor needed"
	},
	{
		id: "author",
		items: [
			{
				description:
					"Edit DataTable rows with validation, then apply through a live session.",
				evidence: "data_tables",
				icon: IconTable,
				label: "Data Authoring",
				route: "#/authoring"
			},
			{
				description: "Draft movement timelines offline, then run them against PIE.",
				evidence: "scenarios",
				icon: IconTimeline,
				label: "Scenario Studio",
				route: "#/scenarios"
			},
			{
				description: "Inventory regeneratable storage and clean exactly what you approve.",
				evidence: "custodian",
				icon: IconShield,
				label: "Project Custodian",
				route: "#/project-custodian"
			}
		],
		label: "Author & clean up",
		note: "Drafts stay offline · applies need a live session"
	},
	{
		id: "capture",
		items: [
			{
				description: "Browse saved actors and compare captured frames when Unreal runs.",
				evidence: "maps",
				icon: IconMap,
				label: "Map Review",
				route: "#/map-review"
			},
			{
				description: "Publish multiresolution map tiles from a clean editor map.",
				evidence: "map_capture",
				icon: IconLayers,
				label: "Map Capture",
				route: "#/map-capture"
			},
			{
				description: "Render a saved Niagara Baker view into hashed PNG frames.",
				evidence: "niagara",
				icon: IconSparkles,
				label: "Niagara Preview",
				route: "#/niagara-preview"
			}
		],
		label: "Capture & review",
		note: "Plans open offline · captures start Unreal"
	},
	{
		id: "history",
		items: [
			{
				description: "Read map history, changelists, and who changed the world.",
				evidence: "world_log",
				icon: IconHistory,
				label: "World Log",
				route: "#/content-observatory"
			}
		],
		label: "History",
		note: "Queries Perforce when opened"
	},
	{
		id: "live",
		items: [
			{
				description: "Stress multi-camera capture pipelines against a running editor.",
				evidence: "cameras",
				icon: IconVideo,
				label: "Camera Lab",
				route: "#/camera-lab"
			}
		],
		label: "Live session",
		note: "Requires a running Unreal editor"
	}
];

type Route = (typeof navSections)[number]["items"][number]["route"];

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

type CameraEvidence =
	| { readonly status: "loading" }
	| { readonly status: "failed" }
	| { readonly status: "ready"; readonly value: CameraStatus };

function workflowEvidence(
	item: NavItem,
	context: ShowcaseContext | undefined,
	camera: CameraEvidence,
	contextFailed = false
): WorkflowEvidence {
	if (item.evidence === "cameras") {
		if (camera.status === "failed")
			return {
				label: "Camera status unavailable",
				detail: "Check the selected target and retry",
				ready: false
			};
		if (camera.status === "loading") {
			return {
				detail: "Reading camera service",
				label: "Checking live session…",
				ready: false
			};
		}
		return {
			detail: `${camera.value.config.activeCameraCount} scheduled · ${camera.value.config.resolution}`,
			label: camera.value.stats.pipeConnected
				? "Camera pipe connected"
				: "Waiting for an editor",
			ready: camera.value.stats.pipeConnected
		};
	}
	if (item.evidence === "blueprints") {
		return {
			detail: "Open any uncooked UE 5.7 Blueprint package",
			label: "Saved graph decoder ready",
			ready: true
		};
	}
	if (item.evidence === "config") {
		return {
			detail: context?.configSampleAvailable
				? "Committed fixture ready · platform layers compared"
				: "Select a project or run the showcase from a source checkout",
			label: context?.configSampleAvailable
				? "Sample query available"
				: "Choose a query source",
			ready: context?.configSampleAvailable === true
		};
	}
	if (context === undefined) {
		return {
			detail: contextFailed ? "Open a project to retry" : "Reading Project Index",
			label: contextFailed ? "Project status unavailable" : "Loading project…",
			ready: false
		};
	}
	if (context.project.status === "not_configured") {
		return {
			detail: "Choose a project to begin",
			label: "No project selected",
			ready: false
		};
	}
	if (context.project.status === "failed") {
		return {
			detail: context.project.message,
			label: "Index unavailable",
			ready: false
		};
	}
	if (item.evidence === "maps") {
		return {
			detail: "Offline review works now · live capture optional",
			label: `${context.project.mapCount.toLocaleString()} saved map${context.project.mapCount === 1 ? "" : "s"} indexed`,
			ready: true
		};
	}
	if (item.evidence === "world_log") {
		return {
			detail: "Perforce history is queried when opened",
			label: `${context.project.mapCount.toLocaleString()} map${context.project.mapCount === 1 ? "" : "s"} ready for history`,
			ready: true
		};
	}
	if (context.project.candidates.status === "failed") {
		return {
			detail: context.project.candidates.message,
			label: "Candidate counts unavailable",
			ready: false
		};
	}
	if (item.evidence === "data_tables") {
		return {
			detail: "Headers indexed now · rows load when opened",
			label: packageLabel(context.project.candidates.dataTablePackages, "DataTable"),
			ready: true
		};
	}
	if (item.evidence === "enhanced_input") {
		return {
			detail: "Mappings decode when opened",
			label: packageLabel(context.project.candidates.enhancedInputPackages, "Enhanced Input"),
			ready: true
		};
	}
	if (item.evidence === "game_text") {
		return {
			detail: "String Tables and serialized FText candidates",
			label: packageLabel(context.project.candidates.gameTextPackages, "text-bearing"),
			ready: true
		};
	}
	if (item.evidence === "scenarios") {
		return {
			detail: "Preview drafts offline · execution uses PIE when enabled",
			label: "Movement Gym workflows",
			ready: true
		};
	}
	if (item.evidence === "custodian") {
		return {
			detail: "Trash by default · live revalidation · durable receipt",
			label: "Guarded cleanup available",
			ready: true
		};
	}
	if (item.evidence === "niagara") {
		return {
			detail: "Saved Baker view · the commandlet starts Unreal for you",
			label: "Bake available",
			ready: true
		};
	}
	if (item.evidence === "map_capture") {
		return {
			detail: "Plan inspection works offline · the editor starts for captures",
			label: "Capture plans versioned",
			ready: true
		};
	}
	return {
		detail: context.ruleFile ? "Audit rules configured" : "Choose a rule file to begin",
		label: packageLabel(context.project.candidates.texturePackages, "Texture2D"),
		ready: context.ruleFile !== undefined
	};
}

export function AppShell() {
	const routeFromLocation = (): Route => {
		const value = window.location.hash || "#/";
		for (const section of navSections) {
			const match = section.items.find((item) => item.route === value);
			if (match) return match.route;
		}
		return "#/";
	};
	const [route, setRoute] = createSignal<Route>(routeFromLocation());
	const [projectRevision, setProjectRevision] = createSignal(1);
	const [targetRevision, setTargetRevision] = createSignal(1);
	onMount(() => {
		document.title = "UE Shed Workbench";
		if (!window.location.hash) window.location.hash = "/";
		const onHashChange = () => setRoute(routeFromLocation());
		window.addEventListener("hashchange", onHashChange);
		onCleanup(() => window.removeEventListener("hashchange", onHashChange));
	});
	return (
		<div {...stylex.props(workbenchDarkTheme, styles.app)}>
			<aside aria-label="Workbench" {...stylex.props(styles.sidebar)}>
				<a href="#/" {...stylex.props(styles.brand)}>
					<span {...stylex.props(styles.brandMark)}>UE</span>
					<span>Shed Workbench</span>
				</a>
				<nav {...stylex.props(styles.nav)}>
					<For each={navSections}>
						{(section) => (
							<div {...stylex.props(styles.section)}>
								<p {...stylex.props(styles.sectionLabel)}>{section.label}</p>
								<div {...stylex.props(styles.sectionItems)}>
									<For each={section.items}>
										{(item) => (
											<a
												href={item.route}
												aria-current={
													route() === item.route ? "page" : undefined
												}
												{...stylex.props(
													styles.item,
													route() === item.route && styles.itemActive
												)}
											>
												<span {...stylex.props(styles.itemIcon)}>
													{item.icon()}
												</span>
												{item.label}
											</a>
										)}
									</For>
								</div>
							</div>
						)}
					</For>
				</nav>
				<footer {...stylex.props(styles.footer)}>
					<ProjectChooser
						revision={projectRevision()}
						client={workbenchRendererClient}
						onChosen={() => setProjectRevision((revision) => revision + 1)}
					/>
					<EditorSessionTransport
						client={workbenchRendererClient}
						onTargetChanged={() => setTargetRevision((revision) => revision + 1)}
					/>
					<span {...stylex.props(styles.version)}>0.0.0</span>
				</footer>
			</aside>
			<div {...stylex.props(styles.content)}>
				<Show when={projectRevision()} keyed>
					{(_revision) => {
						// Retained project state outlives routes remounted for a new Unreal target.
						const [scenarioDraft, setScenarioDraft] =
							createSignal<ScenarioStudioDraft>();
						const [gameTextPreferences, setGameTextPreferences] =
							createSignal<GameTextPreferences>();
						const [texturePreferences, setTexturePreferences] =
							createSignal<TextureAuditPreferences>();
						return (
							<Show when={targetRevision()} keyed>
								{(_target) => (
									<Suspense fallback={<p role="status">Loading tool…</p>}>
										<Switch
											fallback={
												<ShowcaseHome
													onChosen={() =>
														setProjectRevision(
															(revision) => revision + 1
														)
													}
												/>
											}
										>
											<Match when={route() === "#/authoring"}>
												<AuthoringRoute />
											</Match>
											<Match when={route() === "#/asset-audits/textures"}>
												<TextureAuditRoute
													initialPreferences={texturePreferences()}
													onPreferencesChange={setTexturePreferences}
												/>
											</Match>
											<Match when={route() === "#/game-text"}>
												<GameTextRoute
													initialPreferences={gameTextPreferences()}
													onPreferencesChange={setGameTextPreferences}
												/>
											</Match>
											<Match when={route() === "#/input-atlas"}>
												<InputAtlasRoute />
											</Match>
											<Match when={route() === "#/config-explorer"}>
												<ConfigExplorerShowcase
													client={workbenchRendererClient}
												/>
											</Match>
											<Match when={route() === "#/blueprint-graphs"}>
												<BlueprintGraphViewer
													client={workbenchRendererClient}
												/>
											</Match>
											<Match when={route() === "#/project-custodian"}>
												<ProjectCustodianRoute />
											</Match>
											<Match when={route() === "#/map-review"}>
												<MapReviewRoute />
											</Match>
											<Match when={route() === "#/map-capture"}>
												<MapCaptureRoute />
											</Match>
											<Match when={route() === "#/niagara-preview"}>
												<NiagaraPreviewRoute />
											</Match>
											<Match when={route() === "#/content-observatory"}>
												<ContentObservatoryRoute />
											</Match>
											<Match when={route() === "#/scenarios"}>
												<ScenarioStudioRoute
													initialDraft={scenarioDraft()}
													onDraftChange={setScenarioDraft}
													showDemoGuide
												/>
											</Match>
											<Match when={route() === "#/camera-lab"}>
												<CameraLab />
											</Match>
										</Switch>
									</Suspense>
								)}
							</Show>
						);
					}}
				</Show>
			</div>
		</div>
	);
}

function ShowcaseHome(props: { readonly onChosen: () => void }) {
	const contextAction = createEffectAction();
	const statusAction = createEffectAction();
	const [context, setContext] = createSignal<ShowcaseContext>();
	const [cameraStatus, setCameraStatus] = createSignal<CameraEvidence>({ status: "loading" });
	const cameraConnected = () => {
		const state = cameraStatus();
		return state.status === "ready" && state.value.stats.pipeConnected;
	};
	const cameraLabel = () => {
		const state = cameraStatus();
		return state.status === "loading"
			? "Checking…"
			: state.status === "failed"
				? "Unavailable"
				: cameraConnected()
					? "Connected"
					: "Offline";
	};
	const selectionAction = createEffectAction();
	const [opening, setOpening] = createSignal(false);
	const [notice, setNotice] = createSignal<string>();
	const [contextFailed, setContextFailed] = createSignal(false);
	const selectProject = (sample: boolean) => {
		setOpening(true);
		setNotice(undefined);
		selectionAction.run(
			sample
				? workbenchRendererClient.sampleProject()
				: workbenchRendererClient.chooseProject(),
			{
				onFailure: () => {
					setOpening(false);
					setNotice("Could not open the project. Retry or choose another directory.");
				},
				onSuccess: (result) => {
					setOpening(false);
					if (result.status === "ready") props.onChosen();
					else if (result.status === "failed")
						setNotice(result.error.message + " " + result.error.recovery);
				}
			}
		);
	};
	onMount(() => {
		contextAction.run(workbenchRendererClient.showcaseContext(), {
			onFailure: () => {
				setContextFailed(true);
				setNotice("Project status could not be loaded. Open a project to retry.");
			},
			onSuccess: setContext
		});
		statusAction.run(workbenchRendererClient.getStatus(), {
			onFailure: () => setCameraStatus({ status: "failed" }),
			onSuccess: (value) => setCameraStatus({ status: "ready", value })
		});
	});
	return (
		<main {...stylex.props(styles.home)}>
			<header {...stylex.props(styles.hero)}>
				<h1 {...stylex.props(styles.homeTitle)}>Explore your Unreal project</h1>
				<p {...stylex.props(styles.homeIntro)}>
					Workbench reads your saved project directly. Most tools answer questions without
					opening the editor — live sessions start only when a workflow needs Unreal.
				</p>
			</header>

			<section aria-label="Get started" {...stylex.props(styles.workflowSection)}>
				<div {...stylex.props(styles.cardGrid)}>
					<button
						type="button"
						disabled={opening()}
						onClick={() => selectProject(true)}
						{...stylex.props(styles.onboardingAction)}
					>
						Try the sample project
					</button>
					<button
						type="button"
						disabled={opening()}
						onClick={() => selectProject(false)}
						{...stylex.props(styles.onboardingAction)}
					>
						Open your project
					</button>
				</div>
				<p>
					Start with{" "}
					<a href="#/authoring" {...stylex.props(styles.guideLink)}>
						Data Authoring
					</a>{" "}
					to inspect a table, explore{" "}
					<a href="#/game-text" {...stylex.props(styles.guideLink)}>
						Game Text
					</a>
					, then check{" "}
					<a href="#/asset-audits/textures" {...stylex.props(styles.guideLink)}>
						Texture Audit
					</a>
					. Live Unreal setup is optional.
				</p>
				<Show when={opening()}>
					<p role="status">Opening and indexing project…</p>
				</Show>
				<Show when={notice()}>{(message) => <p role="alert">{message()}</p>}</Show>
			</section>
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
					label="Camera feed"
					ready={cameraConnected()}
					value={cameraLabel()}
				/>
			</section>

			<For each={navSections.filter((section) => section.id !== "overview")}>
				{(section) => (
					<section aria-label={section.label} {...stylex.props(styles.workflowSection)}>
						<header {...stylex.props(styles.sectionHeader)}>
							<h2 {...stylex.props(styles.sectionTitle)}>{section.label}</h2>
							{section.note === undefined ? null : (
								<span {...stylex.props(styles.sectionNote)}>{section.note}</span>
							)}
						</header>
						<div {...stylex.props(styles.cardGrid)}>
							<For each={section.items}>
								{(item) =>
									item.description === undefined ? null : (
										<WorkflowCard
											evidence={() =>
												workflowEvidence(
													item,
													context(),
													cameraStatus(),
													contextFailed()
												)
											}
											item={item}
										/>
									)
								}
							</For>
						</div>
					</section>
				)}
			</For>

			<footer {...stylex.props(styles.homeFooter)}>
				<span>
					{context()?.health.status ?? (contextFailed() ? "Unavailable" : "Loading")}
				</span>
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

function WorkflowCard(props: {
	readonly evidence: () => WorkflowEvidence;
	readonly item: NavItem;
}) {
	return (
		<a href={props.item.route} {...stylex.props(styles.card)}>
			<h3 {...stylex.props(styles.cardTitle)}>{props.item.label}</h3>
			<p {...stylex.props(styles.cardDescription)}>{props.item.description}</p>
			<div {...stylex.props(styles.cardFoot)}>
				<span
					{...stylex.props(
						styles.statusDot,
						props.evidence().ready ? styles.readyDot : styles.pendingDot
					)}
				/>
				<div {...stylex.props(styles.cardEvidence)}>
					<strong {...stylex.props(styles.evidenceLabel)}>
						{props.evidence().label}
					</strong>
					<small {...stylex.props(styles.evidenceDetail)}>
						{props.evidence().detail}
					</small>
				</div>
				<span aria-hidden="true" {...stylex.props(styles.cardArrow)}>
					→
				</span>
			</div>
		</a>
	);
}

const styles = stylex.create({
	onboardingAction: {
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextStrong,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		padding: "14px 18px",
		textAlign: "left",
		cursor: "pointer",
		fontSize: 16
	},
	guideLink: {
		color: tokens.colorTextStrong,
		textDecorationLine: "underline",
		textUnderlineOffset: 3
	},
	app: {
		display: "flex",
		minHeight: "100vh",
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		lineHeight: 1.5,
		letterSpacing: "-0.005em"
	},
	sidebar: {
		position: "sticky",
		top: 0,
		display: "flex",
		flexDirection: "column",
		width: 224,
		height: "100vh",
		flexShrink: 0,
		backgroundColor: tokens.colorSurface,
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1
	},
	brand: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		height: 48,
		padding: "0 14px",
		color: tokens.colorTextStrong,
		textDecoration: "none",
		fontSize: 13,
		fontWeight: 600,
		letterSpacing: "-0.01em",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		flexShrink: 0
	},
	brandMark: {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		color: tokens.colorAccentText,
		backgroundColor: tokens.colorAccent,
		padding: "1px 5px",
		borderRadius: tokens.radiusBadge,
		fontSize: 11,
		fontWeight: 700
	},
	nav: {
		flex: "1 1 auto",
		minHeight: 0,
		overflowY: "auto",
		padding: "8px 8px 12px"
	},
	section: { display: "flex", flexDirection: "column" },
	sectionLabel: {
		margin: 0,
		padding: "16px 8px 5px",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 500
	},
	sectionItems: { display: "flex", flexDirection: "column", gap: 1 },
	item: {
		display: "flex",
		alignItems: "center",
		gap: 9,
		padding: "5px 8px",
		borderRadius: tokens.radiusControl,
		color: tokens.colorTextMuted,
		textDecoration: "none",
		fontSize: 13,
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, color"
	},
	itemActive: {
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		color: tokens.colorTextStrong
	},
	itemIcon: {
		display: "inline-flex",
		color: "inherit",
		opacity: 0.85,
		flexShrink: 0
	},
	footer: {
		display: "flex",
		flexDirection: "column",
		gap: 10,
		padding: "12px",
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		flexShrink: 0
	},
	version: {
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	content: {
		flex: "1 1 auto",
		minWidth: 0
	},
	home: {
		maxWidth: 1080,
		margin: "0 auto",
		padding: "40px 32px 32px"
	},
	hero: {
		marginBottom: 28,
		maxWidth: 560
	},
	homeTitle: {
		margin: 0,
		fontFamily: tokens.fontDisplay,
		fontSize: 30,
		fontWeight: 590,
		letterSpacing: "-0.022em",
		lineHeight: 1.15,
		color: tokens.colorTextStrong
	},
	homeIntro: {
		margin: "10px 0 0",
		color: tokens.colorTextMuted,
		fontSize: 14,
		lineHeight: 1.6
	},
	projectStrip: {
		display: "grid",
		gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		overflow: "hidden",
		backgroundColor: tokens.colorSurface,
		boxShadow: tokens.shadowCard,
		marginBottom: 36
	},
	projectMetric: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		minWidth: 0,
		padding: "14px 18px",
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1
	},
	metricLabel: {
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 500
	},
	metricValue: {
		overflow: "hidden",
		fontFamily: tokens.fontMono,
		fontSize: 13,
		fontWeight: 500,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	connectedValue: { color: tokens.colorSuccess },
	workflowSection: { marginBottom: 36 },
	sectionHeader: {
		display: "flex",
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: 16,
		paddingBottom: 12,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	sectionTitle: {
		margin: 0,
		fontFamily: tokens.fontDisplay,
		fontSize: 17,
		fontWeight: 590,
		letterSpacing: "-0.01em",
		color: tokens.colorTextStrong
	},
	sectionNote: {
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	cardGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
		gap: 10,
		marginTop: 14
	},
	card: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		minWidth: 0,
		padding: "14px 16px",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: tokens.colorSurface,
			":hover": tokens.colorSurfaceRaised
		},
		boxShadow: tokens.shadowCard,
		color: "inherit",
		textDecoration: "none",
		transitionDuration: tokens.motionFast,
		transitionProperty: "background-color, border-color, transform",
		transform: { default: "translateY(0)", ":hover": "translateY(-1px)" }
	},
	cardTitle: {
		margin: 0,
		fontFamily: tokens.fontDisplay,
		fontSize: 14,
		fontWeight: 590,
		letterSpacing: "-0.01em",
		color: tokens.colorTextStrong
	},
	cardDescription: {
		margin: 0,
		flexGrow: 1,
		color: tokens.colorTextMuted,
		fontSize: 12.5,
		lineHeight: 1.55
	},
	cardFoot: {
		display: "flex",
		alignItems: "flex-start",
		gap: 9,
		marginTop: 6,
		paddingTop: 10,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	statusDot: { width: 7, height: 7, marginTop: 5, borderRadius: "50%", flexShrink: 0 },
	readyDot: { backgroundColor: tokens.colorSuccess },
	pendingDot: { backgroundColor: "#383b3f" },
	cardEvidence: {
		display: "grid",
		gap: 2,
		minWidth: 0,
		flexGrow: 1
	},
	evidenceLabel: {
		overflow: "hidden",
		color: tokens.colorText,
		fontSize: 12,
		fontWeight: 500,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	evidenceDetail: {
		overflow: "hidden",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	cardArrow: {
		marginLeft: "auto",
		color: tokens.colorTextFaint,
		fontSize: 13,
		transitionDuration: tokens.motionFast,
		transitionProperty: "color"
	},
	homeFooter: {
		marginTop: 8,
		paddingTop: 16,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		display: "grid",
		gridTemplateColumns: "auto 1fr auto",
		alignItems: "center",
		gap: 16,
		color: tokens.colorTextSubtle,
		fontSize: 12
	}
});
