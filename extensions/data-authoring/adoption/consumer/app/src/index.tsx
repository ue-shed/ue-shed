import * as stylex from "@stylexjs/stylex";
import { AuthoringRoute } from "@ue-shed/extension-data-authoring";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { ueShedDarkTheme } from "@ue-shed/ui-theme/themes.stylex.js";
import { Layer, ManagedRuntime } from "effect";
import { render } from "solid-js/web";
import { authoringClient } from "./in-memory-authoring-client.js";
import "./reset.css";

const runtime = ManagedRuntime.make(Layer.empty);
window.addEventListener("beforeunload", () => void runtime.dispose(), { once: true });

const styles = stylex.create({ host: { minHeight: "100vh" } });
const root = document.getElementById("root");
if (!root) throw new Error("Expected the adopted host root element.");

render(
	() => (
		<div {...stylex.props(ueShedDarkTheme, styles.host)}>
			<EffectRuntimeProvider runtime={runtime}>
				<AuthoringRoute client={authoringClient} />
			</EffectRuntimeProvider>
		</div>
	),
	root
);
