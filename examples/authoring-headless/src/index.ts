import {
	AuthoringFilePickerCancelled,
	ShedHostLive,
	shedHostConfigurationLayer
} from "@ue-shed/host";
import { Config, Effect, Layer, Option } from "effect";
import { application } from "./application.js";

const configurationLive = Layer.unwrap(
	Effect.gen(function* () {
		const projectRoot = yield* Config.String("UE_SHED_PROJECT_ROOT");
		const authoringAsset = yield* Config.String("UE_SHED_AUTHORING_ASSET");
		const remoteControlEndpoint = yield* Config.option(
			Config.String("UE_SHED_REMOTE_CONTROL_ENDPOINT")
		);
		return shedHostConfigurationLayer({
			authoringAsset: { path: authoringAsset, status: "configured" },
			project: { projectRoot, status: "configured" },
			remoteControlEndpoint: Option.getOrElse(
				remoteControlEndpoint,
				() => "http://127.0.0.1:30001"
			)
		});
	})
);

const ExampleHostLive = ShedHostLive.pipe(
	Layer.provide(configurationLive),
	Layer.provide(AuthoringFilePickerCancelled)
);

await Effect.runPromiseExit(application.pipe(Effect.provide(ExampleHostLive))).then((exit) => {
	if (exit._tag === "Failure") process.exitCode = 1;
});
