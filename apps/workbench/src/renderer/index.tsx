import { AuthoringClient } from "@ue-shed/authoring-sdk";
import { TextureAuditClient } from "@ue-shed/extension-asset-audits";
import { MapReviewClient } from "@ue-shed/extension-camera-review/client";
import { ContentObservatoryClient } from "@ue-shed/extension-content-observatory/client";
import { GameTextClient } from "@ue-shed/extension-game-text";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Layer, ManagedRuntime } from "effect";
import { render } from "solid-js/web";
import { AppShell } from "./app-shell.js";
import { assetAuditsClient } from "./asset-audits-client.js";
import { authoringClient } from "./authoring-client.js";
import { gameTextClient } from "./game-text-client.js";
import { mapReviewClient } from "./map-review-client.js";
import { contentObservatoryClient } from "./content-observatory-client.js";
import "./reset.css";

const WorkbenchRendererLive = Layer.mergeAll(
	Layer.succeed(AuthoringClient, authoringClient),
	Layer.succeed(TextureAuditClient, assetAuditsClient),
	Layer.succeed(GameTextClient, gameTextClient),
	Layer.succeed(MapReviewClient, mapReviewClient),
	Layer.succeed(ContentObservatoryClient, contentObservatoryClient)
);
const rendererRuntime = ManagedRuntime.make(WorkbenchRendererLive);
window.addEventListener("beforeunload", () => void rendererRuntime.dispose(), { once: true });

render(
	() => (
		<EffectRuntimeProvider runtime={rendererRuntime}>
			<AppShell />
		</EffectRuntimeProvider>
	),
	document.getElementById("root")!
);
