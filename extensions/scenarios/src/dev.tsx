import * as stylex from "@stylexjs/stylex";
import { EffectRuntimeProvider } from "@ue-shed/ui";
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
	shell: { minHeight: "100vh", backgroundColor: "#0a0c0c", color: "#e8ebe5" },
	nav: {
		height: 52,
		display: "flex",
		alignItems: "center",
		borderBottom: "1px solid #303632",
		backgroundColor: "#0b0d0d",
		fontFamily: '"Cascadia Mono", Consolas, monospace'
	},
	brandMark: {
		marginLeft: 20,
		padding: "4px 5px",
		backgroundColor: "#b7e26d",
		color: "#10140d",
		fontSize: 10,
		fontWeight: 800
	},
	brand: { marginLeft: 9, fontSize: 11, letterSpacing: ".14em" },
	navItem: {
		height: "100%",
		display: "flex",
		alignItems: "center",
		marginLeft: 28,
		padding: "0 18px",
		borderRight: "1px solid #252a27",
		borderBottom: "2px solid #b7e26d",
		borderLeft: "1px solid #252a27",
		color: "#dfe4dd",
		fontSize: 9,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	previewLabel: {
		marginLeft: "auto",
		marginRight: 20,
		color: "#586159",
		fontSize: 8,
		letterSpacing: ".12em"
	}
});

mountPreview();
