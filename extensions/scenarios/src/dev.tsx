import * as stylex from "@stylexjs/stylex";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { workbenchDarkTheme } from "@ue-shed/ui-theme/themes.stylex.js";
import { Layer, ManagedRuntime } from "effect";
import { render } from "solid-js/web";
import { ScenarioStudioRoute } from "./scenario-studio-route.js";
import "./reset.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Scenario Studio preview root is missing.");
const runtime = ManagedRuntime.make(Layer.empty);

const mountPreview = () =>
	render(
		() => (
			<EffectRuntimeProvider runtime={runtime}>
				<div {...stylex.props(workbenchDarkTheme, styles.shell)}>
					<nav aria-label="Preview host" {...stylex.props(styles.nav)}>
						<span {...stylex.props(styles.brandMark)}>UE</span>
						<strong {...stylex.props(styles.brand)}>SHED</strong>
						<span {...stylex.props(styles.navItem)}>Scenario Studio</span>
						<span {...stylex.props(styles.previewLabel)}>STANDALONE PROTOTYPE</span>
					</nav>
					<ScenarioStudioRoute showDemoGuide />
				</div>
			</EffectRuntimeProvider>
		),
		root
	);

const styles = stylex.create({
	shell: { minHeight: "100vh", backgroundColor: tokens.colorCanvas, color: tokens.colorText },
	nav: {
		height: 52,
		display: "flex",
		alignItems: "center",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorSurfaceInset,
		fontFamily: tokens.fontBody
	},
	brandMark: {
		marginLeft: 20,
		padding: "4px 5px",
		backgroundColor: tokens.colorAccent,
		color: tokens.colorAccentText,
		fontSize: 11,
		fontWeight: 590
	},
	brand: { marginLeft: 9, fontSize: 11 },
	navItem: {
		height: "100%",
		display: "flex",
		alignItems: "center",
		marginLeft: 28,
		padding: "0 18px",
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		borderBottomColor: tokens.colorAccent,
		borderBottomStyle: "solid",
		borderBottomWidth: 2,
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1,
		color: tokens.colorText,
		fontSize: 11
	},
	previewLabel: {
		marginLeft: "auto",
		marginRight: 20,
		color: tokens.colorTextFaint,
		fontSize: 11
	}
});

mountPreview();
