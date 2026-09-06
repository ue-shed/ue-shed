import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Layer, ManagedRuntime } from "effect";
import { render } from "solid-js/web";
import { AppShell } from "./app-shell.js";
import "./reset.css";

// Routes receive clients explicitly and load them with their UI on first use.
const rendererRuntime = ManagedRuntime.make(Layer.empty);
window.addEventListener("beforeunload", () => void rendererRuntime.dispose(), { once: true });

render(
	() => (
		<EffectRuntimeProvider runtime={rendererRuntime}>
			<AppShell />
		</EffectRuntimeProvider>
	),
	document.getElementById("root")!
);
