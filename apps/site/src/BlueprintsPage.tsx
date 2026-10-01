import * as stylex from "@stylexjs/stylex";
import { BlueprintGraphViewer, FileBlueprintOpener } from "@ue-shed/extension-blueprint-graphs";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { workbenchDarkTheme } from "@ue-shed/ui-theme/themes.stylex.js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Show, createSignal, onCleanup } from "solid-js";
import sampleUrl from "../../../fixtures/unreal-project/Content/Fixture/Blueprints/BP_GraphFixture.uasset?url";
import { readBlueprintFile, readBlueprintSample } from "./blueprints/browser-reader.js";
import { repositoryUrl } from "./content.js";
import { offerInspectionFile, takeBlueprint } from "./asset-handoff.js";
import { isPlainNavigation } from "./navigation.js";

export default function BlueprintsPage() {
	document.title = "Blueprint viewer · UE Shed";
	const handoff = takeBlueprint();
	const [inspectFile, setInspectFile] = createSignal<File>();
	const readFile = (file: File) => {
		setInspectFile(undefined);
		return readBlueprintFile(file).pipe(
			Effect.tap((read) =>
				Effect.sync(() => {
					if (read.status === "failed" && read.reason === "unsupported_asset") {
						setInspectFile(file);
					}
				})
			)
		);
	};
	const runtime = ManagedRuntime.make(Layer.empty);
	onCleanup(() => void runtime.dispose());
	return (
		<div {...stylex.attrs(workbenchDarkTheme, styles.page)}>
			<header {...stylex.attrs(styles.header)}>
				<a href="/" {...stylex.attrs(styles.brand)}>
					ue-shed
				</a>
				<nav aria-label="Main" {...stylex.attrs(styles.links)}>
					<a href="/docs" {...stylex.attrs(styles.link)}>
						Docs
					</a>
					<a href="/blueprints" aria-current="page" {...stylex.attrs(styles.link)}>
						Blueprint viewer
					</a>
					<a href="/sequencer" {...stylex.attrs(styles.link)}>
						Sequencer viewer
					</a>
					<a href="/data-tables" {...stylex.attrs(styles.link)}>
						Data tables
					</a>
					<a href="/inspect" {...stylex.attrs(styles.link)}>
						Asset inspector
					</a>
					<a href={repositoryUrl} {...stylex.attrs(styles.link)}>
						GitHub ↗
					</a>
				</nav>
			</header>
			<EffectRuntimeProvider runtime={runtime}>
				<BlueprintGraphViewer
					initialRead={handoff === undefined ? undefined : Effect.succeed(handoff.read)}
					opener={(controls) => (
						<FileBlueprintOpener
							controls={controls}
							readFile={readFile}
							sample={{
								label: "Try the sample Blueprint",
								load: () => {
									setInspectFile(undefined);
									return readBlueprintSample(sampleUrl);
								}
							}}
						/>
					)}
					failureActions={(failure) => (
						<Show when={failure.reason === "unsupported_asset" && inspectFile()}>
							{(file) => (
								<a
									href="/inspect"
									{...stylex.attrs(styles.failureAction)}
									onClick={(event) => {
										if (isPlainNavigation(event)) offerInspectionFile(file());
									}}
								>
									Inspect this file instead
								</a>
							)}
						</Show>
					)}
					transportFailureCopy={{
						title: "The browser decoder is unavailable",
						message: "The browser could not finish reading this Blueprint locally.",
						recovery:
							"Reload the page and try again in a browser with WebAssembly and Web Worker support."
					}}
				/>
			</EffectRuntimeProvider>
		</div>
	);
}

const styles = stylex.create({
	failureAction: {
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		borderStyle: "solid",
		borderWidth: 1,
		boxSizing: "border-box",
		color: tokens.colorText,
		display: "inline-flex",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		justifySelf: "start",
		marginTop: 6,
		maxWidth: "100%",
		padding: "6px 10px",
		textDecoration: "none"
	},
	page: { backgroundColor: tokens.colorCanvas, minHeight: "100vh" },
	header: {
		alignItems: "center",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		display: "flex",
		flexWrap: "wrap",
		fontFamily: tokens.fontBody,
		gap: 16,
		justifyContent: "space-between",
		padding: "22px 28px"
	},
	brand: { color: tokens.colorTextStrong, fontSize: 15, fontWeight: 700, textDecoration: "none" },
	links: { display: "flex", flexWrap: "wrap", gap: 18 },
	link: {
		color: { default: tokens.colorTextMuted, ":hover": tokens.colorTextStrong },
		fontSize: 12,
		textDecoration: "none"
	}
});
