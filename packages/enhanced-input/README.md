# `@ue-shed/enhanced-input`

Read-only projection of Enhanced Input `InputAction` and `InputMappingContext` assets from saved
packages. Builds on `@ue-shed/unreal-assets` inspect output; missing serialized fields stay
`unavailable` rather than inventing CDO defaults.

```ts
import { EnhancedInputService, EnhancedInputServiceLive } from "@ue-shed/enhanced-input";
import { AssetReaderLive } from "@ue-shed/unreal-assets";
import { Effect, Layer } from "effect";

const report = await Effect.runPromise(
	Effect.flatMap(EnhancedInputService, (service) =>
		service.inspectPath("Content/Fixture/Input/IMC_Fixture.uasset")
	).pipe(Effect.provide(EnhancedInputServiceLive), Effect.provide(AssetReaderLive))
);
```

CLI: `ue-shed input inspect <asset-or-project>`.
