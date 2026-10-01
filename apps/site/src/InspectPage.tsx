import * as stylex from "@stylexjs/stylex";
import {
	AssetInspector,
	FileAssetOpener,
	type AssetRelatedView
} from "@ue-shed/extension-asset-inspector";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { workbenchDarkTheme } from "@ue-shed/ui-theme/themes.stylex.js";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { onCleanup } from "solid-js";
import stringTableUrl from "../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset?url";
import dataTableUrl from "../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset?url";
import blueprintUrl from "../../../fixtures/unreal-project/Content/Fixture/Blueprints/BP_GraphFixture.uasset?url";
import {
	lastInspection,
	offerBlueprint,
	offerSequence,
	offerAuthoring,
	rememberInspection,
	takeInspectionFile
} from "./asset-handoff.js";
import { readAssetFile, readAssetSample, type SiteAssetRead } from "./blueprints/browser-reader.js";
import { sequenceRelatedView } from "./blueprints/sequence-related-view.js";
import { blueprintRelatedView, authoringRelatedView } from "./blueprints/related-view.js";
import { repositoryUrl } from "./content.js";
import { isPlainNavigation } from "./navigation.js";

export default function InspectPage() {
	document.title = "Asset Inspector · UE Shed";
	const handedFile = takeInspectionFile();
	const previous = lastInspection();
	const runtime = ManagedRuntime.make(Layer.empty);
	onCleanup(() => void runtime.dispose());
	const accept = (value: SiteAssetRead) =>
		Effect.sync(() => {
			rememberInspection(value);
			return value.read;
		});
	const readFile = (file: File) => readAssetFile(file).pipe(Effect.flatMap(accept));
	const initialRead =
		handedFile !== undefined
			? readFile(handedFile)
			: previous === undefined
				? undefined
				: Effect.succeed(previous.read);
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
					<a href="/blueprints" {...stylex.attrs(styles.link)}>
						Blueprint viewer
					</a>
					<a href="/sequencer" {...stylex.attrs(styles.link)}>
						Sequencer viewer
					</a>
					<a href="/data-tables" {...stylex.attrs(styles.link)}>
						Data tables
					</a>
					<a href="/inspect" aria-current="page" {...stylex.attrs(styles.link)}>
						Asset inspector
					</a>
					<a href={repositoryUrl} {...stylex.attrs(styles.link)}>
						GitHub ↗
					</a>
				</nav>
			</header>
			<EffectRuntimeProvider runtime={runtime}>
				<AssetInspector
					initialRead={initialRead}
					opener={(controls) => (
						<FileAssetOpener
							controls={controls}
							readFile={readFile}
							samples={[
								{
									label: "String table",
									load: () =>
										readAssetSample(stringTableUrl, "ST_Game.uasset").pipe(
											Effect.flatMap(accept)
										)
								},
								{
									label: "DataTable",
									load: () =>
										readAssetSample(dataTableUrl, "DT_Scalars.uasset").pipe(
											Effect.flatMap(accept)
										)
								},
								{
									label: "Blueprint",
									load: () =>
										readAssetSample(
											blueprintUrl,
											"BP_GraphFixture.uasset"
										).pipe(Effect.flatMap(accept))
								}
							]}
						/>
					)}
					relatedViews={(read): readonly AssetRelatedView[] => {
						const views: AssetRelatedView[] = [];
						const inspection = lastInspection();
						const authoring = authoringRelatedView(inspection?.authoring);
						if (authoring.status === "available") {
							views.push({
								kind: "action",
								label: "Open in Data Tables",
								href: "/data-tables",
								description: authoring.subtitle,
								onClick: (event) => {
									if (isPlainNavigation(event))
										offerAuthoring(authoring.read, read.fileName);
								}
							});
						}
						const isBlueprint = read.inspection.assets.some((asset) =>
							asset.class_path?.endsWith("Blueprint")
						);
						const blueprint = blueprintRelatedView(inspection?.blueprint, isBlueprint);
						if (blueprint.status === "unavailable")
							views.push({ kind: "note", message: blueprint.message });
						if (blueprint.status === "available") {
							views.push({
								kind: "action",
								label: "Open in Blueprint viewer",
								href: "/blueprints",
								description: blueprint.subtitle,
								onClick: (event) => {
									if (isPlainNavigation(event))
										offerBlueprint(blueprint.read, read.fileName);
								}
							});
						}
						const isSequence = read.inspection.assets.some((asset) =>
							asset.class_path?.endsWith(".LevelSequence")
						);
						const sequence = sequenceRelatedView(inspection?.sequence, isSequence);
						if (sequence.status === "unavailable")
							views.push({ kind: "note", message: sequence.message });
						if (sequence.status === "available") {
							views.push({
								kind: "action",
								label: "Open in Sequencer viewer",
								href: "/sequencer",
								description: sequence.subtitle,
								onClick: (event) => {
									if (isPlainNavigation(event))
										offerSequence(sequence.read, read.fileName);
								}
							});
						}
						return views;
					}}
				/>
			</EffectRuntimeProvider>
		</div>
	);
}

const styles = stylex.create({
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
