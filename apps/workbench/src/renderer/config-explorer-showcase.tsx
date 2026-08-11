import * as stylex from "@stylexjs/stylex";
import type { ConfigExplorerSuppliedResult } from "@ue-shed/extension-config-explorer";
import { ConfigExplorerRoute } from "@ue-shed/extension-config-explorer";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { ConfigExplorerShowcaseResult } from "../main/preload.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";

type ReadyShowcase = Extract<ConfigExplorerShowcaseResult, { readonly status: "ready" }>;

const presets = [
	{ id: "comparison", label: "Platform compare", note: "clear vs explicit empty" },
	{ id: "platform_a", label: "Platform A", note: "ordered contribution ledger" },
	{ id: "platform_b", label: "Platform B", note: "duplicates remain visible" },
	{ id: "scalar", label: "Scalar", note: "replacement precedence" },
	{ id: "explicit_empty", label: "Explicit empty", note: "distinct from missing" },
	{ id: "unsupported", label: "Unsupported", note: "partial coverage" },
	{ id: "redirect", label: "Redirect", note: "identity uncertainty" }
] as const;

type Preset = (typeof presets)[number]["id"];

function evidenceFor(result: ReadyShowcase, preset: Preset): ConfigExplorerSuppliedResult {
	switch (preset) {
		case "comparison":
			return result.comparison;
		case "platform_a":
			return result.comparison.left;
		case "platform_b":
			return result.comparison.right;
		case "scalar":
			return result.scalarReplacement;
		case "explicit_empty":
			return result.explicitEmpty;
		case "unsupported":
			return result.unsupportedSyntax;
		case "redirect":
			return result.redirectInvolvement;
	}
}

export interface ConfigExplorerShowcaseProps {
	readonly client: Pick<WorkbenchRendererClient, "configExplorerShowcase">;
}

export function ConfigExplorerShowcase(props: ConfigExplorerShowcaseProps) {
	const action = createEffectAction();
	const [loading, setLoading] = createSignal(true);
	const [result, setResult] = createSignal<ConfigExplorerShowcaseResult>();
	const [transportFailure, setTransportFailure] = createSignal(false);
	const [preset, setPreset] = createSignal<Preset>("comparison");
	const ready = createMemo(() => {
		const current = result();
		return current?.status === "ready" ? current : undefined;
	});
	const failed = createMemo(() => {
		const current = result();
		return current?.status === "failed" ? current : undefined;
	});
	const selectedEvidence = createMemo(() => {
		const current = ready();
		return current === undefined ? undefined : evidenceFor(current, preset());
	});

	const load = () => {
		setLoading(true);
		setTransportFailure(false);
		action.run(props.client.configExplorerShowcase(), {
			onFailure: () => {
				setLoading(false);
				setTransportFailure(true);
			},
			onSuccess: (next) => {
				setLoading(false);
				setResult(next);
			}
		});
	};

	onMount(load);

	return (
		<main {...stylex.props(styles.route)}>
			<header {...stylex.props(styles.controlHeader)}>
				<div>
					<nav aria-label="Breadcrumb" {...stylex.props(styles.eyebrow)}>
						Showcase / Config Explorer
					</nav>
					<h1 {...stylex.props(styles.title)}>Saved settings, with receipts.</h1>
					<p {...stylex.props(styles.intro)}>
						This route runs the headless resolver against UE Shed’s committed text
						fixture. The renderer receives only its validated evidence contract.
					</p>
				</div>
				<div {...stylex.props(styles.queryPlate)}>
					<span>FIXTURE QUERY</span>
					<code>[Fixture.Settings] / Entries</code>
					<small>Game.ini · PlatformA ⇄ PlatformB</small>
				</div>
			</header>

			<Show when={ready()}>
				<nav aria-label="Config evidence presets" {...stylex.props(styles.presets)}>
					<For each={presets}>
						{(item) => (
							<button
								aria-pressed={preset() === item.id}
								onClick={() => setPreset(item.id)}
								{...stylex.props(
									styles.preset,
									preset() === item.id && styles.presetActive
								)}
							>
								<strong>{item.label}</strong>
								<span>{item.note}</span>
							</button>
						)}
					</For>
				</nav>
			</Show>

			<Show when={loading()}>
				<section aria-live="polite" {...stylex.props(styles.state)}>
					<span {...stylex.props(styles.pulse)} />
					<div>
						<strong>Reconstructing the saved hierarchy</strong>
						<p>Reading fixture layers and folding UE 5.7 operations…</p>
					</div>
				</section>
			</Show>

			<Show when={transportFailure()}>
				<section role="alert" {...stylex.props(styles.state, styles.failure)}>
					<div>
						<strong>Workbench could not decode the evidence response.</strong>
						<p>Restart Workbench and verify package versions, then retry.</p>
					</div>
					<button onClick={load} {...stylex.props(styles.retry)}>
						RETRY
					</button>
				</section>
			</Show>

			<Show when={failed()}>
				{(failed) => (
					<section role="alert" {...stylex.props(styles.state, styles.failure)}>
						<div>
							<strong>{failed().error.message}</strong>
							<p>{failed().error.recovery}</p>
							<code>{failed().error.code}</code>
						</div>
						<button onClick={load} {...stylex.props(styles.retry)}>
							RETRY
						</button>
					</section>
				)}
			</Show>

			<Show when={selectedEvidence()} keyed>
				{(evidence) => (
					<section
						aria-label="Config Explorer evidence"
						{...stylex.props(styles.evidence)}
					>
						<ConfigExplorerRoute result={evidence} />
					</section>
				)}
			</Show>
		</main>
	);
}

const styles = stylex.create({
	route: {
		minHeight: "calc(100vh - 52px)",
		backgroundColor: "#0d100e",
		backgroundImage:
			"radial-gradient(circle at 78% -20%, #d4552d20, transparent 34%), linear-gradient(90deg, transparent 49.9%, #ffffff08 50%, transparent 50.1%)",
		color: tokens.colorText,
		padding: "34px 38px 52px"
	},
	controlHeader: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 36,
		paddingBottom: 25,
		borderBottom: "1px solid #333934"
	},
	eyebrow: { color: "#d4552d", fontSize: 9, letterSpacing: ".18em" },
	title: {
		margin: "10px 0 8px",
		fontFamily: "Georgia, serif",
		fontSize: 36,
		fontWeight: 400,
		letterSpacing: "-.025em"
	},
	intro: { maxWidth: 690, margin: 0, color: "#89938c", fontSize: 11, lineHeight: 1.6 },
	queryPlate: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		minWidth: 330,
		padding: "15px 18px",
		border: "1px solid #474e48",
		backgroundColor: "#151a17"
	},
	presets: {
		display: "grid",
		gridTemplateColumns: "repeat(7, minmax(110px, 1fr))",
		gap: 1,
		margin: "18px 0",
		backgroundColor: "#333934",
		border: "1px solid #333934"
	},
	preset: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		minHeight: 58,
		padding: "11px 12px",
		border: 0,
		backgroundColor: { default: "#151a17", ":hover": "#1d231f" },
		color: "#9aa39c",
		cursor: "pointer",
		textAlign: "left"
	},
	presetActive: { backgroundColor: "#d4552d", color: "#fff7e8" },
	state: {
		display: "flex",
		alignItems: "center",
		gap: 16,
		minHeight: 140,
		padding: 24,
		border: "1px solid #333934",
		backgroundColor: "#151a17"
	},
	failure: { justifyContent: "space-between", borderLeft: "4px solid #d4552d" },
	pulse: {
		width: 11,
		height: 11,
		borderRadius: "50%",
		backgroundColor: "#f3c969",
		boxShadow: "0 0 0 7px #f3c9691f"
	},
	retry: {
		padding: "9px 14px",
		border: "1px solid #d4552d",
		backgroundColor: "transparent",
		color: "#f3c969",
		cursor: "pointer"
	},
	evidence: { overflow: "hidden", border: "1px solid #4b504b" }
});
